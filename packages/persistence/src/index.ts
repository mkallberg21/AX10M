/**
 * @ax10m/persistence — Postgres persistence (Drizzle) for AX10M.
 *
 * Restart-safe hash-chained ledger, per-merchant connections with credentials
 * encrypted at rest, portable migrations, and a demo seed. Runs on a real Postgres
 * (node-postgres) in production and on in-process pglite for tests/dev. See
 * ARCHITECTURE.md §for the Drizzle-vs-Prisma rationale.
 */

export * from './schema.js';
export * from './client.js';
export * from './crypto.js';
export * from './migrate.js';
export * from './ledger-repo.js';
export * from './connection-repo.js';
export * from './model-repo.js';
export * from './seed.js';
