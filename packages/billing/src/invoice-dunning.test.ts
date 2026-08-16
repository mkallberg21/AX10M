import { describe, expect, it } from 'vitest';
import { buildBillingAccount, type OptInInput } from './account.js';
import { addDaysIso, buildInvoice, invoiceAsOf, type StatementForInvoice } from './invoice.js';
import { invoiceDunningStage, renderInvoiceEmail } from './invoice-dunning.js';

const input: OptInInput = {
  merchantId: 'mrc_1',
  legalEntityName: 'Merchant Inc.',
  billingAddress: { line1: '1 Market St', city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'US' },
  apContactEmail: 'ap@merchant.com',
  poRequired: true,
  poNumber: 'PO-42',
  payerTrack: 'invoice',
  signer: { name: 'Dana Lee', title: 'CFO', email: 'dana@merchant.com' },
};
const account = buildBillingAccount(input, 'acct_1', '2026-08-01T00:00:00.000Z');
const statement: StatementForInvoice = { merchantId: 'mrc_1', period: '2026-07', currency: 'USD', feeMinor: 12_000, upliftLowerMinor: 100_000, statementHash: 'deadbeef', billable: true };
const ISSUED = '2026-08-01T00:00:00.000Z';
const inv = buildInvoice({ account, statement, issuedAt: ISSUED, remitTo: 'ACH x' }); // due 2026-08-15

describe('invoiceDunningStage', () => {
  it('walks issued → due_soon → due_today → overdue → final as the due date passes', () => {
    expect(invoiceDunningStage(inv, ISSUED)).toBe('issued'); // at issue
    expect(invoiceDunningStage(inv, addDaysIso(inv.dueAt, -5))).toBe('issued'); // 5d before due
    expect(invoiceDunningStage(inv, addDaysIso(inv.dueAt, -3))).toBe('due_soon');
    expect(invoiceDunningStage(inv, inv.dueAt)).toBe('due_today');
    expect(invoiceDunningStage(inv, addDaysIso(inv.dueAt, 3))).toBe('overdue_1');
    expect(invoiceDunningStage(inv, addDaysIso(inv.dueAt, 10))).toBe('overdue_2');
    expect(invoiceDunningStage(inv, addDaysIso(inv.dueAt, 21))).toBe('final_notice');
  });

  it('returns null for a settled or void invoice, and before the issue date', () => {
    expect(invoiceDunningStage({ ...inv, status: 'paid' }, addDaysIso(inv.dueAt, 30))).toBeNull();
    expect(invoiceDunningStage({ ...inv, status: 'void' }, addDaysIso(inv.dueAt, 30))).toBeNull();
    expect(invoiceDunningStage(inv, '2026-07-01T00:00:00.000Z')).toBeNull(); // before issue
  });
});

describe('renderInvoiceEmail', () => {
  it('the issued notice carries amount, PO, due date, and the proof hash', () => {
    const email = renderInvoiceEmail(inv, 'issued');
    expect(email.subject).toContain(inv.invoiceNumber);
    expect(email.subject).toContain('USD 120.00');
    expect(email.body).toContain('PO-42');
    expect(email.body).toContain('deadbeef');
    expect(email.body).toContain('net-14');
    expect(email.body).not.toMatch(/finance charge included/i); // not overdue yet
  });

  it('an overdue notice surfaces the accrued finance charge and the higher total', () => {
    const late = addDaysIso(inv.dueAt, 30); // 1.5% of $120 = $1.80 → total $121.80
    const asOf = invoiceAsOf(inv, late);
    expect(asOf.status).toBe('overdue');
    const email = renderInvoiceEmail(asOf, 'overdue_2');
    expect(email.subject).toContain('Past due');
    expect(email.body).toContain('USD 121.80');
    expect(email.body).toContain('Late finance charge included: USD 1.80');
  });
});
