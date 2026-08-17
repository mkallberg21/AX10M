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
  /** A = λI + Σ xxᵀ (d×d). Kept alongside its inverse so state is SERIALIZABLE and MERGEABLE
   *  (A is additive across observations; the inverse is not). */
  a: number[][];
  /** Inverse of A (d×d) — kept incrementally (Sherman–Morrison) for O(d²) scoring. */
  aInv: number[][];
  /** Σ r·x (length d), reward in scaled units. */
  b: number[];
  /** Number of realized updates for this arm. */
  n: number;
}

/** Serializable snapshot of one arm's sufficient statistics. */
export interface BanditArmSnapshot {
  a: number[][];
  b: number[];
  n: number;
}

/** Serializable bandit state — the persisted, cross-merchant flywheel model. */
export interface LinUcbBanditState {
  version: 1;
  dim: number;
  lambda: number;
  arms: Record<BanditArm, BanditArmSnapshot>;
}

function scaledIdentity(d: number, value: number): number[][] {
  const m: number[][] = [];
  for (let i = 0; i < d; i++) {
    m.push(new Array<number>(d).fill(0));
    m[i]![i] = value;
  }
  return m;
}

function cloneMatrix(m: number[][]): number[][] {
  return m.map((row) => row.slice());
}

/** Gauss–Jordan inverse of a d×d matrix (used at load/merge time, not per decision). */
function invertMatrix(src: number[][]): number[][] {
  const d = src.length;
  const a = src.map((row) => row.slice());
  const inv = scaledIdentity(d, 1);
  for (let col = 0; col < d; col++) {
    // Partial pivot for numerical stability.
    let pivot = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      [inv[col], inv[pivot]] = [inv[pivot]!, inv[col]!];
    }
    const p = a[col]![col]!;
    if (p === 0) continue; // singular column — leave as-is (regularized A is PD, shouldn't happen)
    for (let j = 0; j < d; j++) {
      a[col]![j]! /= p;
      inv[col]![j]! /= p;
    }
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < d; j++) {
        a[r]![j]! -= factor * a[col]![j]!;
        inv[r]![j]! -= factor * inv[col]![j]!;
      }
    }
  }
  return inv;
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
    this.arms = { retry: this.freshArm(), card_update_comms: this.freshArm() };
  }

  private freshArm(): ArmState {
    return {
      a: scaledIdentity(FEATURE_DIM, this.opts.lambda), // A₀ = λI
      aInv: scaledIdentity(FEATURE_DIM, 1 / this.opts.lambda), // A₀⁻¹ = (1/λ)I
      b: new Array<number>(FEATURE_DIM).fill(0),
      n: 0,
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
    shermanMorrisonUpdate(state.aInv, x); // A⁻¹ for scoring
    for (let i = 0; i < FEATURE_DIM; i++) {
      const xi = x[i]!;
      if (xi !== 0) {
        const arow = state.a[i]!;
        for (let j = 0; j < FEATURE_DIM; j++) arow[j]! += xi * x[j]!; // A += xxᵀ (mergeable stat)
      }
      state.b[i]! += r * xi;
    }
    state.n += 1;
  }

  /** Serialize the learned state (the persisted, poolable flywheel model). */
  snapshot(): LinUcbBanditState {
    return {
      version: 1,
      dim: FEATURE_DIM,
      lambda: this.opts.lambda,
      arms: {
        retry: { a: cloneMatrix(this.arms.retry.a), b: this.arms.retry.b.slice(), n: this.arms.retry.n },
        card_update_comms: { a: cloneMatrix(this.arms.card_update_comms.a), b: this.arms.card_update_comms.b.slice(), n: this.arms.card_update_comms.n },
      },
    };
  }

  /** Restore learned state (e.g. loaded from the store at startup). Recomputes A⁻¹ once. */
  restore(state: LinUcbBanditState): void {
    if (state.dim !== FEATURE_DIM) throw new Error(`LinUcbBanditPolicy.restore: dim ${state.dim} != FEATURE_DIM ${FEATURE_DIM}`);
    for (const arm of ARMS) {
      const s = state.arms[arm];
      this.arms[arm] = { a: cloneMatrix(s.a), aInv: invertMatrix(s.a), b: s.b.slice(), n: s.n };
    }
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

// ── Cross-merchant flywheel: persistable, mergeable state ───────────────────────

/** An empty (prior-only) bandit state — the baseline when nothing is persisted yet. */
export function emptyBanditState(lambda = DEFAULT_LINUCB_OPTIONS.lambda): LinUcbBanditState {
  const arm = (): BanditArmSnapshot => ({ a: scaledIdentity(FEATURE_DIM, lambda), b: new Array<number>(FEATURE_DIM).fill(0), n: 0 });
  return { version: 1, dim: FEATURE_DIM, lambda, arms: { retry: arm(), card_update_comms: arm() } };
}

/**
 * Merge a local DELTA into the persisted flywheel state, additively:
 *   merged = persisted + (current − baseline)
 * The sufficient statistics A (= λI + Σxxᵀ) and b (= Σr·x) are additive across observations, and
 * the delta (current − baseline) is a pure sum of new observations (the shared λI cancels), so two
 * processes' contributions combine correctly. This is how the API and the worker pool their
 * learning into ONE cross-merchant model. (Under true concurrency the read-modify-write around
 * this still needs a row lock — a documented hardening follow-up.)
 */
export function mergeBanditDelta(persisted: LinUcbBanditState, current: LinUcbBanditState, baseline: LinUcbBanditState): LinUcbBanditState {
  const d = persisted.dim;
  const mergeArm = (p: BanditArmSnapshot, c: BanditArmSnapshot, base: BanditArmSnapshot): BanditArmSnapshot => {
    const a = cloneMatrix(p.a);
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) a[i]![j]! += c.a[i]![j]! - base.a[i]![j]!;
    const b = p.b.slice();
    for (let i = 0; i < d; i++) b[i]! += c.b[i]! - base.b[i]!;
    return { a, b, n: p.n + (c.n - base.n) };
  };
  return {
    version: 1,
    dim: d,
    lambda: persisted.lambda,
    arms: {
      retry: mergeArm(persisted.arms.retry, current.arms.retry, baseline.arms.retry),
      card_update_comms: mergeArm(persisted.arms.card_update_comms, current.arms.card_update_comms, baseline.arms.card_update_comms),
    },
  };
}
