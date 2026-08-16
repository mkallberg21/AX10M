'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * Live P&L dashboard. Polls GET /analytics/pnl and renders AX10M revenue (accrued fee) per MoR
 * and cumulative, over rolling day/week/month/year windows with period-over-period deltas, plus
 * a 30-day daily series. Reflects the REAL ledger — it lights up as recoveries land, and shows an
 * honest empty state until then. Headline fee is a 12%-of-recovered ACCRUAL, not the billed fee
 * (which is 12% of statistically-proven uplift, ≤ this) — stated on the page.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
const POLL_MS = 20_000;

type Totals = { recoveredMinor: number; grossRecoveredMinor: number; reversedMinor: number; feeMinor: number; clawbackMinor: number; recoveries: number; reversals: number; attempts: number; comms: number };
type PeriodDelta = { current: Totals; previous: Totals; feeDeltaPct: number | null; recoveredDeltaPct: number | null };
type ProcessorPnl = { processor: string; totals: Totals; day: PeriodDelta; week: PeriodDelta; month: PeriodDelta; year: PeriodDelta };
type SeriesPoint = { date: string; recoveredMinor: number; feeMinor: number };
type PnlReport = {
  generatedAt: string;
  currency: string;
  feeRatePct: number;
  feeBasis: string;
  cumulative: ProcessorPnl;
  processors: ProcessorPnl[];
  dailySeries: SeriesPoint[];
};

type Period = 'day' | 'week' | 'month' | 'year';
const PERIODS: { key: Period; label: string; delta: string }[] = [
  { key: 'day', label: 'Today', delta: 'DoD' },
  { key: 'week', label: 'This week', delta: 'WoW' },
  { key: 'month', label: 'This month', delta: 'MoM' },
  { key: 'year', label: 'This year', delta: 'YoY' },
];

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
}

