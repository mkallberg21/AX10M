/**
 * InvoiceDeliveryService — sends AX10M's own invoices + dunning reminders to the merchant's
 * accounts-payable inbox, reusing the guardrail-fenced comms transport (@ax10m/comms).
 *
 * SAFETY (mirrors the recovery money/comms path):
 *   - Safe-by-default: every send is a DRY RUN unless a real provider is wired AND
 *     AX10M_LIVE_BILLING=true. So configuring Postmark alone never sends an invoice.
 *   - assertSendable re-validates at the transport boundary (no PAN, address matches channel).
 *   - Exactly-once: a per-(invoice, stage) dedupe key, recorded only after a real send, so a
 *     re-run of the sweep never re-sends the same reminder (persisted + shared when a DB is set).
 *   - send() never throws — a provider failure is a `failed` result, never a broken run.
 *
 * Invoice delivery rides the AX10M_LIVE_BILLING gate (it's part of the billing path), NOT the
 * consumer-dunning AX10M_LIVE_COMMS gate — but it reuses the same Postmark provider construction.
 */

import { Logger } from '@nestjs/common';
import { invoiceAsOf, invoiceDunningStage, renderInvoiceEmail, type Invoice, type InvoiceDunningStage } from '@ax10m/billing';
import {
  DryRunDunningSender,
  InMemorySendDedupeStore,
  type DunningMessage,
  type DunningRecipient,
  type DunningSender,
  type SendDedupeStore,
} from '@ax10m/comms';
import { buildDunningSender } from '../recovery/dunning-comms-builder.js';
import { buildSendDedupeStore } from '../recovery/send-dedupe-store.js';

const logger = new Logger('InvoiceDelivery');

export interface InvoiceDeliveryResult {
  invoiceNumber: string;
  stage: InvoiceDunningStage | null;
  status: 'sent' | 'dry_run' | 'failed' | 'duplicate' | 'skipped';
  provider?: string;
  reason?: string;
}

export interface InvoiceDunningSummary {
  generatedAt: string;
  live: boolean;
  considered: number;
  sent: number;
  dryRun: number;
  duplicate: number;
  skipped: number;
  failed: number;
  results: InvoiceDeliveryResult[];
}

export class InvoiceDeliveryService {
  private readonly sender: DunningSender;
  private readonly dedupe: SendDedupeStore;
  readonly live: boolean;

  constructor(opts: { sender?: DunningSender; live?: boolean; dedupe?: SendDedupeStore }) {
    this.live = opts.live === true;
    // A real provider moves traffic ONLY when live; otherwise the safe dry-run sender.
    this.sender = this.live && opts.sender ? opts.sender : new DryRunDunningSender();
    this.dedupe = opts.dedupe ?? new InMemorySendDedupeStore();
  }

  private dedupeKey(invoiceNumber: string, stage: InvoiceDunningStage): string {
    return `invsend:${invoiceNumber}:${stage}`;
  }

  /** Deliver a specific stage's email to the AP inbox (idempotent per invoice+stage). */
  async deliverStage(invoice: Invoice, stage: InvoiceDunningStage, asOfIso: string): Promise<InvoiceDeliveryResult> {
    const asOf = invoiceAsOf(invoice, asOfIso); // current finance charge + total
    const email = asOf.billTo.apContactEmail;
    if (!email) return { invoiceNumber: invoice.invoiceNumber, stage, status: 'skipped', reason: 'no AP contact email' };

    const key = this.dedupeKey(invoice.invoiceNumber, stage);
    if (await this.dedupe.has(key)) return { invoiceNumber: invoice.invoiceNumber, stage, status: 'duplicate' };

    const rendered = renderInvoiceEmail(asOf, stage);
    const message: DunningMessage = { channel: 'email', subject: rendered.subject, body: rendered.body, generatedBy: 'template' };
    const recipient: DunningRecipient = { channel: 'email', email };
    const res = await this.sender.send(message, recipient);
    if (res.status === 'sent') await this.dedupe.record(key);
    return { invoiceNumber: invoice.invoiceNumber, stage, status: res.status, provider: res.provider, reason: res.error };
  }

  /** Deliver the current DUE stage for one invoice (skip if settled / nothing due / already sent). */
  async deliverDue(invoice: Invoice, asOfIso: string): Promise<InvoiceDeliveryResult> {
    const stage = invoiceDunningStage(invoiceAsOf(invoice, asOfIso), asOfIso);
    if (!stage) return { invoiceNumber: invoice.invoiceNumber, stage: null, status: 'skipped', reason: 'settled or nothing due' };
    return this.deliverStage(invoice, stage, asOfIso);
  }

  /** Sweep a set of invoices, delivering each one's current due stage. Returns a tallied summary. */
  async runSweep(invoices: readonly Invoice[], asOfIso: string): Promise<InvoiceDunningSummary> {
    const results: InvoiceDeliveryResult[] = [];
    for (const inv of invoices) results.push(await this.deliverDue(inv, asOfIso));
    const tally = (s: InvoiceDeliveryResult['status']): number => results.filter((r) => r.status === s).length;
    const summary: InvoiceDunningSummary = {
      generatedAt: asOfIso,
      live: this.live,
      considered: invoices.length,
      sent: tally('sent'),
      dryRun: tally('dry_run'),
      duplicate: tally('duplicate'),
      skipped: tally('skipped'),
      failed: tally('failed'),
      results,
    };
    logger.log(`Invoice dunning sweep: ${summary.considered} invoice(s) — sent ${summary.sent}, dry-run ${summary.dryRun}, duplicate ${summary.duplicate}, skipped ${summary.skipped}, failed ${summary.failed} (live=${summary.live}).`);
    return summary;
  }
}

/**
 * Build the delivery service from env. Reuses the Postmark/Twilio provider from the dunning-comms
 * builder, but gates live sending on AX10M_LIVE_BILLING (invoice delivery is part of billing, not
 * consumer comms). Dedupe is the shared persisted store when a DB is configured, else in-memory.
 */
export async function buildInvoiceDeliveryService(env: NodeJS.ProcessEnv = process.env): Promise<InvoiceDeliveryService> {
  const { sender } = buildDunningSender(env);
  const live = env.AX10M_LIVE_BILLING === 'true';
  const dedupe = (await buildSendDedupeStore(env)) ?? undefined;
  return new InvoiceDeliveryService({ sender, live, dedupe });
}
