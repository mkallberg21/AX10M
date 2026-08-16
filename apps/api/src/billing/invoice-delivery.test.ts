import { describe, expect, it } from 'vitest';
import { buildBillingAccount, buildInvoice, addDaysIso, type OptInInput, type StatementForInvoice } from '@ax10m/billing';
import { InMemorySendDedupeStore, type DunningMessage, type DunningRecipient, type DunningSender, type SendResult } from '@ax10m/comms';
import { InvoiceDeliveryService } from './invoice-delivery.service.js';

/** Records every send; returns a configurable status (default 'sent'). */
class SpySender implements DunningSender {
  readonly calls: Array<{ message: DunningMessage; recipient: DunningRecipient }> = [];
  constructor(private readonly status: SendResult['status'] = 'sent') {}
  async send(message: DunningMessage, recipient: DunningRecipient): Promise<SendResult> {
    this.calls.push({ message, recipient });
    return { status: this.status, channel: 'email', provider: 'spy', providerMessageId: 'msg_1' };
  }
}

const input: OptInInput = {
  merchantId: 'mrc_1',
  legalEntityName: 'Merchant Inc.',
  billingAddress: { line1: '1 Market St', city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'US' },
  apContactEmail: 'ap@merchant.com',
  poRequired: false,
  payerTrack: 'invoice',
  signer: { name: 'Dana Lee', title: 'CFO', email: 'dana@merchant.com' },
};
const account = buildBillingAccount(input, 'acct_1', '2026-08-01T00:00:00.000Z');
const statement: StatementForInvoice = { merchantId: 'mrc_1', period: '2026-07', currency: 'USD', feeMinor: 12_000, upliftLowerMinor: 100_000, statementHash: 'deadbeef', billable: true };
const ISSUED = '2026-08-01T00:00:00.000Z';
const invoice = buildInvoice({ account, statement, issuedAt: ISSUED, remitTo: 'ACH x' }); // due 2026-08-15

describe('InvoiceDeliveryService', () => {
  it('sends to the AP inbox when live and a provider is wired, and dedupes a re-send', async () => {
    const sender = new SpySender('sent');
    const svc = new InvoiceDeliveryService({ sender, live: true, dedupe: new InMemorySendDedupeStore() });

    const first = await svc.deliverStage(invoice, 'issued', ISSUED);
    expect(first.status).toBe('sent');
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]!.recipient.email).toBe('ap@merchant.com');
    expect(sender.calls[0]!.message.subject).toContain(invoice.invoiceNumber);

    // Same invoice+stage again → deduped, no second send.
    const again = await svc.deliverStage(invoice, 'issued', ISSUED);
    expect(again.status).toBe('duplicate');
    expect(sender.calls).toHaveLength(1);

    // A different stage is a distinct key → sends.
    const overdue = await svc.deliverStage(invoice, 'overdue_1', addDaysIso(invoice.dueAt, 3));
    expect(overdue.status).toBe('sent');
    expect(sender.calls).toHaveLength(2);
  });

  it('is dry-run (never calls the provider) when not live, even with a provider wired', async () => {
    const sender = new SpySender('sent');
    const svc = new InvoiceDeliveryService({ sender, live: false, dedupe: new InMemorySendDedupeStore() });
    const res = await svc.deliverStage(invoice, 'issued', ISSUED);
    expect(res.status).toBe('dry_run');
    expect(sender.calls).toHaveLength(0); // provider not touched
  });

  it('a failed send is not deduped → the next run retries it', async () => {
    const sender = new SpySender('failed');
    const dedupe = new InMemorySendDedupeStore();
    const svc = new InvoiceDeliveryService({ sender, live: true, dedupe });
    expect((await svc.deliverStage(invoice, 'issued', ISSUED)).status).toBe('failed');
    expect(await dedupe.has('invsend:' + invoice.invoiceNumber + ':issued')).toBe(false); // not recorded
    await svc.deliverStage(invoice, 'issued', ISSUED);
    expect(sender.calls).toHaveLength(2); // re-attempted
  });

  it('deliverDue picks the stage due as-of now; runSweep tallies the batch', async () => {
    const sender = new SpySender('sent');
    const svc = new InvoiceDeliveryService({ sender, live: true, dedupe: new InMemorySendDedupeStore() });
    // 30 days past due → an overdue stage is due.
    const late = addDaysIso(invoice.dueAt, 30);
    const summary = await svc.runSweep([invoice], late);
    expect(summary.considered).toBe(1);
    expect(summary.sent).toBe(1);
    expect(summary.results[0]!.stage).toBe('final_notice'); // 21+ days past due
    expect(sender.calls[0]!.message.body).toContain('Late finance charge included');
  });

  it('skips an invoice with no AP contact email', async () => {
    const sender = new SpySender('sent');
    const svc = new InvoiceDeliveryService({ sender, live: true, dedupe: new InMemorySendDedupeStore() });
    const noAp = { ...invoice, billTo: { ...invoice.billTo, apContactEmail: '' } };
    const res = await svc.deliverStage(noAp, 'issued', ISSUED);
    expect(res.status).toBe('skipped');
    expect(sender.calls).toHaveLength(0);
  });
});
