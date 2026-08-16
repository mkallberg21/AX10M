/**
 * Persistence for the merchant billing layer: opt-in accounts, signed clickwrap acceptance
 * records, and issued invoices. Each row stores the full domain object (@ax10m/billing) in a
 * jsonb `doc`, with the queryable fields promoted to columns. Restart-safe and shared across the
 * API + billing job, like the ledger.
 */

import { desc, eq } from 'drizzle-orm';
import type { BillingAccount, Invoice, SignedAcceptanceRecord } from '@ax10m/billing';
import { billingAccounts, billingAcceptances, billingInvoices } from './schema.js';
import type { Db } from './client.js';

interface DocRow<T> {
  doc: T;
}

export class BillingRepository {
  constructor(private readonly db: Db) {}

  // ── accounts ────────────────────────────────────────────────────────────────

  /** Insert or update a billing account (keyed by accountId). */
  async upsertAccount(account: BillingAccount): Promise<void> {
    await this.db
      .insert(billingAccounts)
      .values({ accountId: account.accountId, merchantId: account.merchantId, status: account.status, doc: account, createdAt: account.createdAt })
      .onConflictDoUpdate({ target: billingAccounts.accountId, set: { merchantId: account.merchantId, status: account.status, doc: account } });
  }

  async getAccount(accountId: string): Promise<BillingAccount | undefined> {
    const rows = (await this.db.select({ doc: billingAccounts.doc }).from(billingAccounts).where(eq(billingAccounts.accountId, accountId)).limit(1)) as DocRow<BillingAccount>[];
    return rows[0]?.doc;
  }

  /** The most-recently-created account for a merchant (the active billing identity). */
  async accountForMerchant(merchantId: string): Promise<BillingAccount | undefined> {
    const rows = (await this.db
      .select({ doc: billingAccounts.doc })
      .from(billingAccounts)
      .where(eq(billingAccounts.merchantId, merchantId))
      .orderBy(desc(billingAccounts.createdAt))
      .limit(1)) as DocRow<BillingAccount>[];
    return rows[0]?.doc;
  }

  async listAccounts(): Promise<BillingAccount[]> {
    const rows = (await this.db.select({ doc: billingAccounts.doc }).from(billingAccounts)) as DocRow<BillingAccount>[];
    return rows.map((r) => r.doc);
  }

  // ── acceptance records ───────────────────────────────────────────────────────

  /** Record a signed acceptance. Idempotent on the record hash (re-submit is a no-op). */
  async recordAcceptance(rec: SignedAcceptanceRecord): Promise<void> {
    await this.db
      .insert(billingAcceptances)
      .values({ recordHash: rec.recordHash, accountId: rec.accountId, merchantId: rec.merchantId, doc: rec, acceptedAt: rec.acceptedAt })
      .onConflictDoNothing({ target: billingAcceptances.recordHash });
  }

  async acceptancesForAccount(accountId: string): Promise<SignedAcceptanceRecord[]> {
    const rows = (await this.db
      .select({ doc: billingAcceptances.doc })
      .from(billingAcceptances)
      .where(eq(billingAcceptances.accountId, accountId))
      .orderBy(desc(billingAcceptances.acceptedAt))) as DocRow<SignedAcceptanceRecord>[];
    return rows.map((r) => r.doc);
  }

  // ── invoices ─────────────────────────────────────────────────────────────────

  /** Insert or update an issued invoice (keyed by the deterministic invoice number). */
  async upsertInvoice(invoice: Invoice): Promise<void> {
    await this.db
      .insert(billingInvoices)
      .values({ invoiceNumber: invoice.invoiceNumber, accountId: invoice.accountId, merchantId: invoice.merchantId, period: invoice.period, status: invoice.status, doc: invoice, issuedAt: invoice.issuedAt })
      .onConflictDoUpdate({ target: billingInvoices.invoiceNumber, set: { status: invoice.status, doc: invoice } });
  }

  async getInvoice(invoiceNumber: string): Promise<Invoice | undefined> {
    const rows = (await this.db.select({ doc: billingInvoices.doc }).from(billingInvoices).where(eq(billingInvoices.invoiceNumber, invoiceNumber)).limit(1)) as DocRow<Invoice>[];
    return rows[0]?.doc;
  }

  async invoicesForMerchant(merchantId: string): Promise<Invoice[]> {
    const rows = (await this.db
      .select({ doc: billingInvoices.doc })
      .from(billingInvoices)
      .where(eq(billingInvoices.merchantId, merchantId))
      .orderBy(desc(billingInvoices.issuedAt))) as DocRow<Invoice>[];
    return rows.map((r) => r.doc);
  }

  /** All invoices (for the dunning sweep). Ordered newest-issued first. */
  async allInvoices(): Promise<Invoice[]> {
    const rows = (await this.db.select({ doc: billingInvoices.doc }).from(billingInvoices).orderBy(desc(billingInvoices.issuedAt))) as DocRow<Invoice>[];
    return rows.map((r) => r.doc);
  }
}
