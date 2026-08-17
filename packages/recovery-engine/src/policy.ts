/**
 * Retry policy — the recovery brain's decision surface.
 *
 * Combines recoverability (P recover), timing (when), and method selection (which
 * credential) into a single `RecoveryDecision`, and computes the expected-value
 * reward a contextual bandit would optimize. The engine PROPOSES; the compliance
 * guardrail (@ax10m/guardrail) DISPOSES — a decision here is a *candidate* action
 * that still passes through the hard-constraint layer (network caps, quiet hours,
 * consent) before anything executes.
 *
 * `RetryPolicy` is the seam: `HeuristicPolicy` is the cold-start baseline;
 * `ContextualBanditPolicy` is the same interface plus an `update()` hook, so a
 * Thompson-sampling / offline-RL policy replaces the heuristic without touching any
 * caller. Beating Smart Retries is a property of the *learned* policy trained on
 * the outcome data the attribution ledger already captures — this file is where it
 * lands.
 */

import { DeclineCode, DeclineFamily, familyOf } from '@ax10m/canonical';
import {
  HeuristicRecoverability,
  type RecoverabilityModel,
  type RecoveryFeatures,
} from './recoverability.js';
import { optimalRetryTime } from './timing.js';
import { commsNetValue, retryNetValue, DEFAULT_COST_MODEL, type ActionCost, type ComplianceContext, type CostModel } from './objective.js';

export type RecoveryActionKind = 'retry' | 'card_update_comms' | 'suppress';

/** A tokenized payment method available for the retry (never a PAN). */
export interface AvailableMethod {
  ref: string;
  /** True if refreshed via Account Updater / network token (prefer for card issues). */
  autoUpdated?: boolean;
  isDefault?: boolean;
}

export interface PolicyConfig {
  /** Below this recoverability, don't attempt (attempt cost + fine risk not worth it). */
  minRecoverabilityToRetry: number;
  /** Cost of one attempt in minor units (processing + amortized fine-risk allowance). */
  attemptCostMinor: number;
  /** Multiplier on recovered invoice value for retained-subscription LTV (§1.2B). */
  retentionMultiplier: number;
}

// This attempt-cost EV is exactly the objective the backtest's net-value section prices
// (packages/backtest/src/economics.ts): suppressing low-EV attempts is what lets the engine
// win on net value vs the Smart Retries default at ~22% fewer attempts. See docs/STRATEGY.md §0.
export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  minRecoverabilityToRetry: 0.04,
  attemptCostMinor: 15, // ~$0.15 processing + fine-risk allowance
  retentionMultiplier: 1.6,
};

export interface PolicyContext {
  /** Current time (ISO) — passed in for determinism, no wall-clock read. */
  now: string;
  /** Tokenized methods available for this customer, for selection/fallback. */
  methods?: AvailableMethod[];
  config?: PolicyConfig;
  /** Cost model for the cost/compliance-aware objective (CostAwarePolicy). */
  cost?: CostModel;
  /** Compliance signals (network-cap proximity) that make near-cap attempts cost more. */
  compliance?: ComplianceContext;
}

export interface RecoveryDecision {
  action: RecoveryActionKind;
  /** For 'retry': when to attempt. */
  retryAt?: string;
  /** For 'retry': which tokenized method to charge. */
  paymentMethodRef?: string;
  recoverabilityScore: number;
  /** Net value in minor units: expected recovered value − attempt fee − expected fine cost. */
  expectedValueMinor: number;
  /** Alias of expectedValueMinor under the cost/compliance-aware objective (net of all costs). */
  netValueMinor?: number;
  /** Cost breakdown for the chosen action (CostAwarePolicy) — fee + expected fine cost. */
  costBreakdown?: ActionCost;
  rationale: string;
}

export interface RetryPolicy {
  decide(features: RecoveryFeatures, ctx: PolicyContext): RecoveryDecision;
}

