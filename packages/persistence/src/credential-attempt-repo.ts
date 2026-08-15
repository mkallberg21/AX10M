/**
 * Persisted per-credential (card) attempt counter for card-network retry-cap accounting.
 * `increment` is an atomic upsert (`ON CONFLICT DO UPDATE count = count + 1`), so concurrent
 * bumps from the API + worker on the same card don't lose an increment.
 */

import { eq, sql } from 'drizzle-orm';
import { credentialAttempts } from './schema.js';
import type { Db } from './client.js';

export class CredentialAttemptRepository {
  constructor(private readonly db: Db) {}

  /** Atomically bump a credential's attempt count; returns the new count. */
  async increment(key: string, lastAt: string): Promise<number> {
    const rows = await this.db
      .insert(credentialAttempts)
      .values({ key, count: 1, lastAt })
      .onConflictDoUpdate({ target: credentialAttempts.key, set: { count: sql`${credentialAttempts.count} + 1`, lastAt } })
      .returning({ count: credentialAttempts.count });
    return rows[0]?.count ?? 1;
  }

  /** Attempts recorded against a credential (0 if none). */
  async count(key: string): Promise<number> {
    const rows = await this.db.select({ count: credentialAttempts.count }).from(credentialAttempts).where(eq(credentialAttempts.key, key)).limit(1);
    return rows[0]?.count ?? 0;
  }

  /** The credential's count + last-attempt time (null if none) — drives the min-interval. */
  async get(key: string): Promise<{ count: number; lastAt: string } | null> {
    const rows = await this.db.select({ count: credentialAttempts.count, lastAt: credentialAttempts.lastAt }).from(credentialAttempts).where(eq(credentialAttempts.key, key)).limit(1);
    return rows[0] ?? null;
  }
}