function Delta({ pct, current }: { pct: number | null; current: number }): JSX.Element {
  if (pct === null) {
    return <span className="delta muted">{current > 0 ? 'new' : '—'}</span>;
  }
  const up = pct >= 0;
  return (
    <span className={`delta ${up ? 'up' : 'down'}`}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

function Sparkbars({ series, currency }: { series: SeriesPoint[]; currency: string }): JSX.Element {
  const max = Math.max(1, ...series.map((p) => p.feeMinor));
  const W = 720;
  const H = 120;
  const gap = 2;
  const bw = (W - gap * (series.length - 1)) / series.length;
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Daily accrued fee, last 30 days">
      {series.map((p, i) => {
        const h = (p.feeMinor / max) * (H - 4);
        return (
          <rect key={p.date} x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={1} className="spark-bar">
            <title>{`${p.date}: ${money(p.feeMinor, currency)} fee · ${money(p.recoveredMinor, currency)} recovered`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export default function PnlPage(): JSX.Element {
  const [data, setData] = useState<PnlReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [focus, setFocus] = useState<Period>('month');
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState<string | null>(null);

  const seedDemo = async (): Promise<void> => {
    setSeeding(true);
    setSeedMsg(null);
    try {
      const res = await fetch(`${API_BASE}/analytics/seed-demo`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { seeded?: number; message?: string };
      if (!res.ok) {
        setSeedMsg(body.message ?? `Seeding failed (${res.status})`);
        return;
      }
      const refreshed = await fetch(`${API_BASE}/analytics/pnl`, { cache: 'no-store' });
      if (refreshed.ok) {
        setData((await refreshed.json()) as PnlReport);
        setError(null);
      }
      setSeedMsg(`Seeded ${body.seeded ?? 0} synthetic demo events.`);
    } catch (err) {
      setSeedMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSeeding(false);
    }
  };

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`${API_BASE}/analytics/pnl`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const json = (await res.json()) as PnlReport;
        if (alive) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const currency = data?.currency ?? 'USD';
  const hasData = useMemo(() => !!data && data.cumulative.totals.recoveries > 0, [data]);

  return (
    <main className="container">
      <div className="pnl-head">
        <div>
          <h1 className="pnl-title">Revenue P&amp;L</h1>
          <p className="subtitle">
            AX10M fee revenue by merchant-of-record and cumulative · live from the ledger
            {data ? ` · updated ${new Date(data.generatedAt).toLocaleTimeString()}` : ''}
          </p>
        </div>
        <span className={`live ${error ? 'stale' : ''}`}>{error ? 'reconnecting…' : 'live'}</span>
      </div>

      {loading && !data && <p className="subtitle">Loading…</p>}
      {error && !data && (
        <div className="empty">
          <strong>Can&apos;t reach the API</strong> at <code>{API_BASE}</code> ({error}). Set
          <code>NEXT_PUBLIC_API_BASE_URL</code> and ensure the API is running.
        </div>
      )}

      {data && !hasData && (
        <div className="empty">
          <strong>No recoveries recorded yet.</strong> This dashboard reflects the real ledger, so
          it will populate as the recovery worker lands recovered payments. Everything below is
          wired and ready.
          <div className="seed-row">
            <button className="activate" onClick={seedDemo} disabled={seeding} type="button">
              {seeding ? 'Seeding…' : 'Seed demo data'}
            </button>
            <span className="subtitle">
              Appends deterministic synthetic recoveries (marked <code>demo</code>) so you can see it
              populated. Requires <code>AX10M_ALLOW_DEMO_SEED=true</code> on the API.
            </span>
          </div>
          {seedMsg && <p className="subtitle" style={{ marginTop: 10 }}>{seedMsg}</p>}
        </div>
      )}

      {data && (
        <>
          {/* Cumulative headline: accrued fee for each window with its period-over-period delta. */}
          <section className="kpis pnl-kpis">
            {PERIODS.map((p) => {
              const d = data.cumulative[p.key];
              return (
                <button key={p.key} className={`kpi as-btn ${focus === p.key ? 'focused' : ''}`} onClick={() => setFocus(p.key)} type="button">
                  <span className="label">
                    {p.label} <span className="tag">{p.delta}</span>
                  </span>
                  <span className="value accent">{money(d.current.feeMinor, currency)}</span>
                  <span className="hint">
                    <Delta pct={d.feeDeltaPct} current={d.current.feeMinor} /> · {money(d.current.recoveredMinor, currency)} recovered
                  </span>
                </button>
              );
            })}
          </section>

          <div className="method-strip">
            All-time fee <strong>{money(data.cumulative.totals.feeMinor, currency)}</strong> · net recovered{' '}
            <strong>{money(data.cumulative.totals.recoveredMinor, currency)}</strong> · gross{' '}
            {money(data.cumulative.totals.grossRecoveredMinor, currency)}
            {data.cumulative.totals.reversedMinor > 0 && (
              <>
                {' '}· reversed <strong className="reversed">−{money(data.cumulative.totals.reversedMinor, currency)}</strong> ({data.cumulative.totals.reversals.toLocaleString()}) · clawback{' '}
                <strong className="reversed">−{money(data.cumulative.totals.clawbackMinor, currency)}</strong>
              </>
            )}{' '}
            · {data.cumulative.totals.recoveries.toLocaleString()} recoveries · fee = {data.feeRatePct}% of net{' '}
            <span className="tag" title="Fee accrues on NET recovered (gross − refunds/chargebacks), so a reversal claws back the fee. Actual billing is 12% of holdout-verified uplift, ≤ this accrual.">accrual</span>
          </div>

          <section className="panel">
            <div className="panel-title">Daily accrued fee · last 30 days ({currency})</div>
            <Sparkbars series={data.dailySeries} currency={currency} />
          </section>

          {/* Per-MoR breakdown, deltas for the focused window. */}
          <section className="panel">
            <div className="panel-title">
              By merchant-of-record · <span className="tag">{PERIODS.find((p) => p.key === focus)!.label}</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>MoR</th>
                    <th className="num">Fee ({PERIODS.find((p) => p.key === focus)!.delta})</th>
                    <th className="num">Δ</th>
                    <th className="num">Recovered</th>
                    <th className="num">Fee · all-time</th>
                    <th className="num">Recovered · all-time</th>
                    <th className="num">Recoveries</th>
                  </tr>
                </thead>
                <tbody>
                  {data.processors.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        No per-MoR activity yet.
                      </td>
                    </tr>
                  )}
                  {data.processors.map((p) => {
                    const d = p[focus];
                    return (
                      <tr key={p.processor}>
                        <td>
                          <span className="mor">{p.processor}</span>
                        </td>
                        <td className="num accent">{money(d.current.feeMinor, currency)}</td>
                        <td className="num">
                          <Delta pct={d.feeDeltaPct} current={d.current.feeMinor} />
                        </td>
                        <td className="num">{money(d.current.recoveredMinor, currency)}</td>
                        <td className="num">{money(p.totals.feeMinor, currency)}</td>
                        <td className="num">{money(p.totals.recoveredMinor, currency)}</td>
                        <td className="num">{p.totals.recoveries.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
