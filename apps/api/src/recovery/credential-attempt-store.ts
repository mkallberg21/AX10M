/**
 * CredentialAttemptStore — the async seam over the per-credential (card) attempt counter
 * that drives card-network retry-cap accounting. In-memory by default (dev/tests); the
 * persisted implementation (over @ax10m/persistence) shares the count across the API and
 * worker and survives restarts, matching the shared ledger.
 *
 * Keyed by `${invoiceId}:${cardToken}` so a refreshed / backup card starts a fresh window.
 */

import { CredentialAttemptRepository, type Db } from '@ax10m/persistence';
import { getSharedDb } from '../persistence/database.js';

export interface CredentialAttemptStore {
  /** Attempts recorded against a credential (0 if none). */
  count(key: string): Promise<number>;
  /** Atomically bump a credential's attempt count. */
  increment(key: string, nowIso: string): Promise<void>;
}

/** In-process counter (default). Single-process only — used for dev and tests. */
export class InMemoryCredentialAttemptStore implements CredentialAttemptStore {
  private readonly m = new Map<string, { count: number; lastAt: string }>();
  async count(key: string): Promise<number> {
    return this.m.get(key)?.count ?? 0;
  }
  async increment(key: string, nowIso: string): Promise<void> {
    this.m.set(key, { count: (this.m.get(key)?.count ?? 0) + 1, lastAt: nowIso });
  }
}

/** Persisted, shared counter over @ax10m/persistence's CredentialAttemptRepository. */
export class PersistedCredentialAttemptStore implements CredentialAttemptStore {
  constructor(private readonly repo: CredentialAttemptRepository) {}
  async count(key: string): Promise<number> {
    return this.repo.count(key);
  }
  async increment(key: string, nowIso: string): Promise<void> {
    await this.repo.increment(key, nowIso);
  }
}

/** Build the shared persisted store when a real Postgres is configured; else null (in-memory). */
export async function buildCredentialAttemptStore(env: NodeJS.ProcessEnv = process.env): Promise<CredentialAttemptStore | null> {
  if (!env.DATABASE_URL) return null;
  const db: Db | null = await getSharedDb(env);
  if (!db) return null;
  return new PersistedCredentialAttemptStore(new CredentialAttemptRepository(db));
}
