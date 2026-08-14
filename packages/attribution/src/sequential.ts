/**
 * Billing-safe uplift estimation (ATTRIBUTION.md §4–§7).
 *
 * This is the estimator we are ALLOWED to bill on. It replaces the fixed-horizon
 * Wald interval in `uplift.ts` (which is a rate diagnostic only) with the three
 * pieces the spec requires for honest, peeking-safe billing:
 *
 *   1. CUPED variance reduction (§4.6)          — tighter interval, zero bias.
 *   2. Post-stratification + cluster-robust SE  — customer is the randomization
 *      unit, so invoices within a customer are correlated (§4.4–§4.5).
 *   3. An always-valid mSPRT confidence sequence (§5) — so we may read the metric
 *      continuously (daily dashboard, monthly billing) and bill the LOWER BOUND
 *      at any moment with the (1−α) coverage guarantee intact.
 *
 * We bill 12% of `max(0, L$)` where `L$` is the lower bound of the confidence
 * sequence scaled to treated volume (§1.5, §5.3). Two structural under-claims
 * stack: we take the lower end of the interval, and we floor a not-yet-significant
 * month at $0. A billing error should almost always favor the merchant.
 *
 * NOTE: nothing here uses randomness, wall-clock time, or un-versioned model
 * output — given the ledger, the exact bill is recomputable (invariant #3).
 */

import type { CurrencyCode, Money } from '@ax10m/canonical';
import { srmCheck } from './uplift.js';

/**
 * One window-closed failed invoice, labeled with its arm, its randomization
 * cluster (the customer), its stratum, the billable dollar outcome `Y_i`, and a
 * pre-failure covariate `X_i` for CUPED. Outcomes are observed per invoice;
 * assignment is per customer (`cluster`).
 */
export interface UpliftObservation {
  arm: 'control' | 'treatment';
  /** Randomization unit — the customer id. Invoices sharing a cluster are correlated. */
  cluster: string;
  /** Serialized stratum key (MRR tier × decline family × issuer region). */
  stratum: string;
  /** Billable dollar outcome Y_i in integer minor units (R_i, or R_i+S_i in full-value mode). */
  outcome: number;
  /** Pre-failure covariate X_i (e.g. invoice amount, or model-predicted outcome for CUPAC). */
  covariate: number;
  /** Binary recovery, for the diagnostic recovery-rate lift only (not billed). */
  recovered: boolean;
}

export interface SequentialUpliftConfig {
  /** Confidence-sequence level. Default 0.05 (95% CS). The under-claim is the brand. */
  alpha: number;
  /**
   * mSPRT mixture (tuning) variance τ², on the per-invoice EFFECT scale (minor
   * units²). Heuristically ≈ (anticipated per-invoice uplift)². COMMITTED per
   * epoch in the ledger BEFORE reading outcomes — any τ²>0 is valid; tuning only
   * affects tightness, never coverage (§5.2).
   */
  tau2: number;
  /** Fee applied to the newly-proven lower-bound dollars. Default 0.12. */
  feeRate: number;
  /** Min distinct control customers before ANY fee (default 300, §6.3). */
  minControlClusters: number;
  /** Min treated invoices before ANY fee (default 300, §6.3). */
  minTreatedInvoices: number;
  /** Per-stratum floor (invoices per arm) before a stratum is billed on its own; smaller strata are pooled (§2.5, §6.3). */
  perStratumFloor: number;
  /** Expected control share for the SRM check, tested at cluster grain (§6.1). */
  expectedControlFraction: number;
  /** SRM chi-square auto-pause threshold (default 10.83 ≈ p<0.001, 1 dof). */
  srmThreshold: number;
  currency: CurrencyCode;
  /** Apply CUPED (§4.6). Falls back to the raw difference of means if false or if the covariate is uninformative. */
  useCuped: boolean;
}

export const DEFAULT_SEQUENTIAL_CONFIG: SequentialUpliftConfig = {
  alpha: 0.05,
  tau2: 4_000_000, // ≈ ($20/invoice)² in minor units; commit per epoch in production.
  feeRate: 0.12,
  minControlClusters: 300,
  minTreatedInvoices: 300,
  perStratumFloor: 50,
  expectedControlFraction: 0.1,
  srmThreshold: 10.83,
  currency: 'USD',
  useCuped: true,
};

