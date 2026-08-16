/**
 * P&L / revenue analytics — pure aggregation over the ledger.
 *
 * Rolls the tamper-evident ledger up into a per-processor (MoR) and cumulative revenue view,
 * over rolling day / week / month / year windows, each with a period-over-period delta. Pure and
 * deterministic (time is injected via `nowIso`), so it unit-tests without a DB or clock.
 *
 * MONEY SEMANTICS (honest):
 *  - `recoveredMinor` = SUM of `case.recovered` amounts (minor units) — GROSS dollars recovered.
 *  - `feeMinor` = round(recoveredMinor × feeRate) — an ACCRUAL estimate of AX10M's cut. The
 *    ACTUAL billed fee is `feeRate` × statistically-PROVEN uplift (mSPRT lower bound in
 *    @ax10m/attribution), which is ≤ this. So headline fee here is an upper-bound accrual, not
 *    the invoice. Surfaced clearly in the UI.
 *  - Single reporting currency: `recoveredMinor` sums only `case.recovered` entries whose
 *    currency matches the report currency (mixed-currency needs FX normalization — not done).
 */

const DAY_MS = 86_400_000;

/** The subset of a ledger entry this aggregation reads (LedgerEntry is structurally assignable). */
export interface PnlLedgerEntry {
  type: string;
  occurredAt: string;
  detail: Record<string, unknown>;
}

export interface PnlTotals {
  recoveredMinor: number; // gross recovered (report currency)
  feeMinor: number; // accrued fee = round(recovered × feeRate)
  recoveries: number; // count of case.recovered
  attempts: number; // charge.succeeded + charge.failed
  comms: number; // comms.sent
}

export interface PeriodDelta {
  current: PnlTotals; // the trailing window (e.g. last 7d)
  previous: PnlTotals; // the window immediately before it (prior 7d)
  /** % change in accrued fee; null when previous is 0 (no baseline → "new"). */
  feeDeltaPct: number | null;
  /** % change in gross recovered; null when previous is 0. */
  recoveredDeltaPct: number | null;
}

export interface ProcessorPnl {
  processor: string; // 'stripe' | 'adyen' | … | 'all' for the cumulative row
  totals: PnlTotals; // all-time
  day: PeriodDelta; // last 24h vs previous 24h
  week: PeriodDelta; // last 7d vs previous 7d
  month: PeriodDelta; // last 30d vs previous 30d
  year: PeriodDelta; // last 365d vs previous 365d
}

export interface PnlSeriesPoint {
  date: string; // YYYY-MM-DD (UTC)
  recoveredMinor: number;
  feeMinor: number;
}

export interface PnlReport {
  generatedAt: string;
  currency: string;
  feeRatePct: number; // e.g. 12
  /** Accrued fee is 12% of recovered; ACTUAL billing is 12% of proven uplift (≤ accrual). */
  feeBasis: 'accrual-on-recovered';
  cumulative: ProcessorPnl; // processor === 'all'
  processors: ProcessorPnl[]; // per-MoR, sorted by all-time accrued fee desc
  dailySeries: PnlSeriesPoint[]; // cumulative, last 30 UTC days (for the chart)
}

export interface PnlOptions {
  nowIso: string;
  feeRate?: number; // default 0.12
  currency?: string; // default: dominant recovered currency, else 'USD'
  seriesDays?: number; // default 30
}

