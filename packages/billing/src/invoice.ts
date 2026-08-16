/**
 * The human-facing invoice, derived from a signed monthly Uplift Statement + a BillingAccount.
 *
 * Two things make this AX10M's invoice rather than a generic one:
 *  - PROOF: it carries the statement hash, so AP can tie the amount to the signed, independently-
 *    verifiable measurement of the uplift they're being billed 12% of.
 *  - AP-ROUTING: it carries the bill-to legal entity, PO number, and the AP contact captured at
 *    opt-in, so the invoice can be auto-delivered to accounts payable (no manual forwarding).
 *
 * Finance-charge math is pure and as-of a date (the caller decides when the clock stops — the
 * payment date), so it never depends on the wall clock.
 */

import type { CurrencyCode, MinorUnits } from '@ax10m/canonical';
import type { BillingAccount, FeeSchedule, PostalAddress } from './account.js';

const DAY_MS = 86_400_000;

/** Add whole days to an ISO timestamp. Deterministic (numeric date math). */
export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

export interface InvoiceLineItem {
  description: string;
  /** Proven lower-bound incremental recovery this period (minor units) — the fee basis. */
  upliftMeasuredMinor: MinorUnits;
  feeRate: number;
  /** The fee for this line (minor units) — taken from the signed statement, not recomputed. */
  amountMinor: MinorUnits;
}

export type InvoiceStatus = 'issued' | 'overdue' | 'paid' | 'void';

export interface Invoice {
  /** Deterministic, one-per-merchant-per-period: AX-<merchant>-<period>. */
  invoiceNumber: string;
  accountId: string;
  merchantId: string;
  period: string; // YYYY-MM
  issuedAt: string;
  dueAt: string; // issuedAt + paymentTermsDays
  currency: CurrencyCode;
  lineItems: InvoiceLineItem[];
  subtotalMinor: MinorUnits;
  /** Finance charge accrued as-of the report date (0 at issue / before due). */
  financeChargeMinor: MinorUnits;
  totalDueMinor: MinorUnits;
  poNumber?: string;
  /** AX10M's remittance details (bank / pay-link), supplied by config. */
  remitTo: string;
  billTo: {
    legalEntityName: string;
    address: PostalAddress;
    apContactEmail: string;
  };
  /** Proof: ties the invoice to the signed Uplift Statement backing the amount. */
  statementHash: string;
  /** Snapshot of the fee schedule this invoice was issued under. */
  feeScheduleSnapshot: FeeSchedule;
  status: InvoiceStatus;
}

/** The subset of a signed Uplift Statement an invoice needs — keeps this package app-decoupled. */
export interface StatementForInvoice {
  merchantId: string;
  period: string; // YYYY-MM
  currency: CurrencyCode;
  /** The billable fee (12% of proven uplift), minor units. */
  feeMinor: MinorUnits;
  /** The proven lower-bound incremental recovery this period (fee basis), minor units. */
  upliftLowerMinor: MinorUnits;
  statementHash: string;
  billable: boolean;
}

/** Deterministic invoice number, unique per merchant per period. */
export function invoiceNumberFor(merchantId: string, period: string): string {
  return `AX-${merchantId}-${period}`.toUpperCase().replace(/[^A-Z0-9-]/g, '-');
}

/**
 * Build the invoice for a period from the account + its signed statement. Pure given `issuedAt`.
 * The amount is taken verbatim from the statement's `feeMinor` (never recomputed) so the invoice
 * total always equals the signed, provable fee.
 */
export function buildInvoice(params: {
  account: BillingAccount;
  statement: StatementForInvoice;
  issuedAt: string;
  remitTo: string;
}): Invoice {
  const { account, statement, issuedAt, remitTo } = params;
  const fs = account.feeSchedule;
  const line: InvoiceLineItem = {
    description: `AX10M recovery uplift fee — ${statement.period} (${Math.round(fs.feeRate * 100)}% of proven incremental recovery)`,
    upliftMeasuredMinor: statement.upliftLowerMinor,
    feeRate: fs.feeRate,
    amountMinor: statement.feeMinor,
  };
  const subtotal = statement.feeMinor;
  return {
    invoiceNumber: invoiceNumberFor(statement.merchantId, statement.period),
    accountId: account.accountId,
    merchantId: account.merchantId,
    period: statement.period,
    issuedAt,
    dueAt: addDaysIso(issuedAt, fs.paymentTermsDays),
    currency: statement.currency,
    lineItems: [line],
    subtotalMinor: subtotal,
    financeChargeMinor: 0,
    totalDueMinor: subtotal,
    poNumber: account.poNumber,
    remitTo,
    billTo: {
      legalEntityName: account.legalEntityName,
      address: account.billingAddress,
      apContactEmail: account.apContactEmail,
    },
    statementHash: statement.statementHash,
    feeScheduleSnapshot: fs,
    status: 'issued',
  };
}

/**
 * Finance charge accrued on an unpaid invoice as-of `asOfIso`. Zero until the due date; after
 * that, monthlyRate × subtotal × (daysOverdue / 30) — simple (non-compounding) proration. The
 * charge is on the overdue balance; the fee rate itself never changes. Pure.
 */
export function computeFinanceChargeMinor(invoice: Invoice, asOfIso: string): number {
  const due = Date.parse(invoice.dueAt);
  const asOf = Date.parse(asOfIso);
  if (Number.isNaN(due) || Number.isNaN(asOf) || asOf <= due) return 0;
  const daysOverdue = (asOf - due) / DAY_MS;
  const monthsOverdue = daysOverdue / 30;
  const rate = invoice.feeScheduleSnapshot.lateFinanceChargeMonthlyRate;
  return Math.max(0, Math.round(invoice.subtotalMinor * rate * monthsOverdue));
}

/**
 * Return the invoice with its finance charge + total recomputed as-of a date, and status moved to
 * 'overdue' if past due (a 'paid'/'void' invoice keeps its status). Non-mutating.
 */
export function invoiceAsOf(invoice: Invoice, asOfIso: string): Invoice {
  const financeChargeMinor = computeFinanceChargeMinor(invoice, asOfIso);
  const pastDue = Date.parse(asOfIso) > Date.parse(invoice.dueAt);
  const status: InvoiceStatus =
    invoice.status === 'paid' || invoice.status === 'void' ? invoice.status : pastDue ? 'overdue' : invoice.status;
  return { ...invoice, financeChargeMinor, totalDueMinor: invoice.subtotalMinor + financeChargeMinor, status };
}
