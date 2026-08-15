import { describe, expect, it } from 'vitest';
import { generateStream } from './world/world.js';
import { EnginePolicy } from './policy/engine-policy.js';
import { StripeSmartRetriesBaseline } from './baselines/smart-retries.js';
import { runComparison } from './estimate.js';
import { aaTest, baselineReachSweep, fineSensitivity, netValueComparison } from './checks.js';
import { runPolicy } from './sim/simulate.js';
import { computeByCode } from './report.js';
import { netValue } from './economics.js';
import type { InvoiceOutcome } from './sim/simulate.js';
import type { SimInvoice } from './world/world.js';
import { DeclineCode } from '@ax10m/canonical';
import { deriveSeed } from './rng.js';

describe('world model', () => {
  it('generates a deterministic stream with plausible structure', () => {
    const a = generateStream(2000, 42);
    const b = generateStream(2000, 42);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(1000);
    // Some invoices are recoverable, some are not — not degenerate.
    const recoverable = a.filter((i) => i.latent.recoverable).length;
    expect(recoverable).toBeGreaterThan(0);
    expect(recoverable).toBeLessThan(a.length);
  });
});

describe('policies', () => {
  it('the baseline retries on its documented schedule; the engine plans decline-specific actions', () => {
    const inv = generateStream(50, 1).find((i) => i.declineCode === 'insufficient_funds')!;
    const { latent: _l, ...obs } = inv;
    expect(new StripeSmartRetriesBaseline().plan(obs).map((a) => a.day)).toEqual([1, 4, 10, 18]);
    const engineActions = new EnginePolicy().plan(obs);
    expect(engineActions.length).toBeGreaterThan(0);
    expect(engineActions.every((a) => a.kind === 'retry' || a.kind === 'card_update')).toBe(true);
  });
});

describe('A/A test (§1.3) — the estimator must not manufacture lift', () => {
  it('returns NO significant lift when the engine is run against itself', () => {
    const aa = aaTest(15_000, 7);
    // The load-bearing assertion of the whole backtest: identical policies → null result.
    expect(aa.lowerPer).toBe(0);
    expect(aa.billable).toBe(false);
    expect(aa.passed).toBe(true);
    // Point difference should be tiny (not exactly 0 due to independent success draws).
    expect(Math.abs(aa.rateDiff)).toBeLessThan(0.03);
  });
});

describe('net value (cost + compliance objective)', () => {
  const mkOutcome = (code: DeclineCode, recoveredMinor: number, retriesMade: number): InvoiceOutcome => ({
    invoice: { id: 'x', customerId: 'c', declineCode: code, amountMinor: 10000, issuerRegion: 'US', latent: { recoverable: true, onsetDay: 1, closeDay: 10 } } as SimInvoice,
    recovered: recoveredMinor > 0,
    recoveredMinor,
    recoveryDay: recoveredMinor > 0 ? 1 : null,
    retriesMade,
  });

  it('prices attempt cost and fines a do-not-retry (hard) retry but not a soft one', () => {
    const cost = { perAttemptMinor: 20, finePerViolationMinor: 100, excessiveRetryThreshold: 6, finePerExcessAttemptMinor: 200 };
    // A soft decline recovered in 3 attempts: cost 3×20, NO fine.
    const soft = netValue([mkOutcome(DeclineCode.InsufficientFunds, 10000, 3)], cost);
    expect(soft.costMinor).toBe(60);
    expect(soft.fineMinor).toBe(0);
    expect(soft.netMinor).toBe(10000 - 60);
    // A hard decline retried 3× (unrecovered): cost 3×20 + fine 3×100.
    const hard = netValue([mkOutcome(DeclineCode.LostCard, 0, 3)], cost);
    expect(hard.fineMinor).toBe(300);
    expect(hard.netMinor).toBe(0 - 60 - 300);
  });

  it('applies the excessive-retry fine only beyond the threshold', () => {
    const cost = { perAttemptMinor: 0, finePerViolationMinor: 0, excessiveRetryThreshold: 6, finePerExcessAttemptMinor: 200 };
    expect(netValue([mkOutcome(DeclineCode.InsufficientFunds, 0, 8)], cost).fineMinor).toBe(2 * 200);
    expect(netValue([mkOutcome(DeclineCode.InsufficientFunds, 0, 6)], cost).fineMinor).toBe(0);
  });

  it('the engine uses fewer attempts than every baseline reach', () => {
    for (const p of netValueComparison(4000, 123)) {
      expect(p.engineAttemptsPerInvoice).toBeLessThan(p.baselineAttemptsPerInvoice);
    }
  });

  it('fine sensitivity is monotone: a higher do-not-retry fine never raises the baseline net', () => {
    const pts = fineSensitivity(4000, 123);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.baselineNetPerInvoice).toBeLessThanOrEqual(pts[i - 1]!.baselineNetPerInvoice + 1e-9);
    }
  });
});

