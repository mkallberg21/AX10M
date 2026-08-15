/**
 * Process-wide shared database handle. Both the merchant-connection store and the
 * persisted ledger need the SAME database; opening two handles would double-connect
 * (and, on pglite, two clients on one directory can conflict). This memoizes a single
 * `openFromEnv()` handle per process and applies migrations once.
 *
 * Cross-PROCESS sharing (the whole point of the persisted ledger) is what makes the HTTP
 * API and the recovery worker append to one chain: each process opens its own handle to
 * the SAME Postgres (`DATABASE_URL`). NOTE: pglite is single-process — sharing a ledger
 * across the API and worker requires real Postgres, not the local pglite dir.
 */

import { applyMigrations, openFromEnv, type Db } from '@ax10m/persistence';

let shared: Promise<Db> | undefined;

/** Get (or lazily open + migrate) this process's shared Db. Null if no DB is configured. */
export async function getSharedDb(env: NodeJS.ProcessEnv = process.env): Promise<Db | null> {
  if (!env.DATABASE_URL && !env.AX10M_PGLITE_DIR) return null;
  if (!shared) {
    shared = (async () => {
      const { db } = await openFromEnv(env);
      await applyMigrations(db);
      return db;
    })();
  }
  return shared;
}

/** Test-only: reset the memoized handle so a fresh env opens a new database. */
export function resetSharedDbForTests(): void {
  shared = undefined;
}
