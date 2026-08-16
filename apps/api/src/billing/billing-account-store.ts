/**
 * BillingAccountStore seam — the persistence port for billing accounts, signed acceptance
 * records, and invoices. Persisted (BillingRepository over the shared DB) when a database is
 * configured; an in-memory default otherwise, so the portal works in dev without Postgres.
 *
 * BillingRepository already implements this exact surface, so the persisted store is just the
 * repo. The in-memory store mirrors it for the no-DB path.
 */

import type { BillingAccount, Invoice, SignedAcceptanceRecord } from '@ax10m/billing';
import { BillingRepository } from '@ax10m/persistence';
import { getSharedDb } from '../persistence/database.js';

export interface BillingAccountStore {
  upsertAccount(account: BillingAccount): Promise<void>;
  getAccount(accountId: string): Promise<BillingAccount | undefined>;
  accountForMerchant(merchantId: string): Promise<BillingAccount | undefined>;
  listAccounts(): Promise<BillingAccount[]>;
  recordAcceptance(rec: SignedAcceptanceRecord): Promise<void>;
  acceptancesForAccount(accountId: string): Promise<SignedAcceptanceRecord[]>;
  upsertInvoice(invoice: Invoice): Promise<void>;
  getInvoice(invoiceNumber: string): Promise<Invoice | undefined>;
  invoicesForMerchant(merchantId: string): Promise<Invoice[]>;
  allInvoices(): Promise<Invoice[]>;
}

/** In-memory store for the no-DB path (dev / tests). Not shared across processes, not persisted. */
export class InMemoryBillingAccountStore implements BillingAccountStore {
  private accounts = new Map<string, BillingAccount>();
  private acceptances = new Map<string, SignedAcceptanceRecord>(); // by recordHash
  private invoices = new Map<string, Invoice>();

  async upsertAccount(account: BillingAccount): Promise<void> {
    this.accounts.set(account.accountId, account);
  }
  async getAccount(accountId: string): Promise<BillingAccount | undefined> {
    return this.accounts.get(accountId);
  }
  async accountForMerchant(merchantId: string): Promise<BillingAccount | undefined> {
    const matches = [...this.accounts.values()].filter((a) => a.merchantId === merchantId);
    matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matches[0];
  }
  async listAccounts(): Promise<BillingAccount[]> {
    return [...this.accounts.values()];
  }
  async recordAcceptance(rec: SignedAcceptanceRecord): Promise<void> {
    if (!this.acceptances.has(rec.recordHash)) this.acceptances.set(rec.recordHash, rec); // idempotent on hash
  }
  async acceptancesForAccount(accountId: string): Promise<SignedAcceptanceRecord[]> {
    return [...this.acceptances.values()].filter((r) => r.accountId === accountId).sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  }
  async upsertInvoice(invoice: Invoice): Promise<void> {
    this.invoices.set(invoice.invoiceNumber, invoice);
  }
  async getInvoice(invoiceNumber: string): Promise<Invoice | undefined> {
    return this.invoices.get(invoiceNumber);
  }
  async invoicesForMerchant(merchantId: string): Promise<Invoice[]> {
    return [...this.invoices.values()].filter((i) => i.merchantId === merchantId).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  }
  async allInvoices(): Promise<Invoice[]> {
    return [...this.invoices.values()].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  }
}

/** Persisted store when DATABASE_URL / pglite is configured, else the in-memory default. */
export async function buildBillingAccountStore(env: NodeJS.ProcessEnv = process.env): Promise<BillingAccountStore> {
  const db = await getSharedDb(env);
  if (db) return new BillingRepository(db);
  return new InMemoryBillingAccountStore();
}
