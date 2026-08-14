/**
 * The retraining job — champion/challenger promotion off the live ledger.
 *
 * This is what runs on a schedule against the attribution ledger in production:
 * extract labeled outcomes → data-quality gates → fit a challenger → compare it to
 * the current champion on a held-out split → promote ONLY if it beats the champion by
 * a margin. The gate is the safety property: retraining can never ship a regression,
 * and never ships a model fit on too little / too-imbalanced data.
 *
 * It is deliberately model-agnostic about where the ledger comes from — pass entries
 * from Postgres, a nightly export, or (in tests) a ledger produced by actually running
 * the recovery service. `samplesFromLedger` does the join.
 */

import { LogisticRecoverability, type RecoverabilityWeights } from './logistic.js';
import { samplesFromLedger, type LedgerEntryLike, type LedgerSampleOptions } from './ledger-samples.js';
import {
  evaluate,
  splitTrainTest,
  trainLogisticRecoverability,
  type EvalMetrics,
  type TrainOptions,
} from './training.js';

export interface RetrainConfig {
  /** Reject the run if fewer than this many labeled samples exist. */
  minSamples: number;
  /** Reject unless at least this many recovered (positive) outcomes exist. */
  minPositives: number;
  /** Reject unless at least this many non-recovered (negative) outcomes exist. */
  minNegatives: number;
  /** Held-out fraction for the champion/challenger comparison. */
  testFraction: number;
  /** Seed for the deterministic split. */
  splitSeed: number;
  /** Trainer hyperparameters for the challenger. */
  trainOptions: Partial<TrainOptions>;
  /** Challenger must beat the champion's held-out AUC by at least this to promote. */
  promoteMarginAuc: number;
  /** How ledger samples are weighted (defaults to amount-weighted). */
  sampleOptions?: LedgerSampleOptions;
}

export const DEFAULT_RETRAIN_CONFIG: RetrainConfig = {
  minSamples: 500,
  minPositives: 50,
  minNegatives: 50,
  testFraction: 0.25,
  splitSeed: 13,
  trainOptions: { iterations: 2500, lr: 0.4, l2: 1e-4, seed: 17 },
  promoteMarginAuc: 0.005,
};

export type RetrainRejection =
  | 'insufficient_samples'
  | 'insufficient_positives'
  | 'insufficient_negatives';

export interface RetrainReport {
  /** False when a data-quality gate blocked the run (no model produced). */
  accepted: boolean;
  reason?: RetrainRejection;
  nSamples: number;
  nPositives: number;
  nNegatives: number;
  /** Held-out metrics of the current champion (present when accepted). */
  champion?: EvalMetrics;
  /** Held-out metrics of the freshly-fit challenger (present when accepted). */
  challenger?: EvalMetrics;
  /** True iff the challenger beat the champion by the margin — i.e. deploy it. */
  promoted: boolean;
  /** The challenger's fitted weights (present when accepted, promoted or not). */
  weights?: RecoverabilityWeights;
}

/**
 * Retrain from a ledger and decide whether to promote. Deterministic given the entries
 * and config. Never throws on data shape — a thin/imbalanced ledger is a *rejection*,
 * not an error, so a scheduled job can act on the report.
 */
export function retrainFromLedger(
  entries: readonly LedgerEntryLike[],
  champion: RecoverabilityWeights,
  config: Partial<RetrainConfig> = {},
): RetrainReport {
  const cfg = { ...DEFAULT_RETRAIN_CONFIG, ...config };
  const samples = samplesFromLedger(entries, cfg.sampleOptions);
  const nPositives = samples.filter((s) => s.recovered).length;
  const nNegatives = samples.length - nPositives;
  const base = { nSamples: samples.length, nPositives, nNegatives, promoted: false };

  if (samples.length < cfg.minSamples) return { ...base, accepted: false, reason: 'insufficient_samples' };
  if (nPositives < cfg.minPositives) return { ...base, accepted: false, reason: 'insufficient_positives' };
  if (nNegatives < cfg.minNegatives) return { ...base, accepted: false, reason: 'insufficient_negatives' };

  const { train, test } = splitTrainTest(samples, cfg.testFraction, cfg.splitSeed);
  const { weights } = trainLogisticRecoverability(train, cfg.trainOptions);

  const championMetrics = evaluate(new LogisticRecoverability(champion), test);
  const challengerMetrics = evaluate(new LogisticRecoverability(weights), test);

  // Promote only a genuine, better-than-random improvement — never ship a regression.
  const promoted =
    challengerMetrics.auc > 0.5 && challengerMetrics.auc >= championMetrics.auc + cfg.promoteMarginAuc;

  weights.meta = {
    corpus: 'ledger',
    nSamples: samples.length,
    nPositives,
    challengerAuc: round(challengerMetrics.auc),
    championAuc: round(championMetrics.auc),
    promoted,
  };

  return {
    ...base,
    accepted: true,
    champion: championMetrics,
    challenger: challengerMetrics,
    promoted,
    weights,
  };
}

function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
