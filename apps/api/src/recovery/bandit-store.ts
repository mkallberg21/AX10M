/**
 * BanditStateStore — the persistence port for the contextual-bandit flywheel. Persisted
 * (BanditStateRepository over the shared DB) when a database is configured; null otherwise (the
 * bandit still learns in-memory, just not shared/durable). One named state ('global') pools every
 * merchant's live outcomes into ONE cross-merchant model.
 */

import type { LinUcbBanditState } from '@ax10m/recovery-engine';
import { BanditStateRepository, type Db } from '@ax10m/persistence';
import { getSharedDb } from '../persistence/database.js';

export interface BanditStateStore {
  load(name: string): Promise<LinUcbBanditState | undefined>;
  save(name: string, state: LinUcbBanditState, updates: number): Promise<void>;
}

/** Persisted, shared store over the bandit_state table. */
export class PersistedBanditStateStore implements BanditStateStore {
  constructor(private readonly repo: BanditStateRepository) {}
  async load(name: string): Promise<LinUcbBanditState | undefined> {
    const doc = await this.repo.get(name);
    return doc as LinUcbBanditState | undefined;
  }
  async save(name: string, state: LinUcbBanditState, updates: number): Promise<void> {
    await this.repo.save(name, state as unknown as Record<string, unknown>, updates, new Date().toISOString());
  }
}

/** Build the persisted store when a real Postgres / pglite is configured, else null (in-memory only). */
export async function buildBanditStateStore(env: NodeJS.ProcessEnv = process.env): Promise<BanditStateStore | null> {
  const db: Db | null = await getSharedDb(env);
  if (!db) return null;
  return new PersistedBanditStateStore(new BanditStateRepository(db));
}
