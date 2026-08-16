/**
 * Invoice dunning sweep. Loads every issued invoice from the shared DB and delivers each one's
 * current due reminder (issued → due-soon → due-today → overdue → final), reusing the guardrail-
 * fenced comms transport. Safe-by-default: dry-run unless AX10M_LIVE_BILLING=true and a provider
 * is wired. Idempotent per (invoice, stage). Schedule DAILY (cron / Temporal schedule).
 *
 *   corepack pnpm --filter @ax10m/api run dun
 */

import { Logger } from '@nestjs/common';
import { BillingRepository, type Db } from '@ax10m/persistence';
import { getSharedDb } from '../persistence/database.js';
import { buildInvoiceDeliveryService, type InvoiceDunningSummary } from './invoice-delivery.service.js';

const logger = new Logger('BillingDunningJob');

export interface DunningJobOptions {
  db?: Db;
  env?: NodeJS.ProcessEnv;
  nowIso?: string;
}

/** Run one dunning sweep over all invoices. Returns null if no DB is configured. */
export async function runInvoiceDunningJob(opts: DunningJobOptions = {}): Promise<InvoiceDunningSummary | null> {
  const env = opts.env ?? process.env;
  const db = opts.db ?? (await getSharedDb(env));
  if (!db) {
    logger.error('No DATABASE_URL / shared DB — no invoices to dun.');
    return null;
  }
  const invoices = await new BillingRepository(db).allInvoices();
  const delivery = await buildInvoiceDeliveryService(env);
  return delivery.runSweep(invoices, opts.nowIso ?? new Date().toISOString());
}
