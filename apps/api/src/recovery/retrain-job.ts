/**
 * The retrain job — runs the champion/challenger retrainer against the PERSISTED ledger
 * the API + worker fill, and persists a promoted challenger as the new active champion.
 *
 *   corepack pnpm --filter @ax10m/api run retrain
 *
 * Flow: read the current champion from the model store (bootstrap prior if none) → read
 * the shared ledger → retrainFromLedger (data-quality gates + held-out promotion gate) →
 * if promoted, save the new champion (versioned, becomes active) AND append a
 * `model.promoted` event to the same hash-chained ledger, so the promotion is auditable.
 *
 * The promotion gate lives in @ax10m/recovery-engine: it never ships a regression and
 * never ships a model fit on too little / too-imbalanced data. This job just wires it to
 * the persisted stores.
 */

import {
  BOOTSTRAP_RECOVERABILITY_WEIGHTS,
  retrainFromLedger,
  type RecoverabilityWeights,
  type RetrainConfig,
  type RetrainReport,
} from '@ax10m/recovery-engine';
import { LedgerRepository, ModelRepository, type Db } from '@ax10m/persistence';
import { getSharedDb } from '../persistence/database.js';

export interface RetrainJobResult {
  report: RetrainReport;
  /** Version written to the model store, or null if not promoted. */
  promotedVersion: number | null;
  /** Whether the champion compared against came from the store or the bootstrap prior. */
  championSource: 'persisted' | 'bootstrap';
}

/** Resolve the database: an explicit handle (tests) or the process's shared handle. */
async function resolveDb(opts: { db?: Db; env?: NodeJS.ProcessEnv }): Promise<Db | null> {
  return opts.db ?? (await getSharedDb(opts.env ?? process.env));
}

/** Load the active retrained champion from the model store (null if none promoted yet). */
export async function loadActiveChampion(opts: { db?: Db; env?: NodeJS.ProcessEnv } = {}): Promise<RecoverabilityWeights | null> {
  const db = await resolveDb(opts);
  if (!db) return null;
  const champ = await new ModelRepository(db).getActiveChampion();
  return (champ as RecoverabilityWeights | null) ?? null;
}

/**
 * Run one retrain pass against the persisted ledger. Requires a database (the retrainer
 * reads the persisted ledger). Deterministic given the ledger + config.
 */
export async function runRetrainJob(opts: { db?: Db; env?: NodeJS.ProcessEnv; config?: Partial<RetrainConfig> } = {}): Promise<RetrainJobResult> {
  const db = await resolveDb(opts);
  if (!db) {
    throw new Error('runRetrainJob: no database configured. Set DATABASE_URL — the retrainer reads the shared persisted ledger.');
  }
  const config = opts.config;
  const ledgerRepo = new LedgerRepository(db);
  const modelRepo = new ModelRepository(db);

  const persisted = (await modelRepo.getActiveChampion()) as RecoverabilityWeights | null;
  const champion = persisted ?? BOOTSTRAP_RECOVERABILITY_WEIGHTS;
  const entries = await ledgerRepo.all();

  const report = retrainFromLedger(entries, champion, config);

  let promotedVersion: number | null = null;
  if (report.accepted && report.promoted && report.weights) {
    const now = new Date().toISOString();
    promotedVersion = await modelRepo.saveChampion(report.weights, now);
    // Record the promotion in the same tamper-evident ledger (ignored by the sampler, so
    // it never contaminates the training corpus — only recovery.planned + outcomes count).
    await ledgerRepo.append({
      merchantId: 'ax10m',
      type: 'model.promoted',
      occurredAt: now,
      detail: {
        version: promotedVersion,
        championAuc: report.champion?.auc ?? null,
        challengerAuc: report.challenger?.auc ?? null,
        nSamples: report.nSamples,
        nPositives: report.nPositives,
        championSource: persisted ? 'persisted' : 'bootstrap',
      },
    });
  }

  return { report, promotedVersion, championSource: persisted ? 'persisted' : 'bootstrap' };
}
