/**
 * Drizzle schema — the Postgres tables backing AX10M's persistent state.
 *
 * We chose **Drizzle** over Prisma (justified in ARCHITECTURE.md): SQL-first, no code
 * generation or engine binary, and it runs against `@electric-sql/pglite` — an
 * in-process Postgres — so the persistence layer is unit-tested against real Postgres
 * semantics (incl. a genuine restart) with no server, while `pg` drives a real
 * Postgres in production.
 */

import { boolean, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

/** Onboarded merchants (tenants). */
export const merchants = pgTable('merchants', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: text('created_at').notNull(),
});

/**
 * Per-merchant processor connections — the source for per-merchant adapter resolution.
 * `credentialsEncrypted` is an AES-256-GCM blob (never plaintext, never logged).
 */
export const merchantConnections = pgTable('merchant_connections', {
  connectionId: text('connection_id').primaryKey(),
  merchantId: text('merchant_id').notNull(),
  processor: text('processor').notNull(),
  credentialsEncrypted: text('credentials_encrypted').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: text('created_at').notNull(),
});

/**
 * The append-only, hash-chained ledger (ARCHITECTURE.md §3.3). One global chain;
 * `seq` is monotonic and each row's `hash` links to the prior via `prevHash`. Persisted
 * so integrity survives a restart — `verifyChain` (from @ax10m/attribution) over these
 * rows must still pass.
 */
export const ledgerEntries = pgTable('ledger_entries', {
  seq: integer('seq').primaryKey(),
  merchantId: text('merchant_id').notNull(),
  type: text('type').notNull(),
  occurredAt: text('occurred_at').notNull(),
  detail: jsonb('detail').notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
});

/**
 * Versioned recovery-model store. The retrain job (@ax10m/recovery-engine
 * `retrainFromLedger`) writes a new row when a challenger is promoted; the recovery
 * service loads the `active` row at startup. Rollback = flip `active` to an older version.
 * `weights` is the serialized `RecoverabilityWeights` ({ w, b, meta }).
 */
export const recoveryModels = pgTable('recovery_models', {
  version: integer('version').primaryKey(),
  weights: jsonb('weights').notNull(),
  createdAt: text('created_at').notNull(),
  active: boolean('active').notNull().default(false),
});

/**
 * Per-credential (card) attempt counter for card-network retry-cap accounting. Keyed by
 * `${invoiceId}:${cardToken}` so a refreshed / backup card starts a fresh window,
 * independent of the dead card. Persisted so the count survives restarts and is shared
 * across the API + worker (matching the shared ledger).
 */
export const credentialAttempts = pgTable('credential_attempts', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(0),
  lastAt: text('last_at').notNull(),
});

/**
 * Dunning-send idempotency: one row per reminder actually sent, keyed by
 * `${merchantId}:${invoiceId}:${attempt}:${channel}`. Persisted so exactly-once survives
 * restarts and is shared across the API + worker (a re-invoked delivery never re-sends).
 */
export const dunningSends = pgTable('dunning_sends', {
  key: text('key').primaryKey(),
  sentAt: text('sent_at').notNull(),
});

export const schema = { merchants, merchantConnections, ledgerEntries, recoveryModels, credentialAttempts, dunningSends };
