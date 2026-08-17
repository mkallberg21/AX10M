import { describe, expect, it } from 'vitest';
import { DeclineCode } from '@ax10m/canonical';
import { commsNetValue, DEFAULT_COST_MODEL, expectedFineCostMinor, retryNetValue } from './objective.js';
import { CostAwarePolicy } from './policy.js';
import type { RecoverabilityModel, RecoveryFeatures } from './recoverability.js';

/** A model with a fixed score, so policy tests are independent of the heuristic's internals. */
const fixedModel = (s: number): RecoverabilityModel => ({ score: () => s });

describe('expectedFineCostMinor', () => {
  const cost = DEFAULT_COST_MODEL;
  it('is zero well below the cap, ramps as the cap nears, and maxes at/over the cap', () => {
    expect(expectedFineCostMinor({ attemptsInNetworkWindow: 0, networkCap: 15 }, cost)).toBe(0);
    expect(expectedFineCostMinor({ attemptsInNetworkWindow: 9, networkCap: 15 }, cost)).toBe(0); // 60% → ramp start
    expect(expectedFineCostMinor({ attemptsInNetworkWindow: 12, networkCap: 15 }, cost)).toBe(1_250); // halfway up the ramp → 50% exposure
    expect(expectedFineCostMinor({ attemptsInNetworkWindow: 15, networkCap: 15 }, cost)).toBe(2_500); // at cap → full exposure
    expect(expectedFineCostMinor({ attemptsInNetworkWindow: 20, networkCap: 15 }, cost)).toBe(2_500); // over cap → capped
  });
  it('is zero when no cap is known', () => {
    expect(expectedFineCostMinor(undefined, cost)).toBe(0);
    expect(expectedFineCostMinor({ attemptsInNetworkWindow: 5 }, cost)).toBe(0);
  });
});

describe('retryNetValue', () => {
  it('nets the attempt fee, and subtracts the fine cost as the cap nears', () => {
    const far = retryNetValue({ recoverability: 0.5, amountMinor: 10_000, compliance: { attemptsInNetworkWindow: 1, networkCap: 15 } });
    // 0.5 * 10000 * 1.6 = 8000 gross − 15 fee − 0 fine
    expect(far.grossMinor).toBe(8_000);
    expect(far.netValueMinor).toBe(7_985);
    const nearCap = retryNetValue({ recoverability: 0.5, amountMinor: 10_000, compliance: { attemptsInNetworkWindow: 14, networkCap: 15 } });
    // fine at 14/15 ≈ 87% up the ramp → large fine cost → much lower net value
    expect(nearCap.cost.fineCostMinor).toBeGreaterThan(2_000);
    expect(nearCap.netValueMinor).toBeLessThan(far.netValueMinor);
  });
});

describe('commsNetValue', () => {
  it('nets only the comms cost (no network fine risk)', () => {
    const v = commsNetValue({ recoverability: 0.4, amountMinor: 10_000 });
    expect(v.grossMinor).toBe(6_400); // 0.4 * 10000 * 1.6
    expect(v.netValueMinor).toBe(6_395); // − 5 comms cost
    expect(v.cost.fineCostMinor).toBe(0);
  });
});

// ── CostAwarePolicy: the objective as the decision surface ──────────────────────
function feat(overrides: Partial<RecoveryFeatures> = {}): RecoveryFeatures {
  return {
    declineCode: DeclineCode.InsufficientFunds,
    amountMinor: 10_000,
    currency: 'USD',
    issuerRegion: 'na',
    customerTenureDays: 365,
    priorRecoveryRate: 0.4,
    attemptNumber: 1,
    daysSinceFirstFail: 0,
    ...overrides,
  };
}
const ctx = (compliance?: { attemptsInNetworkWindow: number; networkCap: number }) => ({ now: '2026-08-16T12:00:00.000Z', methods: [{ ref: 'pm_1', isDefault: true }], compliance });

describe('CostAwarePolicy', () => {
  it('routes a dead-credential decline to card-update comms', () => {
    const policy = new CostAwarePolicy(fixedModel(0.3));
    expect(policy.decide(feat({ declineCode: DeclineCode.LostCard }), ctx()).action).toBe('card_update_comms');
    expect(policy.decide(feat({ declineCode: DeclineCode.ExpiredCard }), ctx()).action).toBe('card_update_comms');
  });

  it('retries a healthy soft decline, reporting a positive net value', () => {
    const d = new CostAwarePolicy(fixedModel(0.6)).decide(feat({ amountMinor: 20_000 }), ctx());
    expect(d.action).toBe('retry');
    expect(d.netValueMinor).toBeGreaterThan(0);
    expect(d.costBreakdown?.fineCostMinor).toBe(0); // no cap pressure
  });

  it('SUPPRESSES a retry near the network cap that it would otherwise attempt (the compliance edge)', () => {
    // score 0.1 × $60 × 1.6 = $9.60 gross → far-from-cap net +945; near-cap fine (~$21.79) sinks it.
    const policy = new CostAwarePolicy(fixedModel(0.1));
    const f = feat({ amountMinor: 6_000 });
    const far = policy.decide(f, ctx({ attemptsInNetworkWindow: 1, networkCap: 15 }));
    expect(far.action).toBe('retry');
    const near = policy.decide(f, ctx({ attemptsInNetworkWindow: 14, networkCap: 15 }));
    expect(near.action).toBe('suppress');
    expect(near.costBreakdown?.fineCostMinor).toBeGreaterThan(0);
    expect(near.rationale).toMatch(/fine cost/);
  });

  it('with no compliance context, matches the plain attempt-cost EV (safe drop-in)', () => {
    const d = new CostAwarePolicy(fixedModel(0.5)).decide(feat({ amountMinor: 10_000 }), ctx());
    // 0.5 * 10000 * 1.6 − 15 attempt fee = 7985
    expect(d.expectedValueMinor).toBe(7_985);
  });
});
