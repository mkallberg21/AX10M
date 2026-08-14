import { describe, expect, it } from 'vitest';
import {
  computeUplift,
  recoveryRate,
  srmCheck,
  type ArmStats,
  type UpliftConfig,
} from './uplift.js';

const config: UpliftConfig = {
  z: 1.96,
  minSamplesPerArm: 200,
  feeRate: 0.12,
  currency: 'USD',
};

describe('recoveryRate', () => {
  it('is 0 for an empty arm (no divide-by-zero)', () => {
    expect(recoveryRate({ n: 0, recovered: 0, failedVolume: 0, recoveredVolume: 0 })).toBe(0);
  });
  it('computes the rate', () => {
    expect(recoveryRate({ n: 1000, recovered: 500, failedVolume: 0, recoveredVolume: 0 })).toBe(0.5);
  });
});

describe('computeUplift', () => {
  it('bills on the lower bound, which is strictly below the point estimate', () => {
    const control: ArmStats = { n: 1000, recovered: 400, failedVolume: 5_000_000, recoveredVolume: 2_000_000 };
    const treatment: ArmStats = { n: 9000, recovered: 4500, failedVolume: 45_000_000, recoveredVolume: 22_500_000 };
    const r = computeUplift(control, treatment, config);

    expect(r.controlRate).toBeCloseTo(0.4, 5);
    expect(r.treatmentRate).toBeCloseTo(0.5, 5);
    expect(r.rateDiff).toBeCloseTo(0.1, 5);

    // Lower bound < point estimate — structural under-claiming.
    expect(r.rateDiffLower).toBeLessThan(r.rateDiff);
    expect(r.incrementalDollarsLower.amount).toBeLessThan(r.incrementalDollars);
    expect(r.billable).toBe(true);
  });

  it('charges exactly feeRate of the lower-bound incremental dollars', () => {
    const control: ArmStats = { n: 1000, recovered: 400, failedVolume: 5_000_000, recoveredVolume: 2_000_000 };
    const treatment: ArmStats = { n: 9000, recovered: 4500, failedVolume: 45_000_000, recoveredVolume: 22_500_000 };
    const r = computeUplift(control, treatment, config);
    expect(r.fee.amount).toBe(Math.round(r.incrementalDollarsLower.amount * config.feeRate));
  });

  it('is not billable below the minimum sample size', () => {
    const control: ArmStats = { n: 50, recovered: 20, failedVolume: 250_000, recoveredVolume: 100_000 };
    const treatment: ArmStats = { n: 100, recovered: 55, failedVolume: 500_000, recoveredVolume: 275_000 };
    const r = computeUplift(control, treatment, config);
    expect(r.billable).toBe(false);
    expect(r.fee.amount).toBe(0);
  });

  it('is not billable and floors at zero when the lower bound is negative', () => {
    // Treatment barely above control with high variance → lower bound < 0.
    const control: ArmStats = { n: 500, recovered: 250, failedVolume: 2_500_000, recoveredVolume: 1_250_000 };
    const treatment: ArmStats = { n: 500, recovered: 255, failedVolume: 2_500_000, recoveredVolume: 1_275_000 };
    const r = computeUplift(control, treatment, config);
    expect(r.rateDiffLower).toBeLessThan(0);
    expect(r.incrementalDollarsLower.amount).toBe(0);
    expect(r.billable).toBe(false);
  });
});

describe('srmCheck', () => {
  it('does not breach when the split matches expectation', () => {
    const { breached } = srmCheck(1000, 9000, 0.1);
    expect(breached).toBe(false);
  });
  it('breaches on a gross sample-ratio mismatch', () => {
    const { breached } = srmCheck(3000, 7000, 0.1);
    expect(breached).toBe(true);
  });
});