function emptyTotals(): PnlTotals {
  return { recoveredMinor: 0, feeMinor: 0, recoveries: 0, attempts: 0, comms: 0 };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Apply feeRate to recovered, in place, for a totals bucket. */
function withFee(t: PnlTotals, feeRate: number): PnlTotals {
  return { ...t, feeMinor: Math.round(t.recoveredMinor * feeRate) };
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function accumulate(target: PnlTotals, e: PnlLedgerEntry, reportCurrency: string): void {
  switch (e.type) {
    case 'case.recovered':
      if ((str(e.detail.currency) ?? reportCurrency) === reportCurrency) {
        target.recoveredMinor += num(e.detail.amount);
        target.recoveries += 1;
      }
      break;
    case 'charge.succeeded':
    case 'charge.failed':
      target.attempts += 1;
      break;
    case 'comms.sent':
      target.comms += 1;
      break;
    default:
      break;
  }
}

/** Build a day/week/month/year PeriodDelta for one processor's entries. */
function periodDeltas(entries: readonly PnlLedgerEntry[], nowMs: number, feeRate: number, reportCurrency: string): Omit<ProcessorPnl, 'processor' | 'totals'> {
  const windows: Array<[keyof Omit<ProcessorPnl, 'processor' | 'totals'>, number]> = [
    ['day', 1],
    ['week', 7],
    ['month', 30],
    ['year', 365],
  ];
  const out = {} as Omit<ProcessorPnl, 'processor' | 'totals'>;
  for (const [key, days] of windows) {
    const span = days * DAY_MS;
    const curStart = nowMs - span;
    const prevStart = nowMs - 2 * span;
    const current = emptyTotals();
    const previous = emptyTotals();
    for (const e of entries) {
      const t = Date.parse(e.occurredAt);
      if (Number.isNaN(t)) continue;
      if (t >= curStart && t <= nowMs) accumulate(current, e, reportCurrency);
      else if (t >= prevStart && t < curStart) accumulate(previous, e, reportCurrency);
    }
    const cur = withFee(current, feeRate);
    const prev = withFee(previous, feeRate);
    out[key] = { current: cur, previous: prev, feeDeltaPct: pctChange(cur.feeMinor, prev.feeMinor), recoveredDeltaPct: pctChange(cur.recoveredMinor, prev.recoveredMinor) };
  }
  return out;
}

function processorPnl(processor: string, entries: readonly PnlLedgerEntry[], nowMs: number, feeRate: number, reportCurrency: string): ProcessorPnl {
  const totals = emptyTotals();
  for (const e of entries) accumulate(totals, e, reportCurrency);
  return { processor, totals: withFee(totals, feeRate), ...periodDeltas(entries, nowMs, feeRate, reportCurrency) };
}

/** Compute the full P&L report from raw ledger entries. Deterministic given `nowIso`. */
export function computePnl(entries: readonly PnlLedgerEntry[], opts: PnlOptions): PnlReport {
  const feeRate = opts.feeRate ?? 0.12;
  const nowMs = Date.parse(opts.nowIso);
  const seriesDays = opts.seriesDays ?? 30;

  // Reporting currency: caller override, else the most common recovered currency, else USD.
  const currencyCounts = new Map<string, number>();
  for (const e of entries) {
    if (e.type === 'case.recovered') {
      const c = str(e.detail.currency) ?? 'USD';
      currencyCounts.set(c, (currencyCounts.get(c) ?? 0) + 1);
    }
  }
  const dominant = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const reportCurrency = opts.currency ?? dominant ?? 'USD';

  // Partition by processor (missing attribution → 'unknown').
  const byProcessor = new Map<string, PnlLedgerEntry[]>();
  for (const e of entries) {
    const p = str(e.detail.processor) ?? 'unknown';
    (byProcessor.get(p) ?? byProcessor.set(p, []).get(p)!).push(e);
  }

  const processors = [...byProcessor.entries()]
    .map(([p, es]) => processorPnl(p, es, nowMs, feeRate, reportCurrency))
    .sort((a, b) => b.totals.feeMinor - a.totals.feeMinor);

  const cumulative = processorPnl('all', entries, nowMs, feeRate, reportCurrency);

  // Daily series (cumulative, last `seriesDays` UTC days) for the chart.
  const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const perDay = new Map<string, PnlTotals>();
  for (const e of entries) {
    if (e.type !== 'case.recovered') continue;
    const t = Date.parse(e.occurredAt);
    if (Number.isNaN(t)) continue;
    const key = dayKey(t);
    const bucket = perDay.get(key) ?? perDay.set(key, emptyTotals()).get(key)!;
    accumulate(bucket, e, reportCurrency);
  }
  const dailySeries: PnlSeriesPoint[] = [];
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  for (let i = seriesDays - 1; i >= 0; i--) {
    const key = dayKey(todayStart - i * DAY_MS);
    const t = perDay.get(key) ?? emptyTotals();
    dailySeries.push({ date: key, recoveredMinor: t.recoveredMinor, feeMinor: Math.round(t.recoveredMinor * feeRate) });
  }

  return {
    generatedAt: opts.nowIso,
    currency: reportCurrency,
    feeRatePct: Math.round(feeRate * 100),
    feeBasis: 'accrual-on-recovered',
    cumulative,
    processors,
    dailySeries,
  };
}
