import { describe, expect, it } from 'vitest';
import { DeclineFamily } from '@lift/canonical';
import {
  assign,
  DEFAULT_HOLDOUT_CONFIG,
  stratumKey,
  type AssignmentInput,
  type HoldoutConfig,
} from './holdout.js';

const baseInput: AssignmentInput = {
  merchantId: 'mrc_1',
  customerId: 'cus_1',
  invoiceId: 'inv_1',
  stratum: {
    mrrTier: 'small',
    declineFamily: DeclineFamily.Soft,
    issuerRegion: 'na',
  },
};

describe('holdout assignment', () => {
  it('is deterministic: same input + config yields the same bucket', () => {
    const a = assign(baseInput);
    const b = assign({ ...baseInput, stratum: { ...baseInput.stratum } });
    expect(a.bucket).toBe(b.bucket);
    expect(a.position).toBe(b.position);
    expect(a.stratumKey).toBe(stratumKey(baseInput.stratum));
  });

  it('is stable across many repeated evaluations (no flip on re-processing)', () => {
    const first = assign(baseInput);
    for (let i = 0; i < 1000; i++) {
      expect(assign(baseInput).bucket).toBe(first.bucket);
    }
  });

  it('routes different invoices to different buckets (not all one arm)', () => {
    const buckets = new Set<string>();
    for (let i = 0; i < 500; i++) {
      buckets.add(assign({ ...baseInput, invoiceId: `inv_${i}` }).bucket);
    }
    expect(buckets.has('control')).toBe(true);
    expect(buckets.has('treatment')).toBe(true);
  });

  it('approximately honors the control fraction over many units', () => {
    const config: HoldoutConfig = { ...DEFAULT_HOLDOUT_CONFIG, controlFraction: 0.1 };
    let control = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      if (assign({ ...baseInput, invoiceId: `inv_${i}` }, config).bucket === 'control') {
        control++;
      }
    }
    const observed = control / N;
    // Expect ~10% control; allow a generous tolerance for the finite sample.
    expect(observed).toBeGreaterThan(0.085);
    expect(observed).toBeLessThan(0.115);
  });

  it('changing the salt re-randomizes assignment', () => {
    const a = assign(baseInput, { controlFraction: 0.5, salt: 'salt-a' });
    const b = assign(baseInput, { controlFraction: 0.5, salt: 'salt-b' });
    // Not a hard guarantee for a single unit, but positions must differ.
    expect(a.position).not.toBe(b.position);
  });

  it('rejects an out-of-range control fraction', () => {
    expect(() => assign(baseInput, { controlFraction: 1, salt: 's' })).toThrow(RangeError);
    expect(() => assign(baseInput, { controlFraction: -0.1, salt: 's' })).toThrow(RangeError);
  });
});
