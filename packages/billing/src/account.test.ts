import { describe, expect, it } from 'vitest';
import { buildBillingAccount, DEFAULT_FEE_SCHEDULE, looksLikePan, validateOptIn, type OptInInput } from './account.js';

const baseAddress = { line1: '1 Market St', city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'US' };
const baseSigner = { name: 'Dana Lee', title: 'CFO', email: 'dana@merchant.com' };

function validInput(overrides: Partial<OptInInput> = {}): OptInInput {
  return {
    merchantId: 'mrc_1',
    legalEntityName: 'Merchant Inc.',
    billingAddress: baseAddress,
    apContactEmail: 'ap@merchant.com',
    poRequired: false,
    payerTrack: 'auto_pay',
    paymentMethodRef: 'pm_abc123',
    signer: baseSigner,
    autoPayAuthorized: true,
    ...overrides,
  };
}

describe('validateOptIn', () => {
  it('accepts a complete auto-pay submission', () => {
    expect(validateOptIn(validInput())).toEqual([]);
  });

  it('accepts a complete invoice-track submission with no payment method', () => {
    expect(validateOptIn(validInput({ payerTrack: 'invoice', paymentMethodRef: undefined, autoPayAuthorized: undefined }))).toEqual([]);
  });

  it('requires a payment method AND explicit authorization on the auto_pay track', () => {
    const errs = validateOptIn(validInput({ paymentMethodRef: undefined, autoPayAuthorized: false }));
    expect(errs).toContain('paymentMethodRef is required on the auto_pay track');
    expect(errs).toContain('autoPayAuthorized must be true to enroll in auto-pay');
  });

  it('requires a PO number when poRequired is true', () => {
    expect(validateOptIn(validInput({ poRequired: true }))).toContain('poNumber is required when poRequired is true');
    expect(validateOptIn(validInput({ poRequired: true, poNumber: 'PO-42' }))).toEqual([]);
  });

  it('flags an invalid AP email and a bad country code', () => {
    const errs = validateOptIn(validInput({ apContactEmail: 'not-an-email', billingAddress: { ...baseAddress, country: 'USA' } }));
    expect(errs).toContain('apContactEmail is not a valid email');
    expect(errs).toContain('billingAddress.country must be a 2-letter ISO code');
  });

  it('rejects a card number in any stored field (no-PAN rule)', () => {
    expect(validateOptIn(validInput({ paymentMethodRef: '4242 4242 4242 4242' }))).toContain(
      'paymentMethodRef looks like a card number — pass an opaque processor token, never a PAN',
    );
    expect(validateOptIn(validInput({ taxId: '4111111111111111' }))).toContain('taxId looks like a card number');
  });
});

describe('looksLikePan', () => {
  it('detects 13-19 digit card shapes, ignores short/long numbers', () => {
    expect(looksLikePan('4242424242424242')).toBe(true);
    expect(looksLikePan('4242-4242-4242-4242')).toBe(true);
    expect(looksLikePan('EIN 12-3456789')).toBe(false); // 9 digits
    expect(looksLikePan('pm_1a2b3c')).toBe(false);
    expect(looksLikePan(undefined)).toBe(false);
  });
});

describe('buildBillingAccount', () => {
  it('builds an active account, defaulting the fee schedule to 12% net-14 + 1.5%/mo', () => {
    const acct = buildBillingAccount(validInput(), 'acct_1', '2026-08-16T00:00:00.000Z');
    expect(acct).toMatchObject({ accountId: 'acct_1', merchantId: 'mrc_1', status: 'active', payerTrack: 'auto_pay', paymentMethodRef: 'pm_abc123' });
    expect(acct.feeSchedule).toEqual(DEFAULT_FEE_SCHEDULE);
    expect(DEFAULT_FEE_SCHEDULE).toEqual({ feeRate: 0.12, currency: 'USD', paymentTermsDays: 14, lateFinanceChargeMonthlyRate: 0.015 });
  });

  it('drops the payment method on the invoice track', () => {
    const acct = buildBillingAccount(validInput({ payerTrack: 'invoice', autoPayAuthorized: undefined }), 'acct_2', '2026-08-16T00:00:00.000Z');
    expect(acct.paymentMethodRef).toBeUndefined();
  });

  it('throws on an invalid submission', () => {
    expect(() => buildBillingAccount(validInput({ legalEntityName: '' }), 'acct_3', '2026-08-16T00:00:00.000Z')).toThrow(/invalid opt-in/);
  });
});