/** Per-stratum breakdown for the statement / dashboard cohort table. */
export interface StratumLine {
  stratumKey: string;
  controlInvoices: number;
  treatmentInvoices: number;
  controlRate: number;
  treatmentRate: number;
  /** Point-estimate incremental $ per treated invoice within this stratum (minor units). */
  deltaPerStratum: number;
  /** Treated-volume weight w_s used in the post-stratified aggregate. */
  weight: number;
  /** Whether this stratum met the per-arm floor (else it was pooled). */
  metFloor: boolean;
  pooled: boolean;
}

export interface BillableUpliftResult {
  /** Diagnostic recovery-rate lift (§4.2) — headline, NOT billed. */
  controlRate: number;
  treatmentRate: number;
  rateDiff: number;

  /** CUPED coefficient θ* and the variance-reduction factor achieved (0 = none). */
  cupedTheta: number;
  cupedVarianceReduction: number;

  /** Post-stratified, CUPED-adjusted incremental $ per treated invoice (minor units, §4.3–§4.4). */
  deltaPer: number;
  /** Cluster-robust SE of `deltaPer` (§4.5). */
  se: number;
  /** Effective sample size implied by the cluster-robust SE (accounts for clustering + stratification, §5.2). */
  effectiveN: number;
  /** mSPRT confidence-sequence half-width per treated invoice (§5.2). */
  halfWidth: number;
  /** Per-invoice lower bound L_per = max(0, deltaPer − halfWidth) (§5.3). */
  lowerPer: number;

  treatedInvoices: number;
  controlClusters: number;

  /** Cumulative proven lower-bound dollars this epoch (minor units): L$ = lowerPer × treatedInvoices. */
  lowerDollarsCum: Money;
  /** Cumulative dollars already billed in prior periods (minor units). */
  priorBilledDollars: Money;
  /** Newly proven this period = lowerDollarsCum − priorBilledDollars (can be negative → credit, §7.4). */
  billableIncrement: Money;
  /** 12% (feeRate) of the billable increment. Zero when not billable; negative = credit. */
  fee: Money;

  /** SRM chi-square at cluster grain + whether it breached (auto-pause, §6.1). */
  srm: { chiSquare: number; breached: boolean };
  /** True only if every §6.3 gate passed. When false, `fee` is $0. */
  billable: boolean;
  /** Human-readable reasons a fee was withheld (empty when billable). */
  gateReasons: string[];

  perStratum: StratumLine[];
}

// ─────────────────────────────────────────────────────────────────────────────
// mSPRT normal-mixture confidence sequence (ATTRIBUTION.md §5.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Half-width of the (1−α) mSPRT normal-mixture confidence sequence, EXACTLY as
 * specified (ATTRIBUTION.md §5.2):
 *
 *            ┌                                              ┐
 *            │   σ²·(n·τ² + σ²)              n·τ² + σ²      │
 *   h_n =  √ │  ───────────────── · log( ───────────────── ) │
 *            │      n²·τ²                     α²·σ²          │
 *            └                                              ┘
 *
 * where `σ²` (perObsVar) is the per-observation variance with Var(θ̂_n) = σ²/n and
 * `n` the (effective) sample size. Valid for any τ²>0; the log argument is always
 * ≥ 1/α² > 1 (since α<1), so the radicand is non-negative for all inputs. As
 * n→∞, h_n → 0 at rate √(log n / n) — the small, honest conservatism of anytime
 * validity vs. a fixed-horizon CI.
 */
export function msprtHalfWidth(
  perObsVar: number,
  n: number,
  tau2: number,
  alpha: number,
): number {
  if (perObsVar <= 0 || n <= 0 || tau2 <= 0) return 0;
  const nTau2PlusVar = n * tau2 + perObsVar;
  const prefactor = (perObsVar * nTau2PlusVar) / (n * n * tau2);
  const logArg = nTau2PlusVar / (alpha * alpha * perObsVar);
  return Math.sqrt(prefactor * Math.log(logArg));
}

/**
 * The same confidence sequence expressed directly in the standard error of the
 * estimated effect. Algebraically identical to `msprtHalfWidth(σ², n, τ², α)`
 * with n = σ²/SE² (the effective sample size), and independent of the arbitrary
 * scale of σ² — only SE, τ², and α matter. Convenient when you already have a
 * cluster-robust SE.
 */
