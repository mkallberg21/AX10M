/**
 * Fully-learned contextual-bandit policy (LinUCB over recovery actions).
 *
 * The cold-start `CostAwarePolicy` scores actions from a FIXED recoverability model + cost model.
 * This policy LEARNS the reward of each action per context from realized outcomes and EXPLORES,
 * so it keeps improving past the cold start — the data flywheel the thesis rests on.
 *
 * Design:
 *   - Arms are the actions the engine chooses among: `retry` and `card_update_comms`. `suppress`
 *     is the always-available 0-reward fallback.
 *   - Per arm, a ridge-regression reward model over the encoded feature vector (LinUCB): keep the
 *     inverse of A = λI + Σ xxᵀ (updated in O(d²) by Sherman–Morrison) and b = Σ r·x, so the
 *     predicted reward is θ·x with θ = A⁻¹b, and the exploration bonus is α·√(xᵀA⁻¹x).
 *   - GROUNDED COLD START: with no data the learned mean is blended fully onto the cost-aware
 *     prior (the same net-value estimate CostAwarePolicy uses), so day-one behavior equals the
 *     cost-aware objective; as data accrues the blend shifts to the learned mean.
 *   - COMPLIANCE FLOOR PRESERVED: a retry is a candidate only when its cost-aware net value
 *     (including the near-cap fine cost) is positive — exploration never overrides the compliance
 *     edge. The guardrail still DISPOSES.
 *
 * Deterministic (UCB, not sampling), so it's reproducible and testable. Online-updated via the
 * `ContextualBanditPolicy.update()` seam the engine already calls.
 */

import { DeclineCode, DeclineFamily, familyOf } from '@ax10m/canonical';
import { encodeFeatures, FEATURE_DIM } from './features.js';
import { HeuristicRecoverability, type RecoverabilityModel, type RecoveryFeatures } from './recoverability.js';
import { optimalRetryTime } from './timing.js';
import { commsNetValue, retryNetValue, DEFAULT_COST_MODEL, type CostModel } from './objective.js';
import { DEFAULT_POLICY_CONFIG } from './policy.js';
import type { AvailableMethod, ContextualBanditPolicy, PolicyContext, RecoveryActionKind, RecoveryDecision } from './policy.js';

type BanditArm = 'retry' | 'card_update_comms';
const ARMS: readonly BanditArm[] = ['retry', 'card_update_comms'];

export interface LinUcbOptions {
  /** Exploration coefficient (UCB width). Larger → more exploration. */
  alpha: number;
  /** Ridge regularization; A₀ = λI. */
  lambda: number;
  /** Prior strength (pseudo-observations) anchoring the learned mean to the cost-aware prior. */
  priorStrength: number;
  /** Reward normalizer (minor units → O(1)) so the linear algebra stays well-conditioned. */
  rewardScaleMinor: number;
  /**
   * Recoverability damping for a card-update COMMS action on a NON-dead-credential decline. A soft
   * decline (e.g. insufficient funds) is best resolved by a retry, not by asking the customer to
   * update a working card, so comms is far less effective there — this shrinks its prior so the
   * bandit doesn't mis-prefer it. On a dead credential comms is undamped (it's the only path).
   */
  softCommsDamping: number;
  cost?: CostModel;
}

export const DEFAULT_LINUCB_OPTIONS: LinUcbOptions = {
  alpha: 0.4,
  lambda: 1,
  priorStrength: 20,
  rewardScaleMinor: 10_000, // $100
  softCommsDamping: 0.15,
};

interface ArmState {
  /** Inverse of A = λI + Σ xxᵀ (d×d). */
  aInv: number[][];
  /** Σ r·x (length d), reward in scaled units. */
  b: number[];
  /** Number of realized updates for this arm. */
  n: number;
}

function scaledIdentityInverse(d: number, lambda: number): number[][] {
  const m: number[][] = [];
  const inv = 1 / lambda;
  for (let i = 0; i < d; i++) {
    m.push(new Array<number>(d).fill(0));
    m[i]![i] = inv;
  }
  return m;
}

