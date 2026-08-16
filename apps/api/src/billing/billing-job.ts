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
import { createEd25519Signer, type Signer } from '@ax10m/attribution';
import { LedgerRepository, type Db } from '@ax10m/persistence';
import { getSharedDb } from '../persistence/database.js';
import { runBilling, type BillingRunSummary } from './billing-run.js';
import { NoopBillingCharger, type BillingCharger } from './charger.js';

const logger = new Logger('BillingJob');

function resolveSigner(env: NodeJS.ProcessEnv): Signer {
  const pem = env.AX10M_BILLING_SIGNING_KEY;
  if (pem) return createEd25519Signer('ax10m-billing', pem).signer;
  logger.warn('AX10M_BILLING_SIGNING_KEY not set — signing statements with an EPHEMERAL key (not verifiable across runs). Set it in production.');
  return createEd25519Signer('ax10m-billing-ephemeral').signer;
}

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
  const entries = await repo.all();
  const ledgerHead = await repo.head();

  const { summary } = await runBilling({
    entries,
    ledger: entries,
    ledgerHead,
    append: async (e) => {
      await repo.append(e);
    },
    signer: resolveSigner(env),
    nowIso: opts.nowIso ?? new Date().toISOString(),
    live: env.AX10M_LIVE_BILLING === 'true',
    charger: opts.charger ?? new NoopBillingCharger(),
  });

  const billable = summary.merchants.filter((m) => m.feeMinor > 0).length;
  logger.log(`Billed ${summary.period}: ${summary.merchants.length} merchant(s), ${billable} with a positive fee, total fee ${summary.totalFeeMinor} minor (live=${summary.live}, collected ${summary.totalChargedMinor}).`);
  return summary;
}
