/**
 * Online contextual-bandit policy — keeps learning from realized rewards.
 *
 * `HeuristicPolicy` with a trained `LogisticRecoverability` is a fixed model. This is
 * the same decision surface, but its recoverability model updates online via one SGD
 * step per realized outcome (`update`), so per-issuer/per-merchant timing sharpens as
 * money moves — the data flywheel the whole thesis rests on. It satisfies the existing
 * `ContextualBanditPolicy` interface, so it drops into the engine unchanged.
 *
 * The reward → label mapping: a positive realized reward (money recovered) is a
 * success (1), otherwise a failure (0). Because `decide` reuses `HeuristicPolicy`, all
 * the guardrail-safe structure (hard-decline routing, EV threshold, method selection,
 * timing) is inherited — only P(recover) learns.
 */

import { encodeFeatures, FEATURE_DIM } from './features.js';
import { LogisticRecoverability, sigmoid, type RecoverabilityWeights } from './logistic.js';
import { HeuristicPolicy } from './policy.js';
import type { ContextualBanditPolicy, PolicyContext, RecoveryDecision } from './policy.js';
import type { RecoveryFeatures } from './recoverability.js';

export interface BanditOptions {
  /** SGD step size for online updates. */
  learningRate: number;
  /** L2 decay applied per update (weights only). */
  l2: number;
}

export const DEFAULT_BANDIT_OPTIONS: BanditOptions = { learningRate: 0.05, l2: 1e-5 };

/**
 * A trained logistic recoverability model that also updates online. Wraps
 * `HeuristicPolicy` for the decision logic and mutates its own weights on each reward.
 */
export class BanditPolicy implements ContextualBanditPolicy {
  private readonly w: number[];
  private b: number;
  private readonly policy: HeuristicPolicy;

  constructor(
    initial: RecoverabilityWeights,
    private readonly opts: BanditOptions = DEFAULT_BANDIT_OPTIONS,
  ) {
    if (initial.w.length !== FEATURE_DIM) {
      throw new Error(`BanditPolicy: weight length ${initial.w.length} != FEATURE_DIM ${FEATURE_DIM}`);
    }
    this.w = initial.w.slice();
    this.b = initial.b;
    // The model reads live weights on every score() call.
    const model = { score: (f: RecoveryFeatures) => this.probability(f) };
    this.policy = new HeuristicPolicy(model);
  }

  decide(features: RecoveryFeatures, ctx: PolicyContext): RecoveryDecision {
    return this.policy.decide(features, ctx);
  }

  /** One SGD step: nudge P(recover) toward the realized outcome for these features. */
  update(features: RecoveryFeatures, _decision: RecoveryDecision, realizedRewardMinor: number): void {
    const y = realizedRewardMinor > 0 ? 1 : 0;
    const x = encodeFeatures(features);
    const p = this.probability(features);
    const err = p - y; // dL/dz
    for (let i = 0; i < FEATURE_DIM; i++) {
      const g = err * x[i]! + this.opts.l2 * this.w[i]!;
      this.w[i]! -= this.opts.learningRate * g;
    }
    this.b -= this.opts.learningRate * err;
  }

  /** Current fitted parameters (for checkpointing back to the ledger/store). */
  params(): RecoverabilityWeights {
    return { w: this.w.slice(), b: this.b };
  }

  /** Snapshot as a plain logistic model (immutable). */
  snapshot(): LogisticRecoverability {
    return new LogisticRecoverability(this.params());
  }

  private probability(f: RecoveryFeatures): number {
    const x = encodeFeatures(f);
    let z = this.b;
    for (let i = 0; i < FEATURE_DIM; i++) z += this.w[i]! * x[i]!;
    return sigmoid(z);
  }
}
