/**
 * LedgerPort — the async seam over the hash-chained ledger, so the recovery service can
 * append to EITHER an in-process ledger (dev/tests) or the shared PERSISTED ledger
 * (@ax10m/persistence) without knowing which. The persisted port is what lets the HTTP
 * API and the recovery worker append to ONE chain: both point at the same Postgres, so a
 * charge the worker records is in the same tamper-evident ledger the API reads (and the
 * retrainer/flywheel consume).
 *
 * Every method is async because the persisted implementation hits the database. Appends
 * are serialized per process (a promise-chain mutex) to avoid needless seq races; the
 * repository's optimistic-retry handles races BETWEEN processes.
 */

import { HashChainedLedger, type LedgerEntry, type LedgerEventType } from '@ax10m/attribution';
import { LedgerRepository } from '@ax10m/persistence';
import { getSharedDb } from '../persistence/database.js';

export interface LedgerAppendInput {
  merchantId: string;
  type: LedgerEventType;
  occurredAt: string;
  detail: Record<string, unknown>;
}

export interface LedgerPort {
  append(input: LedgerAppendInput): Promise<void>;
  head(): Promise<string>;
  all(): Promise<readonly LedgerEntry[]>;
}

/** In-process ledger (default). Single-process only — used for dev and tests. */
export class InMemoryLedgerPort implements LedgerPort {
  private readonly ledger = new HashChainedLedger();
  async append(input: LedgerAppendInput): Promise<void> {
    this.ledger.append(input);
  }
  async head(): Promise<string> {
    return this.ledger.head();
  }
  async all(): Promise<readonly LedgerEntry[]> {
    return this.ledger.all();
  }
}

/**
 * Persisted, SHARED ledger over @ax10m/persistence's `LedgerRepository`. Appends are
 * chained through a per-instance promise mutex so this process's own appends never race
 * each other; cross-process races are resolved by the repository's seq-collision retry.
 */
export class PersistedLedgerPort implements LedgerPort {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly repo: LedgerRepository) {}

  append(input: LedgerAppendInput): Promise<void> {
    // Serialize on the mutex: each append waits for the previous to commit before it
    // reads the head, so we don't create self-contention within one process.
    const next = this.tail.then(() => this.repo.append(input));
    // Keep the chain alive even if one append rejects (don't wedge the mutex).
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next.then(() => undefined);
  }
  async head(): Promise<string> {
    return this.repo.head();
  }
  async all(): Promise<readonly LedgerEntry[]> {
    return this.repo.all();
  }
}

/**
 * Build the SHARED persisted ledger port when a real Postgres is configured
 * (`DATABASE_URL`) — the mode in which the API and worker append to one chain. Returns
 * null otherwise, so the caller keeps the in-memory default (pglite is single-process and
 * can't be shared across the two processes, so it does not enable the shared ledger).
 */
export async function buildLedgerPort(env: NodeJS.ProcessEnv = process.env): Promise<LedgerPort | null> {
  if (!env.DATABASE_URL) return null;
  const db = await getSharedDb(env);
  if (!db) return null;
  return new PersistedLedgerPort(new LedgerRepository(db));
}
