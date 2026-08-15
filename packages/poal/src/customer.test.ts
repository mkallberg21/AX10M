import { describe, it, expect } from 'vitest';
import { toE164, contactOverrides, customerFromInvoice } from './customer.js';
import type { Invoice } from '@ax10m/canonical';

describe('toE164', () => {
  it('keeps well-formed international numbers, stripping formatting', () => {
    expect(toE164('+15555550123')).toBe('+15555550123');
    expect(toE164('+1 (555) 555-0123')).toBe('+15555550123');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
  });
  it('rewrites a 00 international access code to +', () => {
    expect(toE164('0044 20 7946 0958')).toBe('+442079460958');
  });
  it('drops national-only numbers (not safely dialable without a country code)', () => {
    expect(toE164('5555550123')).toBeUndefined();
    expect(toE164('(555) 555-0123')).toBeUndefined();
  });
  it('drops empties and out-of-range lengths', () => {
    expect(toE164(undefined)).toBeUndefined();
    expect(toE164('')).toBeUndefined();
    expect(toE164('+1234567')).toBeUndefined(); // 7 digits < 8
    expect(toE164('+1234567890123456')).toBeUndefined(); // 16 digits > 15
  });
});

describe('contactOverrides', () => {
  it('drops empty email and un-normalizable phone, keeps valid ones', () => {
    expect(contactOverrides('a@b.test', '+15555550123')).toEqual({ email: 'a@b.test', phone: '+15555550123' });
    expect(contactOverrides('a@b.test', '5555550123')).toEqual({ email: 'a@b.test' }); // national phone dropped
    expect(contactOverrides('', '')).toEqual({});
    expect(contactOverrides(undefined, undefined)).toEqual({});
  });
  it('flows into customerFromInvoice as overrides', () => {
    const invoice: Invoice = { id: 'ax10m_inv_1', customerId: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'in_1', amount: { amount: 100, currency: 'USD' }, status: 'open', createdAt: '2026-08-15T00:00:00.000Z' };
    const c = customerFromInvoice(invoice, contactOverrides('dana@example.test', '+15555550123'));
    expect(c.email).toBe('dana@example.test');
    expect(c.phone).toBe('+15555550123');
    expect(c.processorRef).toBe('c1'); // prefix stripped, unchanged behavior
  });
});
