import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily } from '@ax10m/canonical';
import { classifyDecline, describeCanonicalTaxonomy } from './decline-intel.js';
import { strategyFor } from './retry-strategy.js';
import { planRetrySequence } from './sequence.js';
import { DeclineIntelligenceEngine } from './intelligence.js';
import type { RecoveryFeatures } from './recoverability.js';

const feat = (over: Partial<RecoveryFeatures> = {}): RecoveryFeatures => ({
  declineCode: DeclineCode.InsufficientFunds,
  amountMinor: 5000,
  currency: 'USD',
  issuerRegion: 'na',
  customerTenureDays: 300,
  priorRecoveryRate: 0.5,
  attemptNumber: 1,
  daysSinceFirstFail: 0,
  issuerApprovalPrior: 0.6,
  ...over,
});

describe('classifyDecline', () => {
  it('routes dead/expired credentials to card_update, fraud to suppress, soft to retry', () => {
    expect(classifyDecline(DeclineCode.ExpiredCard).recommendedAction).toBe('card_update');
    expect(classifyDecline(DeclineCode.LostCard).recommendedAction).toBe('card_update');
    expect(classifyDecline(DeclineCode.Fraudulent).recommendedAction).toBe('suppress');
    expect(classifyDecline(DeclineCode.InsufficientFunds).recommendedAction).toBe('retry');
    expect(classifyDecline(DeclineCode.DoNotHonor).recommendedAction).toBe('retry');
  });

  it('describes the whole canonical taxonomy (the cross-processor map)', () => {
    const tax = describeCanonicalTaxonomy();
    expect(tax.length).toBe(Object.values(DeclineCode).length);
    expect(tax.every((t) => t.description.length > 0)).toBe(true);
    expect(tax.find((t) => t.code === DeclineCode.LostCard)!.family).toBe(DeclineFamily.Hard);
  });
});

describe('strategyFor', () => {
  it('NSF gets payday-spaced days; issuer errors get minutes', () => {
    const nsf = strategyFor(DeclineCode.InsufficientFunds, 'visa');
    expect(nsf.delaysMinutes[0]).toBe(1440); // 1 day
    const transient = strategyFor(DeclineCode.IssuerUnavailable, 'visa');
    expect(transient.delaysMinutes[0]).toBe(15); // 15 minutes
  });

  it('applies per-network attempt ceilings', () => {
    expect(strategyFor(DeclineCode.InsufficientFunds, 'visa').maxAttempts).toBe(3);
    expect(strategyFor(DeclineCode.InsufficientFunds, 'other').maxAttempts).toBe(2); // clamped to 2
    expect(strategyFor(DeclineCode.InsufficientFunds, 'amex').maxAttempts).toBe(3);
  });

  it('non-retry declines produce a zero-attempt strategy', () => {
    const s = strategyFor(DeclineCode.ExpiredCard, 'visa');
    expect(s.action).toBe('card_update');
    expect(s.maxAttempts).toBe(0);
    expect(s.delaysMinutes).toEqual([]);
  });

  it('do-not-honor rotates the credential after 2 attempts', () => {
    expect(strategyFor(DeclineCode.DoNotHonor, 'visa').rotateMethodAfterAttempt).toBe(2);
  });
});

describe('planRetrySequence (ARSE)', () => {
  it('produces an ordered, time-increasing, bounded schedule for a soft decline', () => {
    const steps = planRetrySequence(feat({ declineCode: DeclineCode.InsufficientFunds, priorRecoveryRate: 0.8, issuerApprovalPrior: 0.8 }), {
      now: '2026-08-14T12:00:00.000Z',
      network: 'visa',
      methods: [{ ref: 'pm_1', isDefault: true }],
    });
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.length).toBeLessThanOrEqual(3); // visa NSF cap
    for (let i = 1; i < steps.length; i++) {
      expect(Date.parse(steps[i]!.at)).toBeGreaterThan(Date.parse(steps[i - 1]!.at)); // strictly later
      expect(steps[i]!.attemptNumber).toBe(steps[i - 1]!.attemptNumber + 1);
    }
    expect(steps.every((s) => s.action === 'retry')).toBe(true);
  });

  it('returns a single terminal card_update step for an expired card (no charge retries)', () => {
    const steps = planRetrySequence(feat({ declineCode: DeclineCode.ExpiredCard }), { now: '2026-08-14T12:00:00.000Z', network: 'visa' });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.action).toBe('card_update');
  });

  it('stops early once predicted recoverability falls below the floor', () => {
    // A hopeless-but-technically-soft case: high floor forces early truncation.
    const steps = planRetrySequence(feat({ declineCode: DeclineCode.DoNotHonor, priorRecoveryRate: 0.02, issuerApprovalPrior: 0.05, attemptNumber: 4 }), {
      now: '2026-08-14T12:00:00.000Z',
      network: 'visa',
      minRecoverabilityToContinue: 0.5,
    });
    expect(steps.length).toBeLessThan(3); // truncated before the full cadence
  });

  it('rotates to an alternate credential after the strategy threshold', () => {
    const steps = planRetrySequence(feat({ declineCode: DeclineCode.DoNotHonor, priorRecoveryRate: 0.7, issuerApprovalPrior: 0.7 }), {
      now: '2026-08-14T12:00:00.000Z',
      network: 'visa',
      minRecoverabilityToContinue: 0,
      methods: [{ ref: 'pm_default', isDefault: true }, { ref: 'pm_alt', isDefault: false }],
    });
    // rotateAfter=2 → step index >=2 uses the alternate.
    if (steps.length >= 3) expect(steps[2]!.methodRef).toBe('pm_alt');
    expect(steps[0]!.methodRef).toBe('pm_default');
  });
});

describe('DeclineIntelligenceEngine facade', () => {
  it('exposes classify / strategy / predict / sequence / taxonomy', () => {
    const engine = new DeclineIntelligenceEngine();
    expect(engine.classify(DeclineCode.InsufficientFunds).recommendedAction).toBe('retry');
    expect(engine.strategy(DeclineCode.InsufficientFunds, 'visa').maxAttempts).toBe(3);
    expect(engine.predict(feat())).toBeGreaterThan(0);
    expect(engine.predict(feat())).toBeLessThan(1);
    expect(engine.sequence(feat({ priorRecoveryRate: 0.8, issuerApprovalPrior: 0.8 }), { now: '2026-08-14T12:00:00.000Z', network: 'visa' }).length).toBeGreaterThan(0);
    expect(engine.taxonomy().length).toBe(Object.values(DeclineCode).length);
  });
});
