import { describe, expect, it } from 'vitest';
import { DeclineCode } from '@ax10m/canonical';
import { HeuristicRecoverability, type RecoveryFeatures } from './recoverability.js';
import { optimalRetryTime } from './timing.js';
import { HeuristicPolicy, type AvailableMethod } from './policy.js';

function feat(over: Partial<RecoveryFeatures> = {}): RecoveryFeatures {
  return {
    declineCode: DeclineCode.InsufficientFunds,
    amountMinor: 5000,
    currency: 'USD',
    issuerRegion: 'na',
    customerTenureDays: 365,
    priorRecoveryRate: 0.4,
    attemptNumber: 1,
    daysSinceFirstFail: 0,
    ...over,
  };
}

const NOW = '2026-08-10T00:00:00.000Z';

describe('HeuristicRecoverability', () => {
  const m = new HeuristicRecoverability();

  it('ranks soft > gray > hard declines', () => {
    const soft = m.score(feat({ declineCode: DeclineCode.InsufficientFunds }));
    const gray = m.score(feat({ declineCode: DeclineCode.DoNotHonor }));
    const hard = m.score(feat({ declineCode: DeclineCode.LostCard }));
    expect(soft).toBeGreaterThan(gray);
    expect(gray).toBeGreaterThan(hard);
    expect(hard).toBeLessThan(0.15); // hard declines rarely recover on the same card
  });

  it('decays with each additional failed attempt', () => {
    const a1 = m.score(feat({ attemptNumber: 1 }));
    const a4 = m.score(feat({ attemptNumber: 4 }));
    expect(a4).toBeLessThan(a1);
  });

  it('rises with the customer\'s prior recovery rate', () => {
    expect(m.score(feat({ priorRecoveryRate: 0.8 }))).toBeGreaterThan(m.score(feat({ priorRecoveryRate: 0.1 })));
  });

  it('rises with a favorable cross-merchant issuer prior (the flywheel signal)', () => {
    expect(m.score(feat({ issuerApprovalPrior: 0.9 }))).toBeGreaterThan(m.score(feat({ issuerApprovalPrior: 0.2 })));
  });
});

describe('optimalRetryTime', () => {
  it('times insufficient-funds to payday (or +2d on the first attempt)', () => {
    const first = optimalRetryTime(feat({ declineCode: DeclineCode.InsufficientFunds, attemptNumber: 1 }), NOW);
    expect(first.retryAt).toBe('2026-08-12T00:00:00.000Z'); // +2 days, sooner than the 15th
    const second = optimalRetryTime(feat({ declineCode: DeclineCode.InsufficientFunds, attemptNumber: 2 }), NOW);
    expect(second.retryAt).toBe('2026-08-15T12:00:00.000Z'); // payday proxy (the 15th)
  });

  it('retries a transient issuer error quickly with an escalating backoff', () => {
    expect(optimalRetryTime(feat({ declineCode: DeclineCode.IssuerUnavailable, attemptNumber: 1 }), NOW).retryAt).toBe('2026-08-10T02:00:00.000Z');
    expect(optimalRetryTime(feat({ declineCode: DeclineCode.IssuerUnavailable, attemptNumber: 2 }), NOW).retryAt).toBe('2026-08-10T06:00:00.000Z');
  });

  it('backs off longer on a generic decline, escalating by attempt', () => {
    expect(optimalRetryTime(feat({ declineCode: DeclineCode.DoNotHonor, attemptNumber: 1 }), NOW).retryAt).toBe('2026-08-11T00:00:00.000Z');
    expect(optimalRetryTime(feat({ declineCode: DeclineCode.DoNotHonor, attemptNumber: 2 }), NOW).retryAt).toBe('2026-08-13T00:00:00.000Z');
  });
});

describe('HeuristicPolicy.decide', () => {
  const policy = new HeuristicPolicy();
  const ctx = (methods?: AvailableMethod[]) => ({ now: NOW, methods });

  it('routes a hard/expired decline to card-update comms, never a same-card retry', () => {
    expect(policy.decide(feat({ declineCode: DeclineCode.LostCard }), ctx()).action).toBe('card_update_comms');
    expect(policy.decide(feat({ declineCode: DeclineCode.ExpiredCard }), ctx()).action).toBe('card_update_comms');
  });

  it('retries a recoverable failure with a schedule, method, and positive expected value', () => {
    const d = policy.decide(
      feat({ declineCode: DeclineCode.InsufficientFunds, amountMinor: 20_000, priorRecoveryRate: 0.6 }),
      ctx([{ ref: 'm_default', isDefault: true }]),
    );
    expect(d.action).toBe('retry');
    expect(d.retryAt).toBeTruthy();
    expect(d.paymentMethodRef).toBe('m_default');
    expect(d.expectedValueMinor).toBeGreaterThan(0);
    expect(d.rationale).toMatch(/P\(recover\)/);
  });

  it('suppresses when recoverability is below threshold or expected value ≤ 0', () => {
    // Many prior failed attempts on a tiny gray-zone ticket → not worth an attempt.
    const d = policy.decide(feat({ declineCode: DeclineCode.DoNotHonor, attemptNumber: 6, amountMinor: 100, priorRecoveryRate: 0.1 }), ctx());
    expect(d.action).toBe('suppress');
  });

  it('rotates to an alternate credential after repeated declines', () => {
    const d = policy.decide(
      feat({ declineCode: DeclineCode.InsufficientFunds, amountMinor: 40_000, priorRecoveryRate: 0.7, attemptNumber: 3 }),
      ctx([{ ref: 'm_default', isDefault: true }, { ref: 'm_alt' }]),
    );
    expect(d.action).toBe('retry');
    expect(d.paymentMethodRef).toBe('m_alt');
  });

  it('prefers an Account-Updater-refreshed credential when available', () => {
    const d = policy.decide(
      feat({ declineCode: DeclineCode.InsufficientFunds, amountMinor: 40_000, priorRecoveryRate: 0.7 }),
      ctx([{ ref: 'm_default', isDefault: true }, { ref: 'm_fresh', autoUpdated: true }]),
    );
    expect(d.paymentMethodRef).toBe('m_fresh');
  });
});
