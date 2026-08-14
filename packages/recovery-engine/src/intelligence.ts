/**
 * DeclineIntelligenceEngine — the facade over the recovery brain's decision inputs.
 *
 * One object that answers the four questions AX10M is built on, all keyed off the
 * canonical decline taxonomy so they work identically across every processor:
 *   - classify(code)          what kind of failure is this?
 *   - strategy(code, network) how should we space retries for it?
 *   - predict(features)       how likely are we to recover if we act?  (trained model)
 *   - sequence(features, ctx) the full autonomous retry schedule (ARSE)
 *
 * The prediction uses the trained bootstrap prior by default; pass a retrained
 * `LogisticRecoverability` or an online `BanditPolicy` snapshot to use fresher weights.
 */

import { LogisticRecoverability } from './logistic.js';
import { BOOTSTRAP_RECOVERABILITY_WEIGHTS } from './bootstrap-weights.js';
import { classifyDecline, describeCanonicalTaxonomy, type DeclineClassification } from './decline-intel.js';
import { strategyFor, type CardNetwork, type RetryStrategy } from './retry-strategy.js';
import { planRetrySequence, type RetryStep, type SequenceContext } from './sequence.js';
import type { DeclineCode } from '@ax10m/canonical';
import type { RecoverabilityModel, RecoveryFeatures } from './recoverability.js';

export class DeclineIntelligenceEngine {
  constructor(private readonly model: RecoverabilityModel = new LogisticRecoverability(BOOTSTRAP_RECOVERABILITY_WEIGHTS)) {}

  /** Reason-code classification (family, retriability, recommended action). */
  classify(code: DeclineCode): DeclineClassification {
    return classifyDecline(code);
  }

  /** Network-aware retry cadence for a decline code. */
  strategy(code: DeclineCode, network: CardNetwork = 'other'): RetryStrategy {
    return strategyFor(code, network);
  }

  /** Trained retry-success prediction, P(recover | act). */
  predict(features: RecoveryFeatures): number {
    return this.model.score(features);
  }

  /** The full autonomous retry sequence (uses this engine's model). */
  sequence(features: RecoveryFeatures, ctx: Omit<SequenceContext, 'model'>): RetryStep[] {
    return planRetrySequence(features, { ...ctx, model: this.model });
  }

  /** The whole canonical taxonomy, classified — the cross-processor reference map. */
  taxonomy(): DeclineClassification[] {
    return describeCanonicalTaxonomy();
  }
}
