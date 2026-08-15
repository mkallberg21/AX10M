import { describe, expect, it } from 'vitest';
import { generateStream } from './world/world.js';
import { EnginePolicy } from './policy/engine-policy.js';
import { StripeSmartRetriesBaseline } from './baselines/smart-retries.js';
import { runComparison } from './estimate.js';
import { aaTest } from './checks.js';
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
