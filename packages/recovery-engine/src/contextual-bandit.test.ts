import { describe, expect, it } from 'vitest';
import { DeclineCode } from '@ax10m/canonical';
import { emptyBanditState, LinUcbBanditPolicy, mergeBanditDelta } from './contextual-bandit.js';
import { CostAwarePolicy } from './policy.js';
import type { RecoverabilityModel, RecoveryFeatures } from './recoverability.js';

const fixedModel = (s: number): RecoverabilityModel => ({ score: () => s });

function feat(overrides: Partial<RecoveryFeatures> = {}): RecoveryFeatures {
  return {
    declineCode: DeclineCode.InsufficientFunds,
    amountMinor: 20_000,
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

describe('LinUcbBanditPolicy — grounded cold start', () => {
  it('with no data, chooses the same action as the cost-aware objective', () => {
    const model = fixedModel(0.6);
    const bandit = new LinUcbBanditPolicy(model);
    const costAware = new CostAwarePolicy(model);
    // Healthy soft decline → both retry.
    expect(bandit.decide(feat(), ctx()).action).toBe(costAware.decide(feat(), ctx()).action);
    expect(bandit.decide(feat(), ctx()).action).toBe('retry');
    // Dead credential → both comms.
    expect(bandit.decide(feat({ declineCode: DeclineCode.LostCard }), ctx()).action).toBe('card_update_comms');
  });

  it('preserves the compliance floor: a near-cap retry is not a candidate', () => {
    const bandit = new LinUcbBanditPolicy(fixedModel(0.1));
    const f = feat({ amountMinor: 6_000 });
    expect(bandit.decide(f, ctx({ attemptsInNetworkWindow: 1, networkCap: 15 })).action).toBe('retry');
    // Near the cap the cost-aware retry net value goes ≤ 0 → retry drops out → comms/suppress.
    expect(bandit.decide(f, ctx({ attemptsInNetworkWindow: 14, networkCap: 15 })).action).not.toBe('retry');
  });
});

describe('LinUcbBanditPolicy — online learning', () => {
  it('shifts AWAY from an arm that realizes poor rewards', () => {
    const bandit = new LinUcbBanditPolicy(fixedModel(0.5));
    const f = feat();
    // Cold start prefers retry.
    const cold = bandit.decide(f, ctx());
    expect(cold.action).toBe('retry');
    // Feed the retry arm many failed outcomes (reward 0 — no recovery).
    for (let i = 0; i < 300; i++) bandit.update(f, { action: 'retry', recoverabilityScore: 0.5, expectedValueMinor: 0, rationale: 'x' }, 0);
    // The learned retry value collapses toward 0, below the comms prior → switch to comms.
    const learned = bandit.decide(f, ctx());
    expect(learned.action).toBe('card_update_comms');
    expect(cold.action).toBe('retry'); // it genuinely changed its mind from the cold-start choice
  });

  it('a well-rewarded arm keeps (and sharpens) its learned value', () => {
    const bandit = new LinUcbBanditPolicy(fixedModel(0.5));
    const f = feat({ amountMinor: 20_000 });
    // Retry consistently recovers ~ the full amount (reward = amount − fee).
    for (let i = 0; i < 300; i++) bandit.update(f, { action: 'retry', recoverabilityScore: 0.5, expectedValueMinor: 0, rationale: 'x' }, 19_985);
    const d = bandit.decide(f, ctx());
    expect(d.action).toBe('retry');
    // Learned net value converges toward the realized reward (~$199.85), above the cold prior (~$159.85).
    expect(d.netValueMinor!).toBeGreaterThan(16_000);
  });

  it('update() only learns the chosen arm; suppress has no learnable reward (no throw)', () => {
    const bandit = new LinUcbBanditPolicy(fixedModel(0.5));
    const f = feat();
    expect(() => bandit.update(f, { action: 'suppress', recoverabilityScore: 0, expectedValueMinor: 0, rationale: 'x' }, 0)).not.toThrow();
    // A comms reward doesn't move the retry arm: retry still chosen at cold-start prior.
    bandit.update(f, { action: 'card_update_comms', recoverabilityScore: 0.5, expectedValueMinor: 0, rationale: 'x' }, 50_000);
    expect(bandit.decide(f, ctx()).action).toBe('retry'); // retry prior still wins for a healthy soft decline
  });
});

describe('LinUcbBanditPolicy — persistence + cross-merchant flywheel', () => {
  it('snapshot → restore round-trips the learned state (survives a restart)', () => {
    const f = feat();
    const trained = new LinUcbBanditPolicy(fixedModel(0.5));
    for (let i = 0; i < 300; i++) trained.update(f, { action: 'retry', recoverabilityScore: 0.5, expectedValueMinor: 0, rationale: 'x' }, 0);
    const decisionBefore = trained.decide(f, ctx());

    // "Restart": a fresh policy loads the snapshot and must decide identically.
    const restored = new LinUcbBanditPolicy(fixedModel(0.5));
    restored.restore(trained.snapshot());
    const decisionAfter = restored.decide(f, ctx());
    expect(decisionAfter.action).toBe(decisionBefore.action);
    expect(decisionAfter.netValueMinor).toBe(decisionBefore.netValueMinor);
  });

  it('mergeBanditDelta pools two processes contributions additively', () => {
    const f = feat();
    // Two processes both start from the same baseline (empty), each learns 150 retry rewards.
    const baseline = emptyBanditState();
    const a = new LinUcbBanditPolicy(fixedModel(0.5));
    const b = new LinUcbBanditPolicy(fixedModel(0.5));
    for (let i = 0; i < 150; i++) a.update(f, { action: 'retry', recoverabilityScore: 0.5, expectedValueMinor: 0, rationale: 'x' }, 19_985);
    for (let i = 0; i < 150; i++) b.update(f, { action: 'retry', recoverabilityScore: 0.5, expectedValueMinor: 0, rationale: 'x' }, 19_985);

    // Merge b's delta into a's state (as a persisted flush would): persisted=a, current=b, baseline.
    const merged = mergeBanditDelta(a.snapshot(), b.snapshot(), baseline);
    expect(merged.arms.retry.n).toBe(300); // 150 + (150 − 0)

    // A single policy that saw all 300 rewards should match the merged (pooled) state's decision.
    const pooled = new LinUcbBanditPolicy(fixedModel(0.5));
    for (let i = 0; i < 300; i++) pooled.update(f, { action: 'retry', recoverabilityScore: 0.5, expectedValueMinor: 0, rationale: 'x' }, 19_985);
    const fromMerged = new LinUcbBanditPolicy(fixedModel(0.5));
    fromMerged.restore(merged);
    expect(fromMerged.decide(f, ctx()).netValueMinor).toBeCloseTo(pooled.decide(f, ctx()).netValueMinor!, -2); // within ~$1
  });
});
