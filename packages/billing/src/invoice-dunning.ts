/**
 * Dunning for AX10M's OWN invoices (distinct from the merchant→customer card-update dunning).
 * Pure: given an invoice + a date, decide which reminder stage is due and render the email body.
 * Sending is the app layer's job (reusing the guardrail-gated comms transport).
 *
 * The cadence keys off the net-14 due date: an initial notice at issue, a reminder as the due
 * date nears, one on the due date, then escalating overdue notices as the 1.5%/mo finance charge
 * accrues. `invoiceDunningStage` returns only the MOST-ADVANCED eligible stage, so a sweep sends
 * one message per invoice per run — never the whole backlog at once.
 */

import type { Invoice } from './invoice.js';

export type InvoiceDunningStage = 'issued' | 'due_soon' | 'due_today' | 'overdue_1' | 'overdue_2' | 'final_notice';

const DAY_MS = 86_400_000;

/** Stage thresholds in days relative to the DUE date, most-advanced first. 'issued' is separate. */
const STAGE_THRESHOLDS: ReadonlyArray<{ stage: InvoiceDunningStage; daysFromDue: number }> = [
  { stage: 'final_notice', daysFromDue: 21 },
  { stage: 'overdue_2', daysFromDue: 10 },
  { stage: 'overdue_1', daysFromDue: 3 },
  { stage: 'due_today', daysFromDue: 0 },
  { stage: 'due_soon', daysFromDue: -3 },
];

/**
 * The most-advanced dunning stage due as-of `asOfIso` for an unpaid invoice, or null if it's
 * settled/void, malformed, or before its issue date. 'issued' fires from the issue date until
 * the due-soon window opens; the rest key off the net-14 due date.
 */
export function invoiceDunningStage(invoice: Invoice, asOfIso: string): InvoiceDunningStage | null {
  if (invoice.status === 'paid' || invoice.status === 'void') return null;
  const asOf = Date.parse(asOfIso);
  const due = Date.parse(invoice.dueAt);
  const issued = Date.parse(invoice.issuedAt);
  if (Number.isNaN(asOf) || Number.isNaN(due) || Number.isNaN(issued)) return null;
  if (asOf < issued) return null;
  for (const t of STAGE_THRESHOLDS) {
    if (asOf >= due + t.daysFromDue * DAY_MS) return t.stage;
  }
  return 'issued'; // issued, but before the due-soon window
}

export interface InvoiceEmail {
  subject: string;
  body: string;
}

function dollars(currency: string, minor: number): string {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

/**
 * Render the invoice email for a stage. Pass an invoice already advanced to the report date
 * (`invoiceAsOf`) so the finance charge + total are current. Every stage carries the amount, due
 * date, PO, remit-to, and the signed-statement proof hash (so AP can verify what they're paying).
 */
export function renderInvoiceEmail(invoice: Invoice, stage: InvoiceDunningStage): InvoiceEmail {
  const total = dollars(invoice.currency, invoice.totalDueMinor);
  const due = invoice.dueAt.slice(0, 10);
  const terms = invoice.feeScheduleSnapshot.paymentTermsDays;
  const feePct = Math.round(invoice.feeScheduleSnapshot.feeRate * 100);
  const poLine = invoice.poNumber ? `\nPO number: ${invoice.poNumber}` : '';
  const financeLine = invoice.financeChargeMinor > 0
    ? `\nLate finance charge included: ${dollars(invoice.currency, invoice.financeChargeMinor)} (1.5%/mo on the overdue balance)`
    : '';

  const detail = [
    ``,
    `Bill to:      ${invoice.billTo.legalEntityName}`,
    `Invoice:      ${invoice.invoiceNumber}`,
    `Period:       ${invoice.period}`,
    `Amount due:   ${total}${financeLine}`,
    `Due date:     ${due} (net-${terms})${poLine}`,
    `Remit to:     ${invoice.remitTo}`,
    ``,
    `This fee is ${feePct}% of the incremental recovery AX10M proved this period against your own`,
    `randomized holdout, backed by signed Uplift Statement ${invoice.statementHash} —`,
    `verifiable against your processor's payout reports.`,
  ].join('\n');

  const compose = (subject: string, intro: string): InvoiceEmail => ({ subject, body: `${intro}\n${detail}` });

  switch (stage) {
    case 'issued':
      return compose(`AX10M invoice ${invoice.invoiceNumber} — ${total} due ${due}`, `Your AX10M recovery-uplift invoice for ${invoice.period} is ready.`);
    case 'due_soon':
      return compose(`Reminder: AX10M invoice ${invoice.invoiceNumber} due ${due}`, `A reminder that your AX10M invoice for ${invoice.period} is due soon.`);
    case 'due_today':
      return compose(`AX10M invoice ${invoice.invoiceNumber} is due today`, `Your AX10M invoice for ${invoice.period} is due today.`);
    case 'overdue_1':
    case 'overdue_2':
      return compose(`Past due: AX10M invoice ${invoice.invoiceNumber}`, `Your AX10M invoice for ${invoice.period} is past due. A finance charge of 1.5%/month is now accruing on the overdue balance.`);
    case 'final_notice':
      return compose(`Final notice: AX10M invoice ${invoice.invoiceNumber}`, `This is a final notice: your AX10M invoice for ${invoice.period} remains unpaid and is significantly past due. Please remit payment or contact us to resolve.`);
  }
}