/**
 * A contextual-bandit / offline-RL policy plugs in here: same `decide`, plus an
 * `update` hook fed the realized reward so the policy improves. `HeuristicPolicy`
 * below is the cold-start it bootstraps from.
 */
export interface ContextualBanditPolicy extends RetryPolicy {
  update(features: RecoveryFeatures, decision: RecoveryDecision, realizedRewardMinor: number): void;
}

/** Pick the method to charge: rotate to a fresh/alternate credential when sensible. */
function selectMethod(features: RecoveryFeatures, methods: AvailableMethod[] | undefined): AvailableMethod | undefined {
  if (!methods || methods.length === 0) return undefined;
  // After repeated declines on the default, rotate to an alternate method if present.
  if (features.attemptNumber >= 3) {
    const alternate = methods.find((m) => !m.isDefault);
    if (alternate) return alternate;
  }
  // Prefer an Account-Updater-refreshed credential — a fresher card is likelier to approve.
  const updated = methods.find((m) => m.autoUpdated);
  if (updated) return updated;
  return methods.find((m) => m.isDefault) ?? methods[0];
}

function expectedValue(score: number, amountMinor: number, retention: number, attemptCost: number): number {
  return Math.round(score * amountMinor * retention - attemptCost);
}

/** Grounded cold-start policy. Replace with a learned `ContextualBanditPolicy` when data exists. */
export class HeuristicPolicy implements RetryPolicy {
  constructor(private readonly model: RecoverabilityModel = new HeuristicRecoverability()) {}

  decide(features: RecoveryFeatures, ctx: PolicyContext): RecoveryDecision {
    const cfg = ctx.config ?? DEFAULT_POLICY_CONFIG;
    const score = this.model.score(features);
    const family = familyOf(features.declineCode);

    // Dead-credential declines: a same-card retry is pointless — route to a card
    // update / comms flow to get a working credential, don't burn a network attempt.
    if (family === DeclineFamily.Hard || features.declineCode === DeclineCode.ExpiredCard) {
      return {
        action: 'card_update_comms',
        recoverabilityScore: score,
        expectedValueMinor: expectedValue(score, features.amountMinor, cfg.retentionMultiplier, cfg.attemptCostMinor),
        rationale: `${features.declineCode}: credential is dead — route to card-update comms, do not retry the same card.`,
      };
    }

    if (score < cfg.minRecoverabilityToRetry) {
      return {
        action: 'suppress',
        recoverabilityScore: score,
        expectedValueMinor: 0,
        rationale: `P(recover)=${(score * 100).toFixed(1)}% below the ${(cfg.minRecoverabilityToRetry * 100).toFixed(0)}% retry threshold — suppress (a retry would likely just add cost/fine risk).`,
      };
    }

    const ev = expectedValue(score, features.amountMinor, cfg.retentionMultiplier, cfg.attemptCostMinor);
    if (ev <= 0) {
      return {
        action: 'suppress',
        recoverabilityScore: score,
        expectedValueMinor: ev,
        rationale: `Expected value ${ev} ≤ 0 — attempt cost exceeds expected recovery; suppress.`,
      };
    }

    const method = selectMethod(features, ctx.methods);
    const timing = optimalRetryTime(features, ctx.now);
    return {
      action: 'retry',
      retryAt: timing.retryAt,
      paymentMethodRef: method?.ref,
      recoverabilityScore: score,
      expectedValueMinor: ev,
      rationale: `${timing.rationale} P(recover)=${(score * 100).toFixed(0)}%, EV=${ev} minor.`,
    };
  }
}

/**
 * Cost- and compliance-aware policy — the primary decision surface (replaces HeuristicPolicy as
 * the engine default). It scores each candidate action by NET VALUE (@ax10m objective.ts):
 * expected recovered value minus the processing fee AND an expected fine cost that rises as
 * attempts approach the network cap. So it:
 *   - routes dead-credential declines to a card-update comms flow (net value via a fresh card),
 *   - suppresses a soft-decline retry as soon as its net value goes non-positive — which happens
 *     EARLIER when the credential is near its network cap (fine risk) than on rate alone, giving
 *     the overlay a durable cost/compliance edge a blind "retry harder" baseline can't copy.
 *
 * With no compliance signals and the default cost model it reduces to the same retry EV as the
 * heuristic, so it's a safe drop-in; the edge appears the moment cap-proximity context is supplied.
 * Implements the ContextualBanditPolicy seam (the `update` hook is where a learned policy lands).
 */
