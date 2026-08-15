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

/** The guardrail inputs for a credential's network retry-cap. */
export interface CredentialAttemptWindow {
  attemptsInWindow: number;
  /**
   * Minutes since the last attempt on this credential — computed ONLY when `nowIso` is a
   * saga-clock time (durable sleeps advance it), so the min-interval is measured in the
   * saga's timeline, never the service's wall clock.
   */
  minutesSinceLastAttempt?: number;
}

function minutesBetween(nowIso: string | undefined, lastAt: string): number | undefined {
  if (!nowIso) return undefined;
  return Math.floor((Date.parse(nowIso) - Date.parse(lastAt)) / 60_000);
}

export interface CredentialAttemptStore {
  /** Attempts recorded against a credential (0 if none). */
  count(key: string): Promise<number>;
  /** The network-cap window: attempt count + (saga-time) minutes since last attempt. */
  window(key: string, nowIso?: string): Promise<CredentialAttemptWindow>;
  /** Atomically bump a credential's attempt count, stamping `nowIso` as the last-attempt time. */
  increment(key: string, nowIso: string): Promise<void>;
}

/** In-process counter (default). Single-process only — used for dev and tests. */
export class InMemoryCredentialAttemptStore implements CredentialAttemptStore {
  private readonly m = new Map<string, { count: number; lastAt: string }>();
  async count(key: string): Promise<number> {
    return this.m.get(key)?.count ?? 0;
  }
  async window(key: string, nowIso?: string): Promise<CredentialAttemptWindow> {
    const e = this.m.get(key);
    if (!e) return { attemptsInWindow: 0 };
    return { attemptsInWindow: e.count, minutesSinceLastAttempt: minutesBetween(nowIso, e.lastAt) };
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
  async window(key: string, nowIso?: string): Promise<CredentialAttemptWindow> {
    const r = await this.repo.get(key);
    if (!r) return { attemptsInWindow: 0 };
    return { attemptsInWindow: r.count, minutesSinceLastAttempt: minutesBetween(nowIso, r.lastAt) };
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
