import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily } from '@lift/canonical';
import {
  captureOfRemaining,
  projectShadow,
  DEFAULT_PROJECTION_CONFIG,
  type ShadowObservation,
} from './projection.js';

function obs(code: DeclineCode, amount: number, baselineRecovered: boolean, n: number): ShadowObservation[] {
  return Array.from({ length: n }, () => ({ declineCode: code, amount, baselineRecovered }));
}

describe('projectShadow', () => {
  // 1000 NSF (400 recovered by baseline), 300 expired (0 recovered), 200 lost_card (0 recovered).
  const observations = [
    ...obs(DeclineCode.InsufficientFunds, 10_000, true, 400),
    ...obs(DeclineCode.InsufficientFunds, 10_000, false, 600),
    ...obs(DeclineCode.ExpiredCard, 10_000, false, 300),
    ...obs(DeclineCode.LostCard, 10_000, false, 200),
  ];

  it('measures the observed baseline correctly', () => {
    const p = projectShadow(observations, 14);
    expect(p.observedFailures).toBe(1500);
    expect(p.baselineRecovered).toBe(400);
    expect(p.baselineRecoveryRate).toBeCloseTo(400 / 1500, 5);
    expect(p.missedValue.amount).toBe(1100 * 10_000); // 600 + 300 + 200 missed
    expect(p.holdoutVerified).toBe(false);
  });

  it('projects incremental value ONLY from invoices the baseline missed (no double-count)', () => {
    const p = projectShadow(observations, 14);
    // NSF: 600 missed × $100 × 0.22 ; expired: 300 × $100 × 0.30 ; lost: 200 × $100 × 0.02
    const expectedWindow = 600 * 10_000 * 0.22 + 300 * 10_000 * 0.3 + 200 * 10_000 * 0.02;
    expect(p.projectedWindowValue.amount).toBe(Math.round(expectedWindow));
    // The 400 baseline-recovered NSF add nothing.
    const soft = p.byFamily.find((f) => f.family === DeclineFamily.Soft)!;
    expect(soft.missedValue).toBe(600 * 10_000);
    expect(soft.captureRate).toBeCloseTo(0.22, 5);
  });

  it('projects ~zero uplift for hard declines (we suppress, not pretend)', () => {
    const p = projectShadow(observations, 14);
    const hard = p.byFamily.find((f) => f.family === DeclineFamily.Hard)!;
    expect(hard.captureRate).toBeCloseTo(0.02, 5);
    expect(hard.projectedValue).toBeLessThan(p.byFamily.find((f) => f.family === DeclineFamily.Soft)!.projectedValue);
  });

  it('scales the window to a month and charges 12% of the expected monthly figure', () => {
    const p = projectShadow(observations, 14);
    const factor = 30 / 14;
    expect(p.projectedMonthlyValue.amount).toBe(Math.round(p.projectedWindowValue.amount * factor));
    expect(p.projectedMonthlyFee.amount).toBe(Math.round(p.projectedMonthlyValue.amount * DEFAULT_PROJECTION_CONFIG.feeRate));
    expect(p.projectedMonthlyConservative.amount).toBeLessThan(p.projectedMonthlyValue.amount);
  });

  it('does not divide by zero when elapsedDays is 0', () => {
    const p = projectShadow(observations, 0);
    expect(p.projectedMonthlyValue.amount).toBe(p.projectedWindowValue.amount);
  });

  it('sorts the family breakdown by projected value (biggest opportunity first)', () => {
    const p = projectShadow(observations, 14);
    const values = p.byFamily.map((f) => f.projectedValue);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(p.byFamily[0]!.family).toBe(DeclineFamily.Soft); // NSF is the biggest bucket here
  });

  it('handles an all-recovered baseline as zero projected uplift', () => {
    const p = projectShadow(obs(DeclineCode.InsufficientFunds, 5000, true, 300), 14);
    expect(p.projectedWindowValue.amount).toBe(0);
    expect(p.projectedMonthlyFee.amount).toBe(0);
  });
});

describe('captureOfRemaining', () => {
  it('uses per-code priors and falls back to family', () => {
    expect(captureOfRemaining(DeclineCode.ExpiredCard)).toBe(0.3);
    expect(captureOfRemaining(DeclineCode.LostCard)).toBe(0.02); // hard-family fallback
  });
});
