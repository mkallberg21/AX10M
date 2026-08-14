import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily } from '@ax10m/canonical';
import { evaluate, inQuietHours } from './guardrail.js';
import { SuppressionReason, type ProposedAction } from './types.js';

const retryAction: ProposedAction = {
  kind: 'charge_retry',
  declineCode: DeclineCode.InsufficientFunds,
  declineFamily: DeclineFamily.Soft,
  attemptsSoFar: 1,
  localHour: 14,
  hasConsent: true,
  globallyOptedOut: false,
};

const commsAction: ProposedAction = {
  kind: 'comms',
  channel: 'email',
  declineCode: DeclineCode.InsufficientFunds,
  declineFamily: DeclineFamily.Soft,
  attemptsSoFar: 1,
  localHour: 14,
  hasConsent: true,
  globallyOptedOut: false,
};

describe('inQuietHours', () => {
  it('handles wrap-around windows (21 → 8)', () => {
    expect(inQuietHours(22, { start: 21, end: 8 })).toBe(true);
    expect(inQuietHours(3, { start: 21, end: 8 })).toBe(true);
    expect(inQuietHours(14, { start: 21, end: 8 })).toBe(false);
  });
  it('handles normal windows (1 → 6)', () => {
    expect(inQuietHours(3, { start: 1, end: 6 })).toBe(true);
    expect(inQuietHours(8, { start: 1, end: 6 })).toBe(false);
  });
});

describe('guardrail.evaluate', () => {
  it('allows a compliant soft-decline retry', () => {
    expect(evaluate(retryAction)).toEqual({ allow: true });
  });

  it('suppresses retries on a hard decline (network-penalty risk)', () => {
    const d = evaluate({
      ...retryAction,
      declineCode: DeclineCode.LostCard,
      declineFamily: DeclineFamily.Hard,
    });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe(SuppressionReason.HardDecline);
  });

  it('suppresses a retry once the attempt cap is reached', () => {
    const d = evaluate({ ...retryAction, attemptsSoFar: 4 }, { maxRetryAttempts: 4, quietHours: { start: 21, end: 8 } });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe(SuppressionReason.RetryCapReached);
  });

  it('global opt-out overrides everything, even a compliant action', () => {
    const d = evaluate({ ...retryAction, globallyOptedOut: true });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe(SuppressionReason.GlobalOptOut);
  });

  it('suppresses comms during quiet hours', () => {
    const d = evaluate({ ...commsAction, localHour: 23 });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe(SuppressionReason.QuietHours);
  });

  it('suppresses comms without channel consent', () => {
    const d = evaluate({ ...commsAction, hasConsent: false });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe(SuppressionReason.NoConsent);
  });

  it('fails closed on an unrecognized action kind', () => {
    const d = evaluate({ ...retryAction, kind: 'chargeback_dispute' as never });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe(SuppressionReason.UnknownAction);
  });
});

describe('card-network retry-cap compliance', () => {
  it('suppresses a retry once the network window cap is reached', () => {
    const d = evaluate({ ...retryAction, cardNetwork: 'visa', attemptsInWindow: 15 });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe(SuppressionReason.NetworkWindowCapReached);
  });

  it('allows a retry still under the network window cap', () => {
    expect(evaluate({ ...retryAction, cardNetwork: 'visa', attemptsInWindow: 3 })).toEqual({ allow: true });
  });

  it('suppresses a retry attempted before the min inter-attempt interval', () => {
    const d = evaluate({ ...retryAction, cardNetwork: 'mastercard', minutesSinceLastAttempt: 5 });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe(SuppressionReason.MinIntervalNotElapsed);
  });

  it('respects tighter per-network caps (mastercard 10 < visa 15)', () => {
    const mc = evaluate({ ...retryAction, cardNetwork: 'mastercard', attemptsInWindow: 10 });
    expect(mc.allow).toBe(false);
    const visa = evaluate({ ...retryAction, cardNetwork: 'visa', attemptsInWindow: 10 });
    expect(visa.allow).toBe(true);
  });
});
