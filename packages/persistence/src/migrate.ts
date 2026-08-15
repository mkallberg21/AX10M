/**
 * Migrations. Portable idempotent DDL applied in order and tracked in
 * `schema_migrations`, so it runs identically on pglite (tests/dev) and a real
 * Postgres (prod) without drizzle-kit codegen. Each migration is a list of single
 * statements (some drivers don't accept multi-statement `execute`).
 */

import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

interface Migration {
  name: string;
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    name: '0001_init',
    statements: [
      `CREATE TABLE IF NOT EXISTS merchants (
        id text PRIMARY KEY,
        display_name text NOT NULL,
        created_at text NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS merchant_connections (
        connection_id text PRIMARY KEY,
        merchant_id text NOT NULL,
        processor text NOT NULL,
        credentials_encrypted text NOT NULL,
        is_default boolean NOT NULL DEFAULT false,
        created_at text NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_conn_processor_default ON merchant_connections (processor, is_default)`,
      `CREATE TABLE IF NOT EXISTS ledger_entries (
        seq integer PRIMARY KEY,
        merchant_id text NOT NULL,
        type text NOT NULL,
        occurred_at text NOT NULL,
        detail jsonb NOT NULL,
        prev_hash text NOT NULL,
        hash text NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_merchant ON ledger_entries (merchant_id)`,
    ],
  },
  {
    name: '0002_recovery_models',
    statements: [
      `CREATE TABLE IF NOT EXISTS recovery_models (
        version integer PRIMARY KEY,
        weights jsonb NOT NULL,
        created_at text NOT NULL,
        active boolean NOT NULL DEFAULT false
      )`,
      `CREATE INDEX IF NOT EXISTS idx_recovery_models_active ON recovery_models (active)`,
    ],
  },
];

/** Apply all pending migrations. Returns the names actually run. Idempotent. */
export async function applyMigrations(db: Db): Promise<string[]> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at text NOT NULL)`);
  const appliedRes = await db.execute(sql`SELECT name FROM schema_migrations`);
  const rows = (appliedRes as unknown as { rows?: Array<{ name: string }> }).rows ?? [];
  const applied = new Set<string>(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    for (const stmt of m.statements) await db.execute(sql.raw(stmt));
    await db.execute(sql`INSERT INTO schema_migrations (name, applied_at) VALUES (${m.name}, ${new Date().toISOString()})`);
    ran.push(m.name);
  }
  return ran;
}
