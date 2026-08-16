import { describe, expect, it } from 'vitest';
import { createEd25519Signer } from '@ax10m/attribution';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { buildBillingAccount, type OptInInput } from './account.js';
import { acceptanceHashMatches, buildAcceptance, signAcceptance, type AcceptanceRecord } from './acceptance.js';
import { currentTerms } from './terms.js';

const input: OptInInput = {
  merchantId: 'mrc_1',
  legalEntityName: 'Merchant Inc.',
  billingAddress: { line1: '1 Market St', city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'US' },
  apContactEmail: 'ap@merchant.com',
  poRequired: false,
  payerTrack: 'auto_pay',
  paymentMethodRef: 'pm_abc123',
  signer: { name: 'Dana Lee', title: 'CFO', email: 'dana@merchant.com' },
  autoPayAuthorized: true,
};

const account = buildBillingAccount(input, 'acct_1', '2026-08-16T00:00:00.000Z');

describe('buildAcceptance', () => {
  const { signer } = createEd25519Signer('test');

  it('binds the account, terms version + hash, fee snapshot, and signer into a signed record', () => {
    const terms = currentTerms();
    const rec = buildAcceptance({ account, acceptedBy: input.signer, acceptedAt: '2026-08-16T12:00:00.000Z', autoPayAuthorized: true, signer, ip: '203.0.113.7', userAgent: 'Mozilla/5.0' });
    expect(rec).toMatchObject({
      accountId: 'acct_1',
      merchantId: 'mrc_1',
      termsVersion: terms.version,
      termsHash: terms.bodyHash,
      payerTrack: 'auto_pay',
      autoPayAuthorized: true,
      acceptedBy: input.signer,
      ip: '203.0.113.7',
    });
    expect(rec.feeSchedule).toEqual(account.feeSchedule);
    expect(rec.signature).toMatch(/^[0-9a-f]+$/);
    expect(acceptanceHashMatches(rec)).toBe(true);
  });

  it('produces a signature that verifies against the published public key', () => {
    const { signer: s, publicKeyPem } = createEd25519Signer('test2');
    const rec = buildAcceptance({ account, acceptedBy: input.signer, acceptedAt: '2026-08-16T12:00:00.000Z', autoPayAuthorized: true, signer: s });
    const ok = edVerify(null, Buffer.from(rec.recordHash), createPublicKey(publicKeyPem), Buffer.from(rec.signature, 'hex'));
    expect(ok).toBe(true);
  });

  it('detects tampering: any change to the record breaks the hash', () => {
    const rec = buildAcceptance({ account, acceptedBy: input.signer, acceptedAt: '2026-08-16T12:00:00.000Z', autoPayAuthorized: true, signer });
    const tampered = { ...rec, feeSchedule: { ...rec.feeSchedule, feeRate: 0.05 } }; // sneak the rate down
    expect(acceptanceHashMatches(tampered)).toBe(false);
  });
});

describe('signAcceptance', () => {
  const { signer } = createEd25519Signer('test');

  it('is deterministic: the same record signs to the same hash regardless of key insertion order', () => {
    const record: AcceptanceRecord = {
      accountId: 'a', merchantId: 'm', termsVersion: 'v1', termsHash: 'abc', feeSchedule: account.feeSchedule,
      payerTrack: 'invoice', autoPayAuthorized: false, acceptedBy: input.signer, acceptedAt: '2026-08-16T12:00:00.000Z',
    };
    const a = signAcceptance(record, signer);
    // Rebuild with keys in a different order — canonical JSON must hash identically.
    const reordered: AcceptanceRecord = { acceptedAt: record.acceptedAt, feeSchedule: record.feeSchedule, merchantId: 'm', accountId: 'a', termsHash: 'abc', termsVersion: 'v1', autoPayAuthorized: false, acceptedBy: input.signer, payerTrack: 'invoice' };
    const b = signAcceptance(reordered, signer);
    expect(a.recordHash).toBe(b.recordHash);
  });
});