export function msprtHalfWidthFromSe(se: number, tau2: number, alpha: number): number {
  if (se <= 0 || tau2 <= 0) return 0;
  const se2 = se * se;
  return se * Math.sqrt((1 + se2 / tau2) * Math.log((tau2 + se2) / (alpha * alpha * se2)));
}

// ─────────────────────────────────────────────────────────────────────────────
// CUPED variance reduction (ATTRIBUTION.md §4.6)
// ─────────────────────────────────────────────────────────────────────────────

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Population variance. */
function variance(xs: readonly number[], xbar = mean(xs)): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += (x - xbar) ** 2;
  return s / xs.length;
}

export interface CupedFit {
  /** θ* = Cov(Y, X) / Var(X), pooled across arms (§4.6). */
  theta: number;
  /** Grand mean of the covariate. */
  xbar: number;
  /** Variance reduction factor 1 − ρ² actually achieved (0 = none). */
  varianceReduction: number;
}

/**
 * Fit the single-covariate CUPED adjustment on the pooled sample. θ* and X̄ are
 * derived from data that is (by construction) independent of arm assignment, so
 * the adjustment is unbiased: E[Y^cuped] = E[Y], only the variance shrinks.
 * If the covariate carries no signal (Var(X)=0 or ρ≈0), θ*→0 and we fall back to
 * the raw outcome — CUPED can never MANUFACTURE lift.
 */
export function fitCuped(outcomes: readonly number[], covariates: readonly number[]): CupedFit {
  const n = outcomes.length;
  if (n < 2 || covariates.length !== n) return { theta: 0, xbar: mean(covariates), varianceReduction: 0 };
  const ybar = mean(outcomes);
  const xbar = mean(covariates);
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dy = outcomes[i]! - ybar;
    const dx = covariates[i]! - xbar;
    cov += dy * dx;
    varX += dx * dx;
    varY += dy * dy;
  }
  cov /= n;
  varX /= n;
  varY /= n;
  if (varX <= 0 || varY <= 0) return { theta: 0, xbar, varianceReduction: 0 };
  const theta = cov / varX;
  const rho = cov / Math.sqrt(varX * varY);
  return { theta, xbar, varianceReduction: rho * rho };
}

