import { describe, expect, it } from 'vitest';
import { buildDemoLedgerEvents } from './demo-seed.js';
import { computePnl } from './pnl.js';

const NOW = '2026-08-15T12:00:00.000Z';

describe('buildDemoLedgerEvents', () => {
  it('is deterministic for a given seed', () => {
    const a = buildDemoLedgerEvents({ nowIso: NOW, seed: 7 });
    const b = buildDemoLedgerEvents({ nowIso: NOW, seed: 7 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('marks every event demo:true and stamps a processor', () => {
    const events = buildDemoLedgerEvents({ nowIso: NOW });
    expect(events.every((e) => e.detail.demo === true)).toBe(true);
    expect(events.every((e) => typeof e.detail.processor === 'string')).toBe(true);
    const procs = new Set(events.map((e) => e.detail.processor));
    expect(procs.has('stripe')).toBe(true);
    expect(procs.has('adyen')).toBe(true);
  });

  it('never places an event in the future and spans the window', () => {
    const events = buildDemoLedgerEvents({ nowIso: NOW, days: 45 });
    const times = events.map((e) => Date.parse(e.occurredAt));
    expect(Math.max(...times)).toBeLessThanOrEqual(Date.parse(NOW));
    // spans roughly the window (oldest event is well before now)
    expect(Date.parse(NOW) - Math.min(...times)).toBeGreaterThan(30 * 86_400_000);
    // returned in chronological order
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
  });

  it('feeds computePnl into a populated, positive report (per-MoR + cumulative)', () => {
    const events = buildDemoLedgerEvents({ nowIso: NOW });
    const r = computePnl(events, { nowIso: NOW, feeRate: 0.12 });
    expect(r.cumulative.totals.recoveredMinor).toBeGreaterThan(0);
    expect(r.cumulative.totals.feeMinor).toBe(Math.round(r.cumulative.totals.recoveredMinor * 0.12));
    expect(r.processors.length).toBeGreaterThanOrEqual(4);
    // stripe has the highest weight → should lead the per-MoR ranking
    expect(r.processors[0]!.processor).toBe('stripe');
    // the upward trend produces a non-empty trailing month
    expect(r.cumulative.month.current.recoveredMinor).toBeGreaterThan(0);
  });
});
