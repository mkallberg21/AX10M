/**
 * Persisted dunning-send idempotency. One row per reminder actually sent, keyed by
 * `${merchantId}:${invoiceId}:${attempt}:${channel}`. `record` is an idempotent upsert
 * (`ON CONFLICT DO NOTHING`), so a double-record from the API + worker is harmless. The
 * caller records ONLY after a real send, so a dry-run / failed send stays re-sendable.
 */

import { eq } from 'drizzle-orm';
import { dunningSends } from './schema.js';
import type { Db } from './client.js';

export class DunningSendRepository {
  constructor(private readonly db: Db) {}

  /** True if this reminder has already been sent. */
  async has(key: string): Promise<boolean> {
    const rows = await this.db.select({ key: dunningSends.key }).from(dunningSends).where(eq(dunningSends.key, key)).limit(1);
    return rows.length > 0;
  }

  /** Mark this reminder as sent (idempotent — a repeat record is a no-op). */
  async record(key: string, sentAt: string): Promise<void> {
    await this.db.insert(dunningSends).values({ key, sentAt }).onConflictDoNothing({ target: dunningSends.key });
  }
}
