import { describe, expect, it } from 'vitest';
import { DeclineCode } from '@ax10m/canonical';
import {
  betaFromMeanStrength,
  BinRegionIndex,
  DEFAULT_FEATURE_STORE_CONFIG,
  RecoveryFeatureStore,
  shrinkRate,
} from './feature-store.js';
import { mulberry32 } from './training.js';

describe('Beta shrinkage', () => {
  it('returns the prior mean with no evidence and the empirical rate with lots', () => {
    const prior = betaFromMeanStrength(0.35, 8);
    expect(shrinkRate(0, 0, prior)).toBeCloseTo(0.35, 6); // cold start = prior
    expect(shrinkRate(700, 1000, prior)).toBeCloseTo(0.702, 2); // ~empirical 0.70
  });

  it('never divides by zero and stays in [0,1]', () => {
    const prior = betaFromMeanStrength(0.5, 10);
    const r = shrinkRate(0, 0, prior);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });
});

describe('BIN → region', () => {
  it('longest-prefix match wins, unknown otherwise', () => {
    const idx = BinRegionIndex.from([
      { prefix: '4', region: 'na' },
      { prefix: '4291', region: 'emea' },
    ]);
    expect(idx.region('429145')).toBe('emea'); // more specific
    expect(idx.region('411111')).toBe('na');
    expect(idx.region('9999')).toBe('unknown');
    expect(idx.region(undefined)).toBe('unknown');
  });

  it('lookup returns the joined issuer/country/brand/card signals', () => {
    const idx = BinRegionIndex.from([
      { prefix: '5', region: 'na', brand: 'mastercard' },
      { prefix: '5310', region: 'emea', brand: 'mastercard', country: 'DE', issuerId: 'db', cardType: 'debit' },
    ]);
    expect(idx.lookup('531055')).toEqual({ region: 'emea', brand: 'mastercard', country: 'DE', issuerId: 'db', cardType: 'debit' });
    expect(idx.lookup('511111')).toEqual({ region: 'na', brand: 'mastercard' });
    expect(idx.lookup('9')).toEqual({ region: 'unknown' });
  });
});

describe('joined issuer/customer signals', () => {
  // Two different BINs owned by the SAME issuer → one shared approval rate.
  const twoBinIssuer = BinRegionIndex.from([
    { prefix: '4111', region: 'na', issuerId: 'acme' },
    { prefix: '4222', region: 'emea', issuerId: 'acme' },
  ]);

  it('aggregates the issuer approval prior by real issuer identity across its BINs', () => {
    const store = new RecoveryFeatureStore({ ...DEFAULT_FEATURE_STORE_CONFIG, regionIndex: twoBinIssuer });
    // Failures recorded on BIN #1 of the issuer…
    for (let i = 0; i < 20; i++) store.recordOutcome({ merchantId: 'm', customerId: `c${i}`, bin: '411100', recovered: false });
    // …lower the approval prior seen for a DIFFERENT BIN of the same issuer.
    const f = store.enrich(ctx({ customerId: 'new', bin: '422200' }));
    expect(f.issuerApprovalPrior).toBeLessThan(0.4); // learned the issuer declines retries
    expect(store.issuerStats('422200')?.total).toBe(20); // same aggregate via either BIN
  });

  it('uses the REAL customer signup date for tenure when provided', () => {
    const store = new RecoveryFeatureStore();
    const f = store.enrich(ctx({ customerCreatedAt: '2025-08-14T12:00:00.000Z' })); // ~1 year before now
    expect(f.customerTenureDays).toBeGreaterThan(360);
    expect(f.customerTenureDays).toBeLessThan(370);
  });

  it('observe() stamps the signup date so later decisions get real tenure without re-passing it', () => {
    const store = new RecoveryFeatureStore();
    store.observe({ merchantId: 'mrc_1', customerId: 'cus_1', now: '2026-08-14T12:00:00.000Z', customerCreatedAt: '2024-08-14T12:00:00.000Z' });
    const f = store.enrich(ctx()); // no customerCreatedAt on this call → uses the stamped one
    expect(f.customerTenureDays).toBeGreaterThan(720); // ~2 years
  });
});

