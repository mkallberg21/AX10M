/**
 * Database client factory. Two drivers, one schema-typed `Db`:
 *  - `createPglite(dataDir?)` — in-process Postgres (WASM). File-backed when a dir is
 *    given (survives a "restart" = a new client on the same dir), in-memory otherwise.
 *    Used for tests, local dev, and the seed when no DATABASE_URL is set.
 *  - `createPg(connectionString)` — a real Postgres server via node-postgres, for prod.
 *
 * Both return a `DbHandle` with `close()` so callers (and the restart test) can shut a
 * connection down cleanly.
 */

import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema } from './schema.js';

/** The schema-typed Drizzle database. Both drivers expose the same query API. */
export type Db = PgliteDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

/** In-process Postgres (pglite). Pass a directory to persist to disk. */
export async function createPglite(dataDir?: string): Promise<DbHandle> {
  const client = new PGlite(dataDir);
  await client.waitReady;
  const db = drizzlePglite(client, { schema });
  return { db, close: () => client.close() };
}

/** Real Postgres via node-postgres (production). */
export async function createPg(connectionString: string): Promise<DbHandle> {
  const pool = new pg.Pool({ connectionString });
  const db = drizzlePg(pool, { schema }) as unknown as Db;
  return { db, close: () => pool.end() };
}

/**
 * Open the database indicated by the environment: `DATABASE_URL` → Postgres, else a
 * local pglite directory (default `./.data/ax10m`).
 */
export async function openFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<DbHandle> {
  if (env.DATABASE_URL) return createPg(env.DATABASE_URL);
  return createPglite(env.AX10M_PGLITE_DIR ?? './.data/ax10m');
}