export class CostAwarePolicy implements ContextualBanditPolicy {
  constructor(private readonly model: RecoverabilityModel = new HeuristicRecoverability()) {}

  decide(features: RecoveryFeatures, ctx: PolicyContext): RecoveryDecision {
    const cfg = ctx.config ?? DEFAULT_POLICY_CONFIG;
    const cost = ctx.cost ?? DEFAULT_COST_MODEL;
    const score = this.model.score(features);
    const family = familyOf(features.declineCode);

    // Dead credential: a same-card retry is structurally hopeless — the only value is via a fresh
    // credential (card-update comms). Score it on the cost-aware objective (no network-fine risk).
    if (family === DeclineFamily.Hard || features.declineCode === DeclineCode.ExpiredCard) {
      const comms = commsNetValue({ recoverability: score, amountMinor: features.amountMinor, cost });
      return {
        action: 'card_update_comms',
        recoverabilityScore: score,
        expectedValueMinor: comms.netValueMinor,
        netValueMinor: comms.netValueMinor,
        costBreakdown: comms.cost,
        rationale: `${features.declineCode}: credential is dead — route to card-update comms (net value ${comms.netValueMinor} minor).`,
      };
    }

    // Soft decline: retry only while its NET value is positive. The fine-cost term makes near-cap
    // attempts progressively unprofitable, so the engine self-suppresses before the guardrail must.
    const retry = retryNetValue({ recoverability: score, amountMinor: features.amountMinor, cost, compliance: ctx.compliance });

    if (score < cfg.minRecoverabilityToRetry) {
      return {
        action: 'suppress',
        recoverabilityScore: score,
        expectedValueMinor: 0,
        netValueMinor: 0,
        rationale: `P(recover)=${(score * 100).toFixed(1)}% below the ${(cfg.minRecoverabilityToRetry * 100).toFixed(0)}% retry threshold — suppress.`,
      };
    }

    if (retry.netValueMinor <= 0) {
      const fineNote = retry.cost.fineCostMinor > 0 ? ` (incl. ${retry.cost.fineCostMinor} minor expected fine cost near the network cap)` : '';
      return {
        action: 'suppress',
        recoverabilityScore: score,
        expectedValueMinor: retry.netValueMinor,
        netValueMinor: retry.netValueMinor,
        costBreakdown: retry.cost,
        rationale: `Net value ${retry.netValueMinor} ≤ 0${fineNote} — attempt cost exceeds expected recovery; suppress.`,
      };
    }

    const method = selectMethod(features, ctx.methods);
    const timing = optimalRetryTime(features, ctx.now);
    const fineNote = retry.cost.fineCostMinor > 0 ? `, fine-risk ${retry.cost.fineCostMinor}` : '';
    return {
      action: 'retry',
      retryAt: timing.retryAt,
      paymentMethodRef: method?.ref,
      recoverabilityScore: score,
      expectedValueMinor: retry.netValueMinor,
      netValueMinor: retry.netValueMinor,
      costBreakdown: retry.cost,
      rationale: `${timing.rationale} P(recover)=${(score * 100).toFixed(0)}%, net value=${retry.netValueMinor} minor${fineNote}.`,
    };
  }

  /** Bandit hook — the seam where a learned (Thompson/offline-RL) policy consumes realized reward. */
  update(_features: RecoveryFeatures, _decision: RecoveryDecision, _realizedRewardMinor: number): void {
    // No-op cold start: the CostAwarePolicy is a fixed cost-aware objective. A learned policy
    // subclasses/replaces this to update its parameters from the reward.
  }
}