describe('dead-credential recovery — a real edge vs the realistic baseline, parity vs max-persistence', () => {
  it('beats the realistic (default-reach) baseline solidly; edge shrinks toward parity as the baseline reaches window-close', () => {
    const sweep = baselineReachSweep(40_000, 4242);
    const [d18, d28, d35] = sweep;
    // Robust, material win vs a baseline that reaches ~day 18 (what merchants actually run).
    expect(d18!.rateDiff).toBeGreaterThan(0.05);
    // The edge is a FIXED capability (credential recovery); a longer-reaching baseline
    // catches up on soft declines, so the margin monotonically shrinks…
    expect(d18!.rateDiff).toBeGreaterThan(d28!.rateDiff);
    expect(d28!.rateDiff).toBeGreaterThan(d35!.rateDiff);
    // …to roughly PARITY vs a maximally-persistent baseline (NOT a claimed win — honest).
    expect(Math.abs(d35!.rateDiff)).toBeLessThan(0.04);
  });

  it('the win concentrates in dead-credential codes a retry cannot reach', () => {
    const invoices = generateStream(15_000, 99);
    // Compare against the MOST persistent baseline, so any win here is a pure capability
    // edge (not a window effect): even retrying to day 35 can't do AU / alt-rail / dunning.
    const control = runPolicy(invoices, new StripeSmartRetriesBaseline([1, 4, 10, 18, 28, 35]), deriveSeed(99, 'c'));
    const treatment = runPolicy(invoices, new EnginePolicy(), deriveSeed(99, 't'));
    const byCode = computeByCode(control, treatment);
    const expired = byCode.find((c) => c.code === DeclineCode.ExpiredCard)!;
    const closed = byCode.find((c) => c.code === DeclineCode.ClosedAccount)!;
    // Expired cards: the overlay recovers far more than even a max-persistent blanket retry.
    expect(expired.treatmentRate).toBeGreaterThan(expired.controlRate + 0.2);
    // Closed accounts don't reissue, so retries recover ~none; alt-rail/dunning recover some.
    expect(closed.treatmentRate).toBeGreaterThan(closed.controlRate);
  });
});

describe('determinism (§1.3)', () => {
  it('fixed seeds produce identical estimates', () => {
    const run = () => {
      const invoices = generateStream(6000, 99);
      return runComparison({
        invoices,
        controlPolicy: new StripeSmartRetriesBaseline(),
        treatmentPolicy: new EnginePolicy(),
        controlSeed: deriveSeed(99, 'c'),
        treatmentSeed: deriveSeed(99, 't'),
      }).estimate;
    };
    const a = run();
    const b = run();
    expect(a.rateDiff).toBe(b.rateDiff);
    expect(a.deltaPer).toBe(b.deltaPer);
    expect(a.lowerPer).toBe(b.lowerPer);
    expect(a.fee.amount).toBe(b.fee.amount);
  });
});