function matVec(m: number[][], v: number[]): number[] {
  const d = v.length;
  const out = new Array<number>(d).fill(0);
  for (let i = 0; i < d; i++) {
    const row = m[i]!;
    let s = 0;
    for (let j = 0; j < d; j++) s += row[j]! * v[j]!;
    out[i] = s;
  }
  return out;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** In-place Sherman–Morrison: aInv ← (A + xxᵀ)⁻¹ given the current A⁻¹ and x. */
function shermanMorrisonUpdate(aInv: number[][], x: number[]): void {
  const d = x.length;
  const aInvX = matVec(aInv, x); // A⁻¹x
  const denom = 1 + dot(x, aInvX); // 1 + xᵀA⁻¹x
  if (denom <= 0) return; // numerically degenerate — skip (shouldn't happen for PSD A)
  for (let i = 0; i < d; i++) {
    const ai = aInvX[i]!;
    if (ai === 0) continue;
    const row = aInv[i]!;
    for (let j = 0; j < d; j++) {
      row[j]! -= (ai * aInvX[j]!) / denom;
    }
  }
}

export class LinUcbBanditPolicy implements ContextualBanditPolicy {
  private readonly arms: Record<BanditArm, ArmState>;
  private readonly opts: LinUcbOptions;

  constructor(
    private readonly model: RecoverabilityModel = new HeuristicRecoverability(),
    opts: Partial<LinUcbOptions> = {},
  ) {
    this.opts = { ...DEFAULT_LINUCB_OPTIONS, ...opts };
    this.arms = {
      retry: { aInv: scaledIdentityInverse(FEATURE_DIM, this.opts.lambda), b: new Array<number>(FEATURE_DIM).fill(0), n: 0 },
      card_update_comms: { aInv: scaledIdentityInverse(FEATURE_DIM, this.opts.lambda), b: new Array<number>(FEATURE_DIM).fill(0), n: 0 },
    };
  }

  decide(features: RecoveryFeatures, ctx: PolicyContext): RecoveryDecision {
    const cfg = ctx.config ?? DEFAULT_POLICY_CONFIG;
    const cost = ctx.cost ?? this.opts.cost ?? DEFAULT_COST_MODEL;
    const score = this.model.score(features);
    const family = familyOf(features.declineCode);
    const x = encodeFeatures(features);

    const deadCredential = family === DeclineFamily.Hard || features.declineCode === DeclineCode.ExpiredCard;
    // Cost-aware priors (minor) — the grounded cold start + the compliance floor for retry. Comms
    // recoverability is damped on a soft decline (a retry, not a card update, is the right fix there).
    const commsScore = deadCredential ? score : score * this.opts.softCommsDamping;
    const retryValue = retryNetValue({ recoverability: score, amountMinor: features.amountMinor, cost, compliance: ctx.compliance });
    const commsValue = commsNetValue({ recoverability: commsScore, amountMinor: features.amountMinor, cost });

    // Candidate arms: dead credential → comms only; otherwise retry (only if cost-aware net > 0,
    // preserving the compliance/cost floor) + comms. Below the recoverability floor → no retry.
    const priorMinor: Record<BanditArm, number> = { retry: retryValue.netValueMinor, card_update_comms: commsValue.netValueMinor };
    const allowed: BanditArm[] = [];
    if (!deadCredential && score >= cfg.minRecoverabilityToRetry && retryValue.netValueMinor > 0) allowed.push('retry');
    allowed.push('card_update_comms');

    // Score each allowed arm by its UCB (learned mean blended with the cost-aware prior + bonus).
    let best: { arm: BanditArm; ucbMinor: number; meanMinor: number } | undefined;
    for (const arm of allowed) {
      const s = this.scoreArm(arm, x, priorMinor[arm]);
      if (!best || s.ucbMinor > best.ucbMinor) best = { arm, ...s };
    }

    // Suppress is the 0-reward fallback: if nothing beats it, take no action.
    if (!best || best.ucbMinor <= 0) {
      return {
        action: 'suppress',
        recoverabilityScore: score,
        expectedValueMinor: best ? Math.round(best.meanMinor) : 0,
        netValueMinor: best ? Math.round(best.meanMinor) : 0,
        rationale: `Bandit: no action beats suppress (best net value ${best ? Math.round(best.ucbMinor) : 0} minor ≤ 0) — suppress.`,
      };
    }

    if (best.arm === 'card_update_comms') {
      return {
        action: 'card_update_comms',
        recoverabilityScore: score,
        expectedValueMinor: Math.round(best.meanMinor),
        netValueMinor: Math.round(best.meanMinor),
        costBreakdown: commsValue.cost,
        rationale: `${deadCredential ? `${features.declineCode}: dead credential — ` : ''}bandit chose card-update comms (learned net value ${Math.round(best.meanMinor)} minor, ucb ${Math.round(best.ucbMinor)}).`,
      };
    }

    const method = selectMethod(features, ctx.methods);
    const timing = optimalRetryTime(features, ctx.now);
    const fineNote = retryValue.cost.fineCostMinor > 0 ? `, fine-risk ${retryValue.cost.fineCostMinor}` : '';
    return {
      action: 'retry',
      retryAt: timing.retryAt,
      paymentMethodRef: method?.ref,
      recoverabilityScore: score,
      expectedValueMinor: Math.round(best.meanMinor),
      netValueMinor: Math.round(best.meanMinor),
      costBreakdown: retryValue.cost,
      rationale: `${timing.rationale} bandit retry: learned net value ${Math.round(best.meanMinor)} minor (ucb ${Math.round(best.ucbMinor)}${fineNote}).`,
    };
  }

  /** One realized outcome updates the chosen arm's reward model (Sherman–Morrison + b += r·x). */
  update(features: RecoveryFeatures, decision: RecoveryDecision, realizedRewardMinor: number): void {
    const arm = decision.action;
    if (arm !== 'retry' && arm !== 'card_update_comms') return; // suppress has no learnable reward
    const state = this.arms[arm];
    const x = encodeFeatures(features);
    const r = realizedRewardMinor / this.opts.rewardScaleMinor;
    shermanMorrisonUpdate(state.aInv, x);
    for (let i = 0; i < FEATURE_DIM; i++) state.b[i]! += r * x[i]!;
    state.n += 1;
  }

  /** Learned + prior-blended net value (minor) and its UCB for an arm at context x. */
  private scoreArm(arm: BanditArm, x: number[], priorMinor: number): { ucbMinor: number; meanMinor: number } {
    const state = this.arms[arm];
    const theta = matVec(state.aInv, state.b); // A⁻¹b
    const learnedScaled = dot(theta, x); // predicted reward (scaled units)
    const priorScaled = priorMinor / this.opts.rewardScaleMinor;
    // Blend the learned mean onto the cost-aware prior, weighted by how much data this arm has.
    const k = this.opts.priorStrength;
    const blendedScaled = (state.n * learnedScaled + k * priorScaled) / (state.n + k);
    const variance = Math.max(0, dot(x, matVec(state.aInv, x))); // xᵀA⁻¹x
    const bonusScaled = this.opts.alpha * Math.sqrt(variance);
    return {
      meanMinor: blendedScaled * this.opts.rewardScaleMinor,
      ucbMinor: (blendedScaled + bonusScaled) * this.opts.rewardScaleMinor,
    };
  }
}

/** Pick the method to charge: rotate to a fresh/alternate credential when sensible. (Mirrors policy.ts.) */
function selectMethod(features: RecoveryFeatures, methods: AvailableMethod[] | undefined): AvailableMethod | undefined {
  if (!methods || methods.length === 0) return undefined;
  if (features.attemptNumber >= 3) {
    const alternate = methods.find((m) => !m.isDefault);
    if (alternate) return alternate;
  }
  const updated = methods.find((m) => m.autoUpdated);
  if (updated) return updated;
  return methods.find((m) => m.isDefault) ?? methods[0];
}

// Re-export so callers can name the action kind alongside the policy.
export type { RecoveryActionKind };
