/**
 * Autonomous monthly billing job. Reads the shared persisted ledger, computes each merchant's
 * signed Uplift Statement for the PREVIOUS calendar month, records it (the invoice), and — only
 * when AX10M_LIVE_BILLING=true and a real charger is wired — collects the 12% fee. Schedule it
 * monthly (cron / Temporal schedule), same pattern as the retrain job.
 *
 *   corepack pnpm --filter @ax10m/api run bill
 *
 * Requires DATABASE_URL (the shared ledger). Env:
 *   AX10M_BILLING_SIGNING_KEY  Ed25519 private-key PEM to sign statements (stable, verifiable
 *                              across runs). Unset → an ephemeral dev key (warns; not verifiable
 *                              across runs).
 *   AX10M_LIVE_BILLING=true    actually collect the fee (needs a wired charger; default records only).
 */

import { Logger } from '@nestjs/common';
import { buildInvoice, type StatementForInvoice } from '@ax10m/billing';
import { BillingRepository, LedgerRepository, type Db } from '@ax10m/persistence';
import { getSharedDb } from '../persistence/database.js';
import { runBilling, type BillingRunSummary } from './billing-run.js';
import type { BillingCharger } from './charger.js';
import { resolveBillingSigner, resolveRemitTo } from './billing-signer.js';
import { buildInvoiceDeliveryService } from './invoice-delivery.service.js';
import { buildBillingCharger } from './stripe-billing-charger.js';

const logger = new Logger('BillingJob');

export interface BillingJobOptions {
  db?: Db;
  env?: NodeJS.ProcessEnv;
  nowIso?: string;
  /** Real charger for live collection. Default Noop (records the invoice, collects nothing). */
  charger?: BillingCharger;
}

/** Run one monthly billing pass against the persisted ledger. Returns null if no DB is configured. */
export async function runBillingJob(opts: BillingJobOptions = {}): Promise<BillingRunSummary | null> {
  const env = opts.env ?? process.env;
  const db = opts.db ?? (await getSharedDb(env));
  if (!db) {
    logger.error('No DATABASE_URL / shared ledger — nothing to bill.');
    return null;
  }
  const repo = new LedgerRepository(db);
  const billingRepo = new BillingRepository(db);
  const entries = await repo.all();
  const ledgerHead = await repo.head();
  const nowIso = opts.nowIso ?? new Date().toISOString();

  // The charger collects the fee off-session on auto-pay (Stripe) when live; Noop otherwise. It
  // resolves the payment method + customer from the merchant's billing account.
  const charger = opts.charger ?? buildBillingCharger(env, (merchantId) => billingRepo.accountForMerchant(merchantId));

  const { summary, statements } = await runBilling({
    entries,
    ledger: entries,
    ledgerHead,
    append: async (e) => {
      await repo.append(e);
    },
    signer: resolveBillingSigner(env),
    nowIso,
    live: env.AX10M_LIVE_BILLING === 'true',
    charger,
  });

  // Generate a human-facing invoice for each billable statement whose merchant has opted in
  // (has a BillingAccount). The invoice amount is taken verbatim from the signed statement, so it
  // always equals the provable fee. Merchants without an account are billed only once they opt in.
  const remitTo = resolveRemitTo(env);
  const delivery = await buildInvoiceDeliveryService(env);
  let invoicesIssued = 0;
  let noticesSent = 0;
  for (const signed of statements) {
    const r = signed.result;
    if (!r.billable || r.fee.amount <= 0) continue;
    const account = await billingRepo.accountForMerchant(signed.merchantId);
    if (!account) continue; // not opted in yet → statement recorded, no invoice
    const statement: StatementForInvoice = {
      merchantId: signed.merchantId,
      period: signed.period,
      currency: signed.currency,
      feeMinor: r.fee.amount,
      upliftLowerMinor: r.billableIncrement.amount,
      statementHash: signed.statementHash,
      billable: r.billable,
    };
    const invoice = buildInvoice({ account, statement, issuedAt: nowIso, remitTo });
    await billingRepo.upsertInvoice(invoice);
    invoicesIssued += 1;
    // Deliver the initial "invoice ready" notice to the AP inbox (dry-run unless live).
    const sent = await delivery.deliverStage(invoice, 'issued', nowIso);
    if (sent.status === 'sent') noticesSent += 1;
  }

  const billable = summary.merchants.filter((m) => m.feeMinor > 0).length;
  logger.log(`Billed ${summary.period}: ${summary.merchants.length} merchant(s), ${billable} with a positive fee, ${invoicesIssued} invoice(s) issued to opted-in merchants (${noticesSent} notice(s) sent), total fee ${summary.totalFeeMinor} minor (live=${summary.live}, collected ${summary.totalChargedMinor}).`);
  return summary;
}