const ctx = (over: Partial<Parameters<RecoveryFeatureStore['enrich']>[0]> = {}) => ({
  merchantId: 'mrc_1',
  customerId: 'cus_1',
  declineCode: DeclineCode.InsufficientFunds,
  amountMinor: 5000,
  currency: 'USD',
  attemptNumber: 1,
  now: '2026-08-14T12:00:00.000Z',
  ...over,
});

describe('RecoveryFeatureStore enrichment', () => {
  it('cold start returns prior-mean signals', () => {
    const store = new RecoveryFeatureStore();
    const f = store.enrich(ctx());
    expect(f.priorRecoveryRate).toBeCloseTo(0.35, 2);
    expect(f.issuerApprovalPrior).toBeCloseTo(0.5, 2); // no bin → prior
    expect(f.issuerRegion).toBe('unknown');
  });

  it('the flywheel: a customer whose failures usually recover gets a rising priorRecoveryRate', () => {
    const store = new RecoveryFeatureStore();
    const rng = mulberry32(1);
    const trueRate = 0.75;
    for (let i = 0; i < 400; i++) {
      store.recordOutcome({ merchantId: 'mrc_1', customerId: 'cus_1', recovered: rng() < trueRate });
    }
    const f = store.enrich(ctx());
    expect(f.priorRecoveryRate).toBeGreaterThan(0.65);
    expect(f.priorRecoveryRate).toBeLessThan(0.85);
  });

  it('learns a per-issuer approval prior from BIN outcomes', () => {
    const store = new RecoveryFeatureStore();
    const rng = mulberry32(2);
    for (let i = 0; i < 300; i++) {
      store.recordOutcome({ merchantId: 'mrc_1', customerId: `c${i}`, bin: '424242', recovered: rng() < 0.2 });
    }
    const f = store.enrich(ctx({ bin: '424242' }));
    expect(f.issuerApprovalPrior).toBeLessThan(0.35); // learned a stingy issuer
    expect(f.issuerRegion).toBe('emea'); // 42 → emea in the default table
  });

  it('is leakage-free: the current case is not in its own features', () => {
    const store = new RecoveryFeatureStore();
    // Enrich BEFORE recording — the store has zero history for this customer.
    const before = store.enrich(ctx());
    store.recordOutcome({ merchantId: 'mrc_1', customerId: 'cus_1', recovered: true });
    const after = store.enrich(ctx());
    expect(before.priorRecoveryRate).toBeCloseTo(0.35, 3); // pure prior, no self-influence
    expect(after.priorRecoveryRate).toBeGreaterThan(before.priorRecoveryRate); // now reflects the recorded win
  });

  it('computes tenure from first contact and daysSinceFirstFail from the invoice', () => {
    const store = new RecoveryFeatureStore();
    store.observe({ merchantId: 'mrc_1', customerId: 'cus_1', now: '2026-06-15T12:00:00.000Z' });
    const f = store.enrich(ctx({ firstFailedAt: '2026-08-10T12:00:00.000Z' }));
    expect(f.customerTenureDays).toBeGreaterThan(59); // ~60 days since first seen
    expect(f.customerTenureDays).toBeLessThan(62);
    expect(f.daysSinceFirstFail).toBeCloseTo(4, 0);
  });

  it('prefers an explicit customerCreatedAt for tenure when provided', () => {
    const store = new RecoveryFeatureStore();
    const f = store.enrich(ctx({ customerCreatedAt: '2024-08-14T12:00:00.000Z' }));
    expect(f.customerTenureDays).toBeGreaterThan(720); // ~2 years
  });

  it('exposes observability stats', () => {
    const store = new RecoveryFeatureStore(DEFAULT_FEATURE_STORE_CONFIG);
    store.recordOutcome({ merchantId: 'mrc_1', customerId: 'cus_1', bin: '511111', recovered: true });
    store.recordOutcome({ merchantId: 'mrc_1', customerId: 'cus_1', bin: '511111', recovered: false });
    expect(store.customerStats('mrc_1', 'cus_1')!.total).toBe(2);
    expect(store.issuerStats('511111')!.total).toBe(2);
    expect(store.customerStats('mrc_1', 'nope')).toBeUndefined();
  });
});
