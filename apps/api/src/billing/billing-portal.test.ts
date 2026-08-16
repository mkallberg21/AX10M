import { describe, expect, it } from 'vitest';
import { createEd25519Signer } from '@ax10m/attribution';
import { buildBillingAccount, buildInvoice, type OptInInput, type StatementForInvoice } from '@ax10m/billing';
import { InMemoryBillingAccountStore } from './billing-account-store.js';
import { BillingPortalService } from './billing-portal.service.js';

const REMIT = 'ACH: routing 000, acct 111';

function makePortal(): { portal: BillingPortalService; store: InMemoryBillingAccountStore } {
  const store = new InMemoryBillingAccountStore();
  const { signer } = createEd25519Signer('test');
  return { portal: new BillingPortalService(store, signer, REMIT), store };
}

function optInInput(overrides: Partial<OptInInput> = {}): OptInInput {
  return {
    merchantId: 'mrc_1',
    legalEntityName: 'Merchant Inc.',
    billingAddress: { line1: '1 Market St', city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'US' },
    apContactEmail: 'ap@merchant.com',
    poRequired: false,
    payerTrack: 'auto_pay',
    paymentMethodRef: 'pm_abc123',
    signer: { name: 'Dana Lee', title: 'CFO', email: 'dana@merchant.com' },
    autoPayAuthorized: true,
    ...overrides,
  };
}

describe('BillingPortalService.terms', () => {
  it('returns the current terms with the 12% / net-14 / 1.5%/mo fee schedule and a body', () => {
    const { portal } = makePortal();
    const t = portal.terms();
    expect(t.feeSchedule).toEqual({ feeRate: 0.12, currency: 'USD', paymentTermsDays: 14, lateFinanceChargeMonthlyRate: 0.015 });
    expect(t.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.body).toContain('12%');
  });
});

describe('BillingPortalService.optIn', () => {
  it('persists the account + a signed acceptance and never echoes the payment token', async () => {
    const { portal, store } = makePortal();
    const res = await portal.optIn(optInInput(), { ip: '203.0.113.7', userAgent: 'UA', nowIso: '2026-08-16T12:00:00.000Z' });

    expect(res.account.merchantId).toBe('mrc_1');
    expect(res.account.hasPaymentMethod).toBe(true);
    expect((res.account as Record<string, unknown>).paymentMethodRef).toBeUndefined(); // token never returned
    expect(res.acceptance.recordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.acceptance.payerTrack).toBe('auto_pay');

    // stored + bound to the signer key
    const stored = await store.accountForMerchant('mrc_1');
    expect(stored?.paymentMethodRef).toBe('pm_abc123'); // token IS persisted (server-side)
    const accs = await store.acceptancesForAccount('acct_mrc_1');
    expect(accs).toHaveLength(1);
    expect(accs[0]!.ip).toBe('203.0.113.7');
    expect(accs[0]!.autoPayAuthorized).toBe(true);
  });

  it('rejects an invalid submission with the field errors', async () => {
    const { portal } = makePortal();
    await expect(portal.optIn(optInInput({ apContactEmail: 'nope', autoPayAuthorized: false }), {})).rejects.toMatchObject({
      response: { message: 'invalid opt-in', errors: expect.arrayContaining(['apContactEmail is not a valid email', 'autoPayAuthorized must be true to enroll in auto-pay']) },
    });
  });

  it('re-opt-in appends a second acceptance record (a fresh signed agreement)', async () => {
    const { portal, store } = makePortal();
    await portal.optIn(optInInput(), { nowIso: '2026-08-16T12:00:00.000Z' });
    await portal.optIn(optInInput({ payerTrack: 'invoice', paymentMethodRef: undefined, autoPayAuthorized: undefined }), { nowIso: '2026-09-16T12:00:00.000Z' });
    expect(await store.acceptancesForAccount('acct_mrc_1')).toHaveLength(2);
    expect((await store.accountForMerchant('mrc_1'))?.payerTrack).toBe('invoice'); // account updated to latest
  });
});

describe('BillingPortalService invoices + forward-to-AP', () => {
  const statement: StatementForInvoice = { merchantId: 'mrc_1', period: '2026-07', currency: 'USD', feeMinor: 12_000, upliftLowerMinor: 100_000, statementHash: 'deadbeef', billable: true };

  async function seedInvoice(store: InMemoryBillingAccountStore, issuedAt: string): Promise<string> {
    const account = buildBillingAccount(optInInput({ poRequired: true, poNumber: 'PO-42', payerTrack: 'invoice', paymentMethodRef: undefined, autoPayAuthorized: undefined }), 'acct_mrc_1', issuedAt);
    await store.upsertAccount(account);
    const inv = buildInvoice({ account, statement, issuedAt, remitTo: REMIT });
    await store.upsertInvoice(inv);
    return inv.invoiceNumber;
  }

  it('recomputes the finance charge as-of now when listing/fetching invoices', async () => {
    const { portal, store } = makePortal();
    const number = await seedInvoice(store, '2026-08-01T00:00:00.000Z'); // due 2026-08-15
    // As-of 30 days past due → 1.5% of $120 = $1.80 finance charge, status overdue.
    const inv = await portal.invoice(number, '2026-09-14T00:00:00.000Z');
    expect(inv.financeChargeMinor).toBe(180);
    expect(inv.totalDueMinor).toBe(12_180);
    expect(inv.status).toBe('overdue');
  });

  it('composes a forward to the AP inbox with the amount, PO, due date, and proof hash', async () => {
    const { portal, store } = makePortal();
    const number = await seedInvoice(store, '2026-08-01T00:00:00.000Z');
    const fwd = await portal.forwardToAp(number, '2026-08-10T00:00:00.000Z');
    expect(fwd.to).toBe('ap@merchant.com');
    expect(fwd.composedOnly).toBe(true);
    expect(fwd.subject).toContain('USD 120.00');
    expect(fwd.body).toContain('PO-42');
    expect(fwd.body).toContain('deadbeef'); // the statement proof hash
  });

  it('404s an unknown invoice/merchant', async () => {
    const { portal } = makePortal();
    await expect(portal.invoice('AX-nope-2026-01')).rejects.toThrow(/no invoice/);
    await expect(portal.accountFor('mrc_unknown')).rejects.toThrow(/no billing account/);
  });
});
