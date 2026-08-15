/**
 * Versioned recovery-model store. The retrain job persists a promoted challenger here;
 * the recovery service loads the active champion at startup. This is what makes the
 * flywheel durable: retrain → persist → next start (of API or worker) picks it up.
 *
 * Weights are stored opaquely (JSON) so this package stays independent of
 * @ax10m/recovery-engine; the caller casts to `RecoverabilityWeights`.
 */

import { desc, eq } from 'drizzle-orm';
import { recoveryModels } from './schema.js';
import type { Db } from './client.js';

export interface StoredModel {
  version: number;
  weights: unknown;
  createdAt: string;
  active: boolean;
}

export class ModelRepository {
  constructor(private readonly db: Db) {}

  /** The active champion's weights, or null if none has been promoted yet. */
  async getActiveChampion(): Promise<unknown | null> {
    const rows = await this.db.select().from(recoveryModels).where(eq(recoveryModels.active, true)).orderBy(desc(recoveryModels.version)).limit(1);
    return rows[0]?.weights ?? null;
  }

  /** Highest version number stored (−1 if empty). */
  async latestVersion(): Promise<number> {
    const rows = await this.db.select({ version: recoveryModels.version }).from(recoveryModels).orderBy(desc(recoveryModels.version)).limit(1);
    return rows[0]?.version ?? -1;
  }

  /**
   * Persist a newly-promoted champion as the next version and make it active
   * (deactivating older versions). Returns the new version number.
   */
  async saveChampion(weights: unknown, now: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const head = await tx.select({ version: recoveryModels.version }).from(recoveryModels).orderBy(desc(recoveryModels.version)).limit(1);
      const version = (head[0]?.version ?? -1) + 1;
      await tx.update(recoveryModels).set({ active: false }).where(eq(recoveryModels.active, true));
      await tx.insert(recoveryModels).values({ version, weights, createdAt: now, active: true });
      return version;
    });
  }
}
