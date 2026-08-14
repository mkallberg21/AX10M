/**
 * Logistic recoverability model — the TRAINED drop-in for `HeuristicRecoverability`.
 *
 * Same `RecoverabilityModel.score()` contract, so it slots into `HeuristicPolicy`
 * (and therefore the whole engine) without touching a single caller — the seam the
 * cold-start heuristic was always meant to hand off to. The weights are fit by
 * `trainLogisticRecoverability` on realized outcomes (the attribution ledger in
 * production; a grounded synthetic corpus for the shipped bootstrap prior).
 */

import { encodeFeatures, FEATURE_DIM } from './features.js';
import type { RecoverabilityModel, RecoveryFeatures } from './recoverability.js';

/** Fitted logistic-regression parameters over the encoded feature vector. */
export interface RecoverabilityWeights {
  /** One weight per encoded dimension (length === FEATURE_DIM). */
  w: number[];
  /** Intercept (log-odds bias). */
  b: number;
  /** Optional provenance for auditability (corpus, date, metrics). */
  meta?: Record<string, unknown>;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** A recoverability model backed by fitted logistic-regression weights. */
export class LogisticRecoverability implements RecoverabilityModel {
  constructor(private readonly weights: RecoverabilityWeights) {
    if (weights.w.length !== FEATURE_DIM) {
      throw new Error(
        `LogisticRecoverability: weight vector length ${weights.w.length} != FEATURE_DIM ${FEATURE_DIM} (feature layout changed — retrain).`,
      );
    }
  }

  /** Raw model probability P(recover | act), clamped to [0,1]. */
  score(f: RecoveryFeatures): number {
    const x = encodeFeatures(f);
    let z = this.weights.b;
    for (let i = 0; i < x.length; i++) z += this.weights.w[i]! * x[i]!;
    return clamp01(sigmoid(z));
  }

  /** Expose the fitted parameters (for serialization / inspection). */
  params(): RecoverabilityWeights {
    return this.weights;
  }
}
