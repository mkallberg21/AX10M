/**
 * SendDedupeStore builder — the persisted, shared implementation of the dunning-send
 * idempotency seam (interface + in-memory default live in @ax10m/comms). Over
 * @ax10m/persistence's DunningSendRepository, so a reminder sent by the worker is not
 * re-sent by the API (or after a restart), matching the shared ledger + credential counter.
 */

import { DunningSendRepository, type Db } from '@ax10m/persistence';
import type { SendDedupeStore } from '@ax10m/comms';
import { getSharedDb } from '../persistence/database.js';

/** Persisted, shared dedupe store. Records the send time (app-layer clock) on record(). */
export class PersistedSendDedupeStore implements SendDedupeStore {
  constructor(private readonly repo: DunningSendRepository) {}
  async has(key: string): Promise<boolean> {
    return this.repo.has(key);
  }
  async record(key: string): Promise<void> {
    await this.repo.record(key, new Date().toISOString());
  }
}

/** Build the shared persisted store when a real Postgres is configured; else null (in-memory). */
export async function buildSendDedupeStore(env: NodeJS.ProcessEnv = process.env): Promise<SendDedupeStore | null> {
  if (!env.DATABASE_URL) return null;
  const db: Db | null = await getSharedDb(env);
  if (!db) return null;
  return new PersistedSendDedupeStore(new DunningSendRepository(db));
}
