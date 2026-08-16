import { describe, expect, it } from 'vitest';
import { computePnl, type PnlLedgerEntry } from './pnl.js';

const NOW = '2026-08-15T12:00:00.000Z';
const DAY = 86_400_000;
const iso = (offsetDays: number): string => new Date(Date.parse(NOW) - offsetDays * DAY).toISOString();

function recovered(processor: string, amount: number, offsetDays: number, currency = 'USD'): PnlLedgerEntry {
  return { type: 'case.recovered', occurredAt: iso(offsetDays), detail: { processor, amount, currency } };
}

function reversed(processor: string, amount: number, offsetDays: number, currency = 'USD'): PnlLedgerEntry {
  return { type: 'case.reversed', occurredAt: iso(offsetDays), detail: { processor, amount, currency, kind: 'chargeback' } };
}

function reinstated(processor: string, amount: number, offsetDays: number, currency = 'USD'): PnlLedgerEntry {
  return { type: 'case.reversal_reverted', occurredAt: iso(offsetDays), detail: { processor, amount, currency, kind: 'chargeback' } };
}

describe('computePnl', () => {
  it('sums gross recovered and accrues fee at the fee rate, per processor + cumulative', () => {
    const entries: PnlLedgerEntry[] = [
      recovered('stripe', 10_000, 0.1),
      recovered('stripe', 5_000, 0.2),
      recovered('adyen', 20_000, 0.3),
      { type: 'charge.failed', occurredAt: iso(0.1), detail: { processor: 'stripe' } },
      { type: 'comms.sent', occurredAt: iso(0.1), detail: { processor: 'adyen' } },
    ];
    const r = computePnl(entries, { nowIso: NOW, feeRate: 0.12 });
    expect(r.currency).toBe('USD');
    expect(r.feeRatePct).toBe(12);
    expect(r.feeBasis).toBe('accrual-on-recovered');
    // cumulative
    expect(r.cumulative.totals.recoveredMinor).toBe(35_000);
    expect(r.cumulative.totals.feeMinor).toBe(4_200); // 12% of 35000
    expect(r.cumulative.totals.recoveries).toBe(3);
    expect(r.cumulative.totals.attempts).toBe(1);
    expect(r.cumulative.totals.comms).toBe(1);
    // per-processor, sorted by fee desc → adyen (20k) before stripe (15k)
    expect(r.processors.map((p) => p.processor)).toEqual(['adyen', 'stripe']);
    expect(r.processors[0]!.totals.recoveredMinor).toBe(20_000);
    expect(r.processors[1]!.totals.recoveredMinor).toBe(15_000);
  });

  it('computes fair period-over-period deltas over rolling windows', () => {
    const entries: PnlLedgerEntry[] = [
      recovered('stripe', 10_000, 0.5), // in last 24h (current day window)
      recovered('stripe', 4_000, 1.5), // in previous 24h (prior day window)
    ];
    const r = computePnl(entries, { nowIso: NOW, feeRate: 0.1 });
    const d = r.cumulative.day;
    expect(d.current.recoveredMinor).toBe(10_000);
    expect(d.previous.recoveredMinor).toBe(4_000);
    // fee delta: 1000 vs 400 → +150%
    expect(d.feeDeltaPct).toBeCloseTo(150, 5);
    expect(d.recoveredDeltaPct).toBeCloseTo(150, 5);
    // week window (7d) contains both → no prior-week baseline
    expect(r.cumulative.week.current.recoveredMinor).toBe(14_000);
    expect(r.cumulative.week.previous.recoveredMinor).toBe(0);
    expect(r.cumulative.week.feeDeltaPct).toBeNull(); // no baseline → null, not Infinity
  });

  it('builds a daily series ending today with the right length', () => {
    const entries = [recovered('stripe', 9_900, 0)];
    const r = computePnl(entries, { nowIso: NOW, seriesDays: 30 });
    expect(r.dailySeries).toHaveLength(30);
    expect(r.dailySeries[29]!.date).toBe('2026-08-15'); // last point is today (UTC)
    expect(r.dailySeries[29]!.recoveredMinor).toBe(9_900);
    expect(r.dailySeries[0]!.date).toBe('2026-07-17'); // 29 days earlier
  });

  it('picks the dominant recovered currency and excludes off-currency money (activity still counts)', () => {
    const entries: PnlLedgerEntry[] = [
      recovered('stripe', 10_000, 0.1, 'USD'),
      recovered('stripe', 8_000, 0.2, 'USD'),
      recovered('adyen', 5_000, 0.3, 'EUR'), // off-currency → excluded from money, counted as a recovery? no
    ];
    const r = computePnl(entries, { nowIso: NOW });
    expect(r.currency).toBe('USD'); // 2 USD vs 1 EUR
    expect(r.cumulative.totals.recoveredMinor).toBe(18_000); // EUR amount excluded
    expect(r.cumulative.totals.recoveries).toBe(2); // only USD recoveries counted toward money+count
  });

  it('labels missing processor attribution as "unknown"', () => {
    const entries: PnlLedgerEntry[] = [{ type: 'case.recovered', occurredAt: iso(0.1), detail: { amount: 1_000, currency: 'USD' } }];
    const r = computePnl(entries, { nowIso: NOW });
    expect(r.processors[0]!.processor).toBe('unknown');
  });

  it('nets reversals off recovered and claws back the fee', () => {
    const entries: PnlLedgerEntry[] = [
      recovered('stripe', 10_000, 0.1),
      recovered('adyen', 20_000, 0.2),
      reversed('stripe', 3_000, 0.05), // a chargeback on the stripe recovery
    ];
    const r = computePnl(entries, { nowIso: NOW, feeRate: 0.12 });
    const c = r.cumulative.totals;
    expect(c.grossRecoveredMinor).toBe(30_000);
    expect(c.reversedMinor).toBe(3_000);
    expect(c.recoveredMinor).toBe(27_000); // NET
    expect(c.feeMinor).toBe(Math.round(27_000 * 0.12)); // 3240 — fee on NET
    expect(c.clawbackMinor).toBe(Math.round(3_000 * 0.12)); // 360 — fee removed by the reversal
    expect(c.reversals).toBe(1);
    // per-MoR: stripe net = 7000 (10000 - 3000), adyen net = 20000 → adyen now leads by fee
    const stripe = r.processors.find((p) => p.processor === 'stripe')!;
    expect(stripe.totals.recoveredMinor).toBe(7_000);
    expect(stripe.totals.feeMinor).toBe(Math.round(7_000 * 0.12));
    expect(r.processors[0]!.processor).toBe('adyen');
  });

  it('nets reversals within the rolling window and the daily series', () => {
    const entries: PnlLedgerEntry[] = [
      recovered('stripe', 10_000, 0.1), // in last 24h
      reversed('stripe', 4_000, 0.2), // also in last 24h
    ];
    const r = computePnl(entries, { nowIso: NOW, feeRate: 0.1 });
    expect(r.cumulative.day.current.recoveredMinor).toBe(6_000); // 10000 - 4000
    expect(r.cumulative.day.current.feeMinor).toBe(600);
    expect(r.cumulative.day.current.clawbackMinor).toBe(400);
    expect(r.dailySeries[29]!.recoveredMinor).toBe(6_000); // today, net
  });

  it('re-credits a won dispute: reinstatement nets back and re-accrues the fee', () => {
    const entries: PnlLedgerEntry[] = [
      recovered('stripe', 10_000, 0.3),
      reversed('stripe', 10_000, 0.2), // full chargeback → net 0
      reinstated('stripe', 10_000, 0.1), // dispute won → funds back → net 10000 again
    ];
    const r = computePnl(entries, { nowIso: NOW, feeRate: 0.12 });
    const c = r.cumulative.totals;
    expect(c.grossRecoveredMinor).toBe(10_000);
    expect(c.reversedMinor).toBe(10_000);
    expect(c.reinstatedMinor).toBe(10_000);
    expect(c.recoveredMinor).toBe(10_000); // gross − reversed + reinstated
    expect(c.feeMinor).toBe(1_200); // fee fully re-accrued
    expect(c.clawbackMinor).toBe(0); // net clawback back to zero
    expect(c.reinstatements).toBe(1);
  });

  it('handles an empty ledger without throwing', () => {
    const r = computePnl([], { nowIso: NOW });
    expect(r.cumulative.totals.recoveredMinor).toBe(0);
    expect(r.processors).toEqual([]);
    expect(r.dailySeries).toHaveLength(30);
    expect(r.currency).toBe('USD');
  });
});
