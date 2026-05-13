import { createServer } from "node:http";
import { URL } from "node:url";

const PORT = process.env.PORT || 8787;
const SEC_USER_AGENT =
  process.env.SEC_USER_AGENT ||
  "13F Live Tracker jackmcgeary18@gmail.com";

const FUNDS = [
  {
    name: "Situational Awareness LP",
    label: "Situational Awareness",
    manager: "L. Aschenbrenner",
    cik: "0002045724",
  },
  {
    name: "Duquesne Family Office LLC",
    label: "Druckenmiller / Duquesne",
    manager: "S. Druckenmiller",
    cik: "0001536411",
  },
];

const cache = new Map();
const CACHE_MS = Number(process.env.CACHE_MS || 45000);
const REQUEST_GAP_MS = Number(process.env.SEC_REQUEST_GAP_MS || 150);
let lastSecRequest = 0;

function padCIK(cik) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function secFetch(url, options = {}) {
  const elapsed = Date.now() - lastSecRequest;
  if (elapsed < REQUEST_GAP_MS) await sleep(REQUEST_GAP_MS - elapsed);
  lastSecRequest = Date.now();

  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": SEC_USER_AGENT,
      Accept: options.accept || "application/json, text/plain, */*",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`SEC request failed ${response.status}: ${body.slice(0, 160)}`);
  }

  return response;
}

async function fetchJson(url) {
  const response = await secFetch(url);
  return response.json();
}

async function withCache(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.createdAt < CACHE_MS) return hit.value;
  const value = await loader();
  cache.set(key, { createdAt: Date.now(), value });
  return value;
}

async function getRecent13Fs(cik, count = 2) {
  const submissions = await fetchJson(
    `https://data.sec.gov/submissions/CIK${padCIK(cik)}.json`,
  );
  const recent = submissions.filings?.recent;
  if (!recent) return [];

  const filings = [];
  for (let i = 0; i < recent.form.length && filings.length < count; i += 1) {
    if (recent.form[i] === "13F-HR" || recent.form[i] === "13F-HR/A") {
      filings.push({
        accessionNumber: recent.accessionNumber[i],
        filingDate: recent.filingDate[i],
        reportDate: recent.reportDate[i],
        acceptanceDateTime: recent.acceptanceDateTime?.[i] ?? null,
        form: recent.form[i],
        primaryDocument: recent.primaryDocument?.[i] ?? null,
      });
    }
  }
  return filings;
}

