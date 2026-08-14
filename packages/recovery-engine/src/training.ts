/**
 * Training the recoverability model.
 *
 * L2-regularized logistic regression fit by full-batch gradient descent on labeled
 * outcomes `{features, recovered}`. Deterministic given a seed (a small seeded PRNG,
 * never `Math.random`) so a fitted model — and the shipped bootstrap weights — are
 * reproducible and auditable.
 *
 * In production the labeled corpus comes from the attribution ledger (see
 * `samplesFromLedger`): every recovery decision logs its feature snapshot, and the
 * realized `case.recovered` / `charge.failed` outcome is the label. Retraining is
 * then just re-running this on a fresh ledger export. Until enough live outcomes
 * exist, the same trainer fits a grounded synthetic corpus (`simulate.ts`) to
 * produce the bootstrap prior the engine ships with.
 */

import { encodeFeatures, FEATURE_DIM } from './features.js';
import { LogisticRecoverability, sigmoid, type RecoverabilityWeights } from './logistic.js';
import type { RecoverabilityModel, RecoveryFeatures } from './recoverability.js';

/** One labeled training example. */
export interface TrainingSample {
  features: RecoveryFeatures;
  /** Ground truth: did this failed invoice ultimately recover when acted on? */
  recovered: boolean;
  /** Optional importance weight (e.g. by amount). Defaults to 1. */
  weight?: number;
}

export interface TrainOptions {
  iterations: number;
  /** Learning rate. */
  lr: number;
  /** L2 regularization strength (not applied to the bias). */
  l2: number;
  /** Seed for the deterministic PRNG (init jitter / any shuffling). */
  seed: number;
}

export const DEFAULT_TRAIN_OPTIONS: TrainOptions = { iterations: 2000, lr: 0.3, l2: 1e-4, seed: 1 };

/** Deterministic PRNG (mulberry32) — reproducible training, never Math.random. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle in place using a seeded PRNG (returns the same array). */
export function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

export interface TrainResult {
  weights: RecoverabilityWeights;
  /** Training loss (mean regularized BCE) at each recorded step. */
  history: number[];
}

/**
 * Fit a `RecoverabilityWeights` by full-batch gradient descent. Pure + deterministic.
 */
export function trainLogisticRecoverability(
  samples: readonly TrainingSample[],
  options: Partial<TrainOptions> = {},
): TrainResult {
  const opts = { ...DEFAULT_TRAIN_OPTIONS, ...options };
  if (samples.length === 0) throw new Error('trainLogisticRecoverability: no samples');

  const rng = mulberry32(opts.seed);
  // Small symmetric init jitter (helps break ties; deterministic under the seed).
  const w = new Array<number>(FEATURE_DIM).fill(0).map(() => (rng() - 0.5) * 0.01);
  let b = 0;

  // Pre-encode once — the feature vectors don't change across iterations.
  const X = samples.map((s) => encodeFeatures(s.features));
  const y = samples.map((s) => (s.recovered ? 1 : 0));
  const sw = samples.map((s) => s.weight ?? 1);
  const swSum = sw.reduce((a, c) => a + c, 0);

  const history: number[] = [];

  for (let iter = 0; iter < opts.iterations; iter++) {
    const gradW = new Array<number>(FEATURE_DIM).fill(0);
    let gradB = 0;
    let loss = 0;

    for (let n = 0; n < X.length; n++) {
      const xn = X[n]!;
      let z = b;
      for (let i = 0; i < FEATURE_DIM; i++) z += w[i]! * xn[i]!;
      const p = sigmoid(z);
      const err = (p - y[n]!) * sw[n]!; // dL/dz for weighted BCE
      for (let i = 0; i < FEATURE_DIM; i++) gradW[i]! += err * xn[i]!;
      gradB += err;

      // Weighted BCE for logging.
      const eps = 1e-12;
      loss += -sw[n]! * (y[n]! * Math.log(p + eps) + (1 - y[n]!) * Math.log(1 - p + eps));
    }

    // Average, add L2 (weights only), step.
    for (let i = 0; i < FEATURE_DIM; i++) {
      const g = gradW[i]! / swSum + opts.l2 * w[i]!;
      w[i]! -= opts.lr * g;
    }
    b -= opts.lr * (gradB / swSum);

    if (iter % 50 === 0 || iter === opts.iterations - 1) {
      const l2pen = (opts.l2 / 2) * w.reduce((a, c) => a + c * c, 0);
      history.push(loss / swSum + l2pen);
    }
  }

  return { weights: { w, b }, history };
}

// ── evaluation metrics ───────────────────────────────────────────────────────

export interface EvalMetrics {
  /** Mean binary cross-entropy (lower is better). */
  logLoss: number;
  /** Area under the ROC curve (0.5 = random, 1 = perfect). */
  auc: number;
  /** Brier score = mean squared error of the probability (lower is better). */
  brier: number;
  /** Accuracy at a 0.5 threshold. */
  accuracy: number;
  n: number;
}

/** Evaluate a recoverability model on labeled samples. */
export function evaluate(model: RecoverabilityModel, samples: readonly TrainingSample[]): EvalMetrics {
  const preds: Array<{ p: number; y: number }> = samples.map((s) => ({
    p: model.score(s.features),
    y: s.recovered ? 1 : 0,
  }));
  const n = preds.length || 1;
  const eps = 1e-12;
  let logLoss = 0;
  let brier = 0;
  let correct = 0;
  for (const { p, y } of preds) {
    logLoss += -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
    brier += (p - y) * (p - y);
    if ((p >= 0.5 ? 1 : 0) === y) correct++;
  }
  return { logLoss: logLoss / n, brier: brier / n, accuracy: correct / n, auc: auc(preds), n: preds.length };
}

/** Rank-based ROC AUC (Mann–Whitney U). */
export function auc(preds: ReadonlyArray<{ p: number; y: number }>): number {
  const pos = preds.filter((d) => d.y === 1).map((d) => d.p);
  const neg = preds.filter((d) => d.y === 0).map((d) => d.p);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  // Sum of ranks of positives (average ranks for ties).
  const all = preds.map((d) => d.p).slice().sort((a, c) => a - c);
  const rankOf = new Map<number, number>();
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j] === all[i]) j++;
    const avgRank = (i + 1 + j) / 2; // 1-based average rank across the tie block
    rankOf.set(all[i]!, avgRank);
    i = j;
  }
  let rankSumPos = 0;
  for (const p of pos) rankSumPos += rankOf.get(p)!;
  const u = rankSumPos - (pos.length * (pos.length + 1)) / 2;
  return u / (pos.length * neg.length);
}

/** Deterministic train/test split (shuffled by seed). */
export function splitTrainTest(
  samples: readonly TrainingSample[],
  testFraction: number,
  seed: number,
): { train: TrainingSample[]; test: TrainingSample[] } {
  const idx = shuffle(
    samples.map((_, i) => i),
    mulberry32(seed),
  );
  const nTest = Math.round(samples.length * testFraction);
  const testIdx = new Set(idx.slice(0, nTest));
  const train: TrainingSample[] = [];
  const test: TrainingSample[] = [];
  samples.forEach((s, i) => (testIdx.has(i) ? test : train).push(s));
  return { train, test };
}

/** Convenience: fit and wrap in a ready-to-use model. */
export function fitRecoverability(samples: readonly TrainingSample[], options?: Partial<TrainOptions>): LogisticRecoverability {
  return new LogisticRecoverability(trainLogisticRecoverability(samples, options).weights);
}