/** Apply a fitted CUPED adjustment to one outcome: Y^cuped = Y − θ*·(X − X̄). */
export function applyCuped(outcome: number, covariate: number, fit: CupedFit): number {
  return outcome - fit.theta * (covariate - fit.xbar);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster-robust variance (ATTRIBUTION.md §4.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cluster-robust variance of an arm mean within a stratum (§4.5):
 *
 *   V̂[Ȳ_a,s] = (1/n²) · Σ_k ( Σ_{i∈k} (Y_i − Ȳ_a,s) )² · G/(G−1)
 *
 * where clusters `k` are customers, `n` invoices in the arm-stratum, and `G` the
 * number of clusters. Using cluster-sums (not the iid formula) is what keeps the
 * interval honest when invoices within a customer are correlated; skipping it
 * would understate uncertainty and over-bill.
 */
function clusteredArmVariance(values: readonly number[], clusters: readonly string[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const ybar = mean(values);
  const clusterResidualSum = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = clusters[i]!;
    clusterResidualSum.set(k, (clusterResidualSum.get(k) ?? 0) + (values[i]! - ybar));
  }
  let sumSq = 0;
  for (const s of clusterResidualSum.values()) sumSq += s * s;
  const g = clusterResidualSum.size;
  const smallG = g > 1 ? g / (g - 1) : 1;
  return (sumSq / (n * n)) * smallG;
}

// ─────────────────────────────────────────────────────────────────────────────
// The billable estimator (ATTRIBUTION.md §4.7, §7.1)
// ─────────────────────────────────────────────────────────────────────────────

interface ArmSlice {
  values: number[]; // CUPED-adjusted outcomes
  clusters: string[];
  recovered: number;
}

function countDistinct(xs: Iterable<string>): number {
  return new Set(xs).size;
}

/**
 * Compute the billable uplift from window-closed observations.
 *
 * @param observations window-closed failed invoices with arm/cluster/stratum/outcome/covariate.
 * @param priorBilledDollars cumulative lower-bound dollars already billed this epoch (minor units) — the increment is billed, never re-billed (§7.4).
 */
export function computeBillableUplift(
  observations: readonly UpliftObservation[],
  config: SequentialUpliftConfig = DEFAULT_SEQUENTIAL_CONFIG,
  priorBilledDollars = 0,
): BillableUpliftResult {
  // Config validation — a misconfigured alpha/tau2 would silently produce a NaN or
  // wrong bill, so fail fast on the billing path.
  if (!(config.alpha > 0 && config.alpha < 1)) throw new RangeError(`alpha must be in (0,1); got ${config.alpha}`);
  if (!(config.tau2 > 0)) throw new RangeError(`tau2 must be > 0; got ${config.tau2}`);
  if (!(config.feeRate >= 0 && config.feeRate <= 1)) throw new RangeError(`feeRate must be in [0,1]; got ${config.feeRate}`);

  const currency = config.currency;

  // 1. CUPED fit on the pooled sample (arm-independent by construction).
  const rawOutcomes = observations.map((o) => o.outcome);
  const covariates = observations.map((o) => o.covariate);
  const cuped: CupedFit = config.useCuped
    ? fitCuped(rawOutcomes, covariates)
    : { theta: 0, xbar: mean(covariates), varianceReduction: 0 };
  const adj = (o: UpliftObservation) => (config.useCuped ? applyCuped(o.outcome, o.covariate, cuped) : o.outcome);

  // 2. Determine which strata clear the per-arm floor; pool the rest (§2.5).
  const byStratum = new Map<string, UpliftObservation[]>();
  for (const o of observations) {
    const arr = byStratum.get(o.stratum);
    if (arr) arr.push(o);
    else byStratum.set(o.stratum, [o]);
  }
  const POOLED = '__pooled__';
  const stratumMetFloor = new Map<string, boolean>();
  for (const [key, obs] of byStratum) {
    const c = obs.filter((o) => o.arm === 'control').length;
    const t = obs.filter((o) => o.arm === 'treatment').length;
    stratumMetFloor.set(key, c >= config.perStratumFloor && t >= config.perStratumFloor);
  }
  // Effective stratum label: sub-floor strata collapse into one pooled bucket.
  const effStratum = (key: string) => (stratumMetFloor.get(key) ? key : POOLED);

  // 3. Build arm slices per effective stratum, on CUPED-adjusted outcomes.
  const strata = new Map<string, { control: ArmSlice; treatment: ArmSlice }>();
  const emptySlice = (): ArmSlice => ({ values: [], clusters: [], recovered: 0 });
  for (const o of observations) {
    const key = effStratum(o.stratum);
    let cell = strata.get(key);
    if (!cell) {
      cell = { control: emptySlice(), treatment: emptySlice() };
      strata.set(key, cell);
    }
    const slice = o.arm === 'control' ? cell.control : cell.treatment;
    slice.values.push(adj(o));
    slice.clusters.push(o.cluster);
    if (o.recovered) slice.recovered += 1;
  }

  const treatedInvoices = observations.filter((o) => o.arm === 'treatment').length;
  const controlClusters = countDistinct(
    observations.filter((o) => o.arm === 'control').map((o) => o.cluster),
  );
  const treatmentClusters = countDistinct(
    observations.filter((o) => o.arm === 'treatment').map((o) => o.cluster),
  );

  // 4. Post-stratified point estimate + cluster-robust variance (§4.4–§4.5).
  let deltaPer = 0;
  let varDelta = 0;
  // A stratum with an empty arm (mean of [] = 0 → inflated delta) or a single
  // cluster per arm (cluster-robust variance is 0 by construction → understated
  // SE → over-bill) is UNESTIMABLE; we gate billing off it rather than trust it.
  let anyStratumUnestimable = false;
  const perStratum: StratumLine[] = [];
  for (const [key, cell] of strata) {
    const nT = cell.treatment.values.length;
    const nC = cell.control.values.length;
    const gT = new Set(cell.treatment.clusters).size;
    const gC = new Set(cell.control.clusters).size;
    if (nT < 1 || nC < 1 || gT < 2 || gC < 2) anyStratumUnestimable = true;
    const wS = treatedInvoices > 0 ? nT / treatedInvoices : 0;
    const ybarT = mean(cell.treatment.values);
    const ybarC = mean(cell.control.values);
    const deltaS = ybarT - ybarC;
    deltaPer += wS * deltaS;
    const vT = clusteredArmVariance(cell.treatment.values, cell.treatment.clusters);
    const vC = clusteredArmVariance(cell.control.values, cell.control.clusters);
    varDelta += wS * wS * (vT + vC);
    perStratum.push({
      stratumKey: key,
      controlInvoices: nC,
      treatmentInvoices: nT,
      controlRate: nC > 0 ? cell.control.recovered / nC : 0,
      treatmentRate: nT > 0 ? cell.treatment.recovered / nT : 0,
      deltaPerStratum: deltaS,
      weight: wS,
      metFloor: key !== POOLED,
      pooled: key === POOLED,
    });
  }
  const se = Math.sqrt(Math.max(0, varDelta));

  // 5. mSPRT confidence sequence → per-invoice lower bound (§5.2–§5.3).
  // Compute the half-width directly from the cluster-robust SE. The (σ²/SE²)
  // effective-N round-trip could overflow to Infinity for a tiny SE → a NaN fee
  // that slips the gate; the SE form is finite and degrades to 0 when SE=0.
  const perObsVar = variance(observations.map(adj));
  const effectiveN = perObsVar > 0 && se > 0 ? perObsVar / (se * se) : 0; // reported for transparency only
  const halfWidth = msprtHalfWidthFromSe(se, config.tau2, config.alpha);
  const lowerPer = Math.max(0, deltaPer - halfWidth);

  // 6. Diagnostics: pooled recovery rates (headline, not billed).
  const totalControl = observations.filter((o) => o.arm === 'control');
  const totalTreatment = observations.filter((o) => o.arm === 'treatment');
  const controlRate = totalControl.length > 0 ? totalControl.filter((o) => o.recovered).length / totalControl.length : 0;
  const treatmentRate = totalTreatment.length > 0 ? totalTreatment.filter((o) => o.recovered).length / totalTreatment.length : 0;

  // 7. SRM at cluster grain (§6.1).
  const srm = srmCheck(controlClusters, treatmentClusters, config.expectedControlFraction, config.srmThreshold);

  // 8. Billing gates (§6.3).
  const gateReasons: string[] = [];
  if (controlClusters < config.minControlClusters)
    gateReasons.push(`control customers ${controlClusters} < ${config.minControlClusters}`);
  if (treatedInvoices < config.minTreatedInvoices)
    gateReasons.push(`treated invoices ${treatedInvoices} < ${config.minTreatedInvoices}`);
  if (se <= 0 || !Number.isFinite(halfWidth)) gateReasons.push('standard error unestimable (insufficient variation)');
  if (anyStratumUnestimable) gateReasons.push('a stratum has an empty arm or <2 clusters (variance unestimable)');
  if (lowerPer <= 0) gateReasons.push('lower bound not yet positive (lift unproven)');
  if (srm.breached) gateReasons.push(`SRM breached (χ²=${srm.chiSquare.toFixed(2)})`);
  const anyFloorStratumMissing = perStratum.some((l) => l.pooled && l.treatmentInvoices + l.controlInvoices > 0 && (l.treatmentInvoices < config.perStratumFloor || l.controlInvoices < config.perStratumFloor));
  if (anyFloorStratumMissing) gateReasons.push('pooled residual stratum below floor');
  const billable = gateReasons.length === 0;

  // 9. Fee on the newly-proven increment (§7.4). Never re-bill; credits ALWAYS
  // settle: a negative increment (clawback) is issued as a credit even when the
  // positive-lift gate fails, never silently absorbed to 0.
  const lowerDollarsCum = Math.round(lowerPer * treatedInvoices);
  const billableIncrement = lowerDollarsCum - priorBilledDollars;
  const shouldSettle = billable || billableIncrement < 0;
  const fee = shouldSettle ? Math.round(config.feeRate * billableIncrement) : 0;

  return {
    controlRate,
    treatmentRate,
    rateDiff: treatmentRate - controlRate,
    cupedTheta: cuped.theta,
    cupedVarianceReduction: cuped.varianceReduction,
    deltaPer,
    se,
    effectiveN,
    halfWidth,
    lowerPer,
    treatedInvoices,
    controlClusters,
    lowerDollarsCum: { amount: lowerDollarsCum, currency },
    priorBilledDollars: { amount: priorBilledDollars, currency },
    billableIncrement: { amount: billableIncrement, currency },
    fee: { amount: fee, currency },
    srm,
    billable,
    gateReasons,
    perStratum,
  };
}
