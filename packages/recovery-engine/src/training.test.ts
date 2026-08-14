import { describe, expect, it } from 'vitest';
import { DeclineCode } from '@ax10m/canonical';
import { FEATURE_DIM } from './features.js';
import { LogisticRecoverability } from './logistic.js';
import { HeuristicRecoverability, type RecoveryFeatures } from './recoverability.js';
import { HeuristicPolicy } from './policy.js';
import {
  evaluate,
  fitRecoverability,
  splitTrainTest,
  trainLogisticRecoverability,
} from './training.js';
import { simulateSamples, trueRecoverProb, type SimSample } from './simulate.js';
import { BanditPolicy } from './bandit.js';
import { samplesFromLedger } from './ledger-samples.js';
import { BOOTSTRAP_RECOVERABILITY_WEIGHTS } from './bootstrap-weights.js';

describe('trainer', () => {
  it('recovers signal: held-out AUC is high on the synthetic DGP', () => {
    const { samples } = simulateSamples(6000, 3);
    const { train, test } = splitTrainTest(samples, 0.25, 5);
    const model = fitRecoverability(train, { iterations: 2500, lr: 0.4, l2: 1e-4, seed: 9 });
    const m = evaluate(model, test);
    expect(m.auc).toBeGreaterThan(0.8);
    expect(m.logLoss).toBeLessThan(0.5);
  });

  it('beats the hand-tuned heuristic on held-out AUC', () => {
    const { samples } = simulateSamples(6000, 21);
    const { train, test } = splitTrainTest(samples, 0.25, 8);
    const trained = fitRecoverability(train, { iterations: 2500, lr: 0.4, l2: 1e-4, seed: 4 });
    const trainedAuc = evaluate(trained, test).auc;
    const heuristicAuc = evaluate(new HeuristicRecoverability(), test).auc;
    expect(trainedAuc).toBeGreaterThan(heuristicAuc);
  });

  it('is deterministic: same seed → identical weights', () => {
    const { samples } = simulateSamples(1500, 2);
    const a = trainLogisticRecoverability(samples, { iterations: 300, lr: 0.3, l2: 1e-4, seed: 1 });
    const b = trainLogisticRecoverability(samples, { iterations: 300, lr: 0.3, l2: 1e-4, seed: 1 });
    expect(a.weights.w).toEqual(b.weights.w);
    expect(a.weights.b).toBe(b.weights.b);
  });
});

describe('policy-level uplift (the money metric)', () => {
  it('the trained policy recovers at least as much expected value as the heuristic policy', () => {
    const { samples } = simulateSamples(6000, 55);
    const { train, test } = splitTrainTest(samples, 0.3, 12);
    const trainedModel = fitRecoverability(train, { iterations: 2500, lr: 0.4, l2: 1e-4, seed: 6 });

    const trainedPolicy = new HeuristicPolicy(trainedModel);
    const heuristicPolicy = new HeuristicPolicy(new HeuristicRecoverability());

    // Realized value of a policy = for every case it chooses to RETRY, the true
    // expected recovered dollars minus a per-attempt cost. Better selection wins.
    const attemptCostDollars = 0.15;
    const value = (policy: HeuristicPolicy): number => {
      let total = 0;
      for (const s of test as SimSample[]) {
        const d = policy.decide(s.features, {
          now: '2026-08-14T12:00:00.000Z',
          methods: [{ ref: 'pm_1', isDefault: true }],
        });
        if (d.action === 'retry') {
          total += s.trueProb * (s.features.amountMinor / 100) - attemptCostDollars;
        }
      }
      return total;
    };

    const trainedValue = value(trainedPolicy);
    const heuristicValue = value(heuristicPolicy);
    expect(trainedValue).toBeGreaterThanOrEqual(heuristicValue * 0.999);
  });
});

describe('online bandit', () => {
  it('learns from realized rewards: a blank prior improves toward the DGP', () => {
    const zeros = { w: new Array<number>(FEATURE_DIM).fill(0), b: 0 };
    const bandit = new BanditPolicy(zeros, { learningRate: 0.1, l2: 1e-6 });

    const { samples: trainStream } = simulateSamples(8000, 71);
    for (const s of trainStream) {
      // Reward = dollars recovered (0 if not). One SGD step per realized outcome.
      const reward = s.recovered ? s.features.amountMinor : 0;
      bandit.update(s.features, { action: 'retry', recoverabilityScore: 0, expectedValueMinor: 0, rationale: '' }, reward);
    }

    const { samples: holdout } = simulateSamples(2000, 72);
    const auc = evaluate(bandit.snapshot(), holdout).auc;
    expect(auc).toBeGreaterThan(0.78);
  });
});

describe('ledger → training corpus', () => {
  it('joins planned features with realized outcomes by invoice id', () => {
    const f: RecoveryFeatures = {
      declineCode: DeclineCode.InsufficientFunds,
      amountMinor: 14900,
      currency: 'USD',
      issuerRegion: 'na',
      customerTenureDays: 200,
      priorRecoveryRate: 0.4,
      attemptNumber: 1,
      daysSinceFirstFail: 0,
    };
    const entries = [
      { type: 'recovery.planned', detail: { invoiceId: 'inv_win', features: f } },
      { type: 'charge.failed', detail: { invoiceId: 'inv_win' } },
      { type: 'case.recovered', detail: { invoiceId: 'inv_win', amount: 14900 } },
      { type: 'recovery.planned', detail: { invoiceId: 'inv_lose', features: { ...f, declineCode: DeclineCode.LostCard } } },
      { type: 'charge.failed', detail: { invoiceId: 'inv_lose' } },
      { type: 'recovery.planned', detail: { invoiceId: 'inv_open', features: f } }, // no outcome yet → skipped
    ];
    const samples = samplesFromLedger(entries);
    expect(samples).toHaveLength(2);
    const win = samples.find((s) => s.features.declineCode === DeclineCode.InsufficientFunds);
    const lose = samples.find((s) => s.features.declineCode === DeclineCode.LostCard);
    expect(win?.recovered).toBe(true);
    expect(lose?.recovered).toBe(false);
    expect(win?.weight).toBeCloseTo(149, 5); // amount-weighted
  });
});

describe('shipped bootstrap prior', () => {
  it('loads with the correct dimensionality and produces calibrated scores', () => {
    const model = new LogisticRecoverability(BOOTSTRAP_RECOVERABILITY_WEIGHTS);
    expect(BOOTSTRAP_RECOVERABILITY_WEIGHTS.w).toHaveLength(FEATURE_DIM);

    // A transient issuer error on a good-history customer should score higher than a
    // lost card on a bad-history customer — sanity that the trained signs are right.
    const good: RecoveryFeatures = {
      declineCode: DeclineCode.IssuerUnavailable, amountMinor: 4900, currency: 'USD', issuerRegion: 'na',
      customerTenureDays: 700, priorRecoveryRate: 0.8, attemptNumber: 1, daysSinceFirstFail: 0, issuerApprovalPrior: 0.8,
    };
    const bad: RecoveryFeatures = {
      declineCode: DeclineCode.LostCard, amountMinor: 90000, currency: 'USD', issuerRegion: 'na',
      customerTenureDays: 20, priorRecoveryRate: 0.05, attemptNumber: 4, daysSinceFirstFail: 15, issuerApprovalPrior: 0.15,
    };
    expect(model.score(good)).toBeGreaterThan(model.score(bad));
    expect(model.score(bad)).toBeLessThan(0.2);
    // The bootstrap prior tracks the DGP it was fit to.
    expect(Math.abs(model.score(good) - trueRecoverProb(good))).toBeLessThan(0.25);
  });
});