async function findInfoTableURL(cik, accessionNumber) {
  const cikInt = parseInt(cik, 10);
  const accession = accessionNumber.replace(/-/g, "");
  const base = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accession}`;
  const index = await fetchJson(`${base}/index.json`);
  const items = index.directory?.item || [];

  const xmlFile =
    items.find((item) => {
      const name = item.name.toLowerCase();
      return (
        name.endsWith(".xml") &&
        (name.includes("info") ||
          name.includes("13f") ||
          name.includes("table") ||
          name.includes("holding"))
      );
    }) || items.find((item) => item.name.toLowerCase().endsWith(".xml"));

  if (!xmlFile) throw new Error("No XML information table found");
  return `${base}/${xmlFile.name}`;
}

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function textBetween(xml, tag) {
  const match = xml.match(new RegExp(`<[^:>/]*:?${tag}[^>]*>([\\s\\S]*?)</[^:>]*:?${tag}>`, "i"));
  return decodeXml(match?.[1]?.trim() || "");
}

function parseInfoTable(xml) {
  const rows = [];
  const tableRegex = /<[^:>/]*:?infoTable\b[^>]*>([\s\S]*?)<\/[^:>]*:?infoTable>/gi;
  let match;

  while ((match = tableRegex.exec(xml))) {
    const row = match[1];
    rows.push({
      name: textBetween(row, "nameOfIssuer"),
      title: textBetween(row, "titleOfClass"),
      cusip: textBetween(row, "cusip"),
      value: Number.parseInt(textBetween(row, "value"), 10) || 0,
      shares: Number.parseInt(textBetween(row, "sshPrnamt"), 10) || 0,
      shareType: textBetween(row, "sshPrnamtType"),
      putCall: textBetween(row, "putCall"),
      discretion: textBetween(row, "investmentDiscretion"),
    });
  }

  return rows;
}

async function parseHoldings(url) {
  const response = await secFetch(url, { accept: "application/xml, text/xml, text/plain" });
  const xml = await response.text();
  return parseInfoTable(xml);
}

function computeDiff(current, previous) {
  const previousByKey = new Map(previous.map((holding) => [holding.cusip + "|" + holding.putCall, holding]));
  const currentByKey = new Map(current.map((holding) => [holding.cusip + "|" + holding.putCall, holding]));
  const rows = [];

  for (const [key, holding] of currentByKey) {
    const prior = previousByKey.get(key);
    if (!prior) {
      rows.push({ ...holding, status: "NEW", prevShares: 0, prevValue: 0, pct: null });
      continue;
    }

    const pct = prior.shares > 0 ? ((holding.shares - prior.shares) / prior.shares) * 100 : 0;
    rows.push({
      ...holding,
      status: Math.abs(pct) < 0.5 ? "FLAT" : pct > 0 ? "ADD" : "TRIM",
      prevShares: prior.shares,
      prevValue: prior.value,
      pct,
    });
  }

  for (const [key, prior] of previousByKey) {
    if (!currentByKey.has(key)) {
      rows.push({
        ...prior,
        shares: 0,
        value: 0,
        status: "EXIT",
        prevShares: prior.shares,
        prevValue: prior.value,
        pct: -100,
      });
    }
  }

  const order = { NEW: 0, EXIT: 1, ADD: 2, TRIM: 3, FLAT: 4 };
  return rows.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      Math.abs(b.pct ?? 999) - Math.abs(a.pct ?? 999) ||
      b.value - a.value,
  );
}

async function loadFund(fund) {
  return withCache(`fund:${fund.cik}`, async () => {
    const filings = await getRecent13Fs(fund.cik, 2);
    if (!filings.length) throw new Error("No 13F filings found");

    const currentUrl = await findInfoTableURL(fund.cik, filings[0].accessionNumber);
    const currentHoldings = await parseHoldings(currentUrl);

    let rows = currentHoldings.map((holding) => ({
      ...holding,
      status: "FLAT",
      prevShares: holding.shares,
      prevValue: holding.value,
      pct: 0,
    }));

    if (filings.length >= 2) {
      const previousUrl = await findInfoTableURL(fund.cik, filings[1].accessionNumber);
      const previousHoldings = await parseHoldings(previousUrl);
      rows = computeDiff(currentHoldings, previousHoldings);
    }

    return {
      fund,
      filing: filings[0],
      previousFiling: filings[1] || null,
      rows,
      totalValue: currentHoldings.reduce((sum, holding) => sum + holding.value, 0),
      positions: currentHoldings.length,
      sourceUrl: currentUrl,
      checkedAt: new Date().toISOString(),
    };
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(JSON.stringify(payload));
}

async function dashboardPayload() {
  const results = await Promise.allSettled(FUNDS.map((fund) => loadFund(fund)));
  return {
    checkedAt: new Date().toISOString(),
    funds: results.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : { fund: FUNDS[index], error: result.reason?.message || "Unknown error" },
    ),
  };
}

async function handleRequest(request, response) {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/api/funds") {
      sendJson(response, 200, { funds: FUNDS });
      return;
    }

    if (url.pathname === "/api/dashboard") {
      sendJson(response, 200, await dashboardPayload());
      return;
    }

    const fundMatch = url.pathname.match(/^\/api\/funds\/([^/]+)$/);
    if (fundMatch) {
      const fund = FUNDS.find((item) => padCIK(item.cik) === padCIK(fundMatch[1]));
      if (!fund) {
        sendJson(response, 404, { error: "Fund is not configured" });
        return;
      }
      sendJson(response, 200, await loadFund(fund));
      return;
    }

    sendJson(response, 404, { error: "Route not found" });
  } catch (error) {
    sendJson(response, 502, { error: error.message });
  }
}

createServer(handleRequest).listen(PORT, () => {
  console.log(`13F backend listening on http://localhost:${PORT}`);
});
