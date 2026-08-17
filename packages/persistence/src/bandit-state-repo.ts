/**
 * Persistence for the contextual-bandit flywheel state. One row per named model (default
 * 'global') holding the bandit's serialized sufficient statistics. Domain-light: the state is an
 * opaque jsonb doc here (the shape lives in @ax10m/recovery-engine), so persistence stays
 * decoupled from the engine. Shared across the API + worker + restarts.
 */

import { eq } from 'drizzle-orm';
import { banditState } from './schema.js';
import type { Db } from './client.js';

export class BanditStateRepository {
  constructor(private readonly db: Db) {}

  /** Load a named bandit state, or undefined if none is stored yet. */
  async get(name: string): Promise<Record<string, unknown> | undefined> {
    const rows = (await this.db.select({ doc: banditState.doc }).from(banditState).where(eq(banditState.name, name)).limit(1)) as Array<{ doc: Record<string, unknown> }>;
    return rows[0]?.doc;
  }

  /** Insert or replace a named bandit state (a full snapshot after a delta-merge). */
  async save(name: string, doc: Record<string, unknown>, updates: number, at: string): Promise<void> {
    await this.db
      .insert(banditState)
      .values({ name, doc, updates, updatedAt: at })
      .onConflictDoUpdate({ target: banditState.name, set: { doc, updates, updatedAt: at } });
  }
}
