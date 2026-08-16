import { describe, expect, it } from 'vitest';
import { buildBillingAccount, type OptInInput } from './account.js';
import { addDaysIso, buildInvoice, computeFinanceChargeMinor, invoiceAsOf, invoiceNumberFor, type StatementForInvoice } from './invoice.js';

const input: OptInInput = {
  merchantId: 'mrc_1',
  legalEntityName: 'Merchant Inc.',
  billingAddress: { line1: '1 Market St', city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'US' },
  apContactEmail: 'ap@merchant.com',
  poRequired: true,
  poNumber: 'PO-2026-042',
  payerTrack: 'invoice',
  signer: { name: 'Dana Lee', title: 'CFO', email: 'dana@merchant.com' },
};

const account = buildBillingAccount(input, 'acct_1', '2026-08-01T00:00:00.000Z');

// Statement: proven lower-bound uplift $1,000.00 → fee 12% = $120.00.
const statement: StatementForInvoice = {
  merchantId: 'mrc_1',
  period: '2026-07',
  currency: 'USD',
  feeMinor: 12_000,
  upliftLowerMinor: 100_000,
  statementHash: 'deadbeef',
  billable: true,
};

const ISSUED = '2026-08-01T00:00:00.000Z';

describe('buildInvoice', () => {
  const inv = buildInvoice({ account, statement, issuedAt: ISSUED, remitTo: 'ACH: routing 000, acct 111' });

  it('takes the fee verbatim from the signed statement and carries the proof hash', () => {
    expect(inv.subtotalMinor).toBe(12_000);
    expect(inv.totalDueMinor).toBe(12_000);
    expect(inv.financeChargeMinor).toBe(0);
    expect(inv.statementHash).toBe('deadbeef');
    expect(inv.lineItems[0]).toMatchObject({ upliftMeasuredMinor: 100_000, feeRate: 0.12, amountMinor: 12_000 });
    expect(inv.lineItems[0]!.description).toContain('12% of proven incremental recovery');
  });

  it('sets net-14 due date and routes to the AP contact + PO from the account', () => {
    expect(inv.invoiceNumber).toBe(invoiceNumberFor('mrc_1', '2026-07'));
    expect(inv.dueAt).toBe(addDaysIso(ISSUED, 14));
    expect(inv.dueAt).toBe('2026-08-15T00:00:00.000Z');
    expect(inv.poNumber).toBe('PO-2026-042');
    expect(inv.billTo.apContactEmail).toBe('ap@merchant.com');
    expect(inv.billTo.legalEntityName).toBe('Merchant Inc.');
    expect(inv.status).toBe('issued');
  });
});

describe('computeFinanceChargeMinor', () => {
  const inv = buildInvoice({ account, statement, issuedAt: ISSUED, remitTo: 'x' });

  it('is zero on or before the due date', () => {
    expect(computeFinanceChargeMinor(inv, inv.dueAt)).toBe(0);
    expect(computeFinanceChargeMinor(inv, ISSUED)).toBe(0);
  });

  it('accrues 1.5%/mo prorated on the overdue balance', () => {
    // 30 days past due → exactly one month → 1.5% of $120.00 = $1.80 (180 minor).
    const thirtyDaysLate = addDaysIso(inv.dueAt, 30);
    expect(computeFinanceChargeMinor(inv, thirtyDaysLate)).toBe(180);
    // 15 days past due → half a month → ~0.75% of $120.00 = $0.90 (90 minor).
    const fifteenDaysLate = addDaysIso(inv.dueAt, 15);
    expect(computeFinanceChargeMinor(inv, fifteenDaysLate)).toBe(90);
  });
});

describe('invoiceAsOf', () => {
  const inv = buildInvoice({ account, statement, issuedAt: ISSUED, remitTo: 'x' });

  it('rolls the finance charge into the total and flips status to overdue past due', () => {
    const late = addDaysIso(inv.dueAt, 30);
    const asOf = invoiceAsOf(inv, late);
    expect(asOf.financeChargeMinor).toBe(180);
    expect(asOf.totalDueMinor).toBe(12_180);
    expect(asOf.status).toBe('overdue');
  });

  it('leaves a paid invoice paid even when past due', () => {
    const late = addDaysIso(inv.dueAt, 30);
    const asOf = invoiceAsOf({ ...inv, status: 'paid' }, late);
    expect(asOf.status).toBe('paid');
    // finance charge still computed for reference, but the invoice is settled
    expect(asOf.financeChargeMinor).toBe(180);
  });
});
