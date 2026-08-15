/**
 * Seed the Phase-2 demo dataset into the database: a demo merchant, an (encrypted)
 * Stripe connection, and the demo ledger — so a fresh DB shows the same demo the
 * dashboard renders. Uses the same generator as the backtest, so it can't drift.
 */

import { buildDemoData } from '@ax10m/backtest';
import { merchants } from './schema.js';
import { applyMigrations } from './migrate.js';
import { LedgerRepository } from './ledger-repo.js';
import { ConnectionRepository } from './connection-repo.js';
import type { Db } from './client.js';

export interface SeedResult {
  merchant: string;
  connectionId: string;
  ledgerEntries: number;
}

export async function loadDemoSeed(db: Db, key: Buffer): Promise<SeedResult> {
  await applyMigrations(db);

  await db
    .insert(merchants)
    .values({ id: 'mrc_demo', displayName: 'Demo Merchant (synthetic)', createdAt: '2026-08-01T00:00:00.000Z' })
    .onConflictDoNothing();

  // A per-merchant Stripe connection — credentials are DEMO placeholders, encrypted at
  // rest. (These are not real keys; real keys never live in the repo.)
  const connections = new ConnectionRepository(db, key);
  await connections.upsert({
    connectionId: 'stripe-demo',
    merchantId: 'mrc_demo',
    processor: 'stripe',
    isDefault: true,
    config: { secretKey: 'sk_test_DEMO.placeholder', webhookSecret: 'whsec_DEMO.placeholder', merchantId: 'mrc_demo' },
  });

  const ledger = new LedgerRepository(db);
  const demo = buildDemoData({ nCustomers: 2000 }); // small stream → fast seed
  let n = 0;
  for (const e of demo.ledger) {
    await ledger.append({ merchantId: e.merchantId, type: e.type, occurredAt: e.occurredAt, detail: e.detail });
    n++;
  }

  return { merchant: 'mrc_demo', connectionId: 'stripe-demo', ledgerEntries: n };
}
