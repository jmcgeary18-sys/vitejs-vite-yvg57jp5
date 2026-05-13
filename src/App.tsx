import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_SEC = 60;

const STATUS = {
  NEW: { label: 'NEW', bg: '#e8f5dc', color: '#244f09', border: '#3f7115' },
  EXIT: { label: 'EXIT', bg: '#fdecec', color: '#7d1f1f', border: '#a93131' },
  ADD: { label: 'ADD', bg: '#ddf3ec', color: '#075243', border: '#0f7058' },
  TRIM: { label: 'TRIM', bg: '#faece7', color: '#4f1d0d', border: '#9c3f20' },
  FLAT: { label: 'FLAT', bg: '#f1efe8', color: '#444441', border: '#888780' },
};

function fmtVal(k: number) {
  if (k >= 1e6) return `$${(k / 1e6).toFixed(2)}B`;
  if (k >= 1e3) return `$${(k / 1e3).toFixed(1)}M`;
  return `$${k}K`;
}

function fmtShares(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Number(n || 0).toLocaleString();
}

function fmtPct(p: number | null | undefined) {
  if (p === null || p === undefined) return '-';
  if (p <= -99.9) return '-100%';
  return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

function fmtDate(s?: string) {
  if (!s) return '-';
  return new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function fmtDateTime(s?: string) {
  if (!s) return '-';
  const normalised = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  return new Date(normalised).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

type HoldingRow = {
  name: string;
  title: string;
  cusip: string;
  value: number;
  shares: number;
  prevShares: number;
  pct: number | null;
  status: keyof typeof STATUS;
  putCall?: string;
};

type FundResult = {
  fund: {
    label: string;
    manager: string;
    cik: string;
  };
  error?: string;
  filing?: {
    form: string;
    reportDate: string;
    filingDate: string;
    acceptanceDateTime: string;
    accessionNumber: string;
  };
  rows?: HoldingRow[];
  totalValue?: number;
  positions?: number;
};

async function fetchDashboard(signal: AbortSignal) {
  const response = await fetch('https://one3f-backend.onrender.com/api/dashboard', { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body as { checkedAt: string; funds: FundResult[] };
}

function Badge({ status }: { status: keyof typeof STATUS }) {
  const cfg = STATUS[status] || STATUS.FLAT;
  return (
    <span
      className="badge"
      style={{
        borderColor: cfg.border,
        background: cfg.bg,
        color: cfg.color,
      }}
    >
      {cfg.label}
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

function FundCard({ fundResult }: { fundResult: FundResult }) {
  const { fund, error } = fundResult;
  const rows = fundResult.rows || [];

  return (
    <section className="fund-card">
      <header className="fund-header">
        <div>
          <h2>{fund.label}</h2>
          <div className="mono muted">
            {fund.manager} · CIK {fund.cik}
          </div>
        </div>
        <div className="form-pill">{fundResult.filing?.form || '13F-HR'}</div>
      </header>

      {error ? (
        <div className="error">{error}</div>
      ) : (
        <>
          <div className="stats">
            <Stat
              label="Latest report"
              value={fmtDate(fundResult.filing?.reportDate)}
              sub={`Filed ${fmtDate(fundResult.filing?.filingDate)}`}
            />
            <Stat
              label="Accepted"
              value={fmtDateTime(fundResult.filing?.acceptanceDateTime)}
              sub={fundResult.filing?.accessionNumber}
            />
            <Stat
              label="Portfolio"
              value={fmtVal(fundResult.totalValue || 0)}
              sub={`${fundResult.positions || 0} positions`}
            />
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Issuer</th>
                  <th>Class</th>
                  <th>CUSIP</th>
                  <th>Value</th>
                  <th>Shares</th>
                  <th>Prev</th>
                  <th>Chg</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.cusip}-${row.putCall || 'common'}-${index}`}>
                    <td className="issuer">
                      {row.name}
                      {row.putCall ? <span className="option-tag">{row.putCall}</span> : null}
                    </td>
                    <td>{row.title || '-'}</td>
                    <td>{row.cusip}</td>
                    <td>{row.value ? fmtVal(row.value) : '-'}</td>
                    <td>{row.shares ? fmtShares(row.shares) : '-'}</td>
                    <td>{row.prevShares ? fmtShares(row.prevShares) : '-'}</td>
                    <td>{fmtPct(row.pct)}</td>
                    <td>
                      <Badge status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export default function App() {
  const [state, setState] = useState<{
    funds: FundResult[];
    loading: boolean;
    error: string | null;
    lastChecked: string | null;
  }>({
    funds: [],
    loading: true,
    error: null,
    lastChecked: null,
  });

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const dashboard = await fetchDashboard(controller.signal);
      setState({
        funds: dashboard.funds,
        loading: false,
        error: null,
        lastChecked: dashboard.checkedAt,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        lastChecked: new Date().toISOString(),
      }));
    }
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_SEC * 1000);
    return () => {
      clearInterval(poll);
      abortRef.current?.abort();
    };
  }, [load]);

  return (
    <main>
      <div className="topbar">
        <div>
          <h1>13F Live Tracker</h1>
          <p>Backend-polled SEC filing feed with quarter-over-quarter position changes.</p>
        </div>
        <div className="status">
          <span className={state.loading ? 'dot pulse' : 'dot'} />
          <span>{state.loading ? 'Checking SEC' : 'Monitoring'}</span>
          {state.lastChecked ? <small>{fmtDateTime(state.lastChecked)}</small> : null}
        </div>
      </div>

      {state.error ? <div className="error global">{state.error}</div> : null}

      <div className="tracker-grid">
        {state.funds.length ? (
          state.funds.map((fundResult) => (
            <FundCard key={fundResult.fund.cik} fundResult={fundResult} />
          ))
        ) : (
          <div className="empty">{state.loading ? 'Loading filings...' : 'No fund data loaded.'}</div>
        )}
      </div>
    </main>
  );
}
