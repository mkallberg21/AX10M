/**
 * Uplift computation (ARCHITECTURE.md §3.1–§3.2).
 *
 *   incremental uplift = (treatment recovery rate − control recovery rate)
 *                        × treated failed volume
 *
 * We bill on the LOWER BOUND of the confidence interval, never the point
 * estimate — structural under-claiming is the trust wedge.
 *
 * The interval here is a two-proportion Wald z-interval on the rate difference.
 * That is a deliberate Phase-0 placeholder: the production engine uses
 * always-valid sequential intervals (mSPRT) + CUPED variance reduction. The
 * *shape* (point estimate, lower bound, dollars) is what downstream billing and
 * the Uplift Statement depend on, and that shape is stable.
 */

import type { CurrencyCode, Money } from '@lift/canonical';

/** Aggregated outcomes for one arm of the experiment (within a stratum, or overall). */
export interface ArmStats {
  /** Number of failed invoices assigned to this arm. */
  n: number;
  /** Number of those that were ultimately recovered. */
  recovered: number;
  /** Total failed dollars in this arm (integer minor units). */
  failedVolume: number;
  /** Recovered dollars in this arm (integer minor units). */
  recoveredVolume: number;
}

export interface UpliftConfig {
  /** z multiplier for the interval. 1.96 ≈ 95% two-sided; 1.645 ≈ 90% one-sided. */
  z: number;
  /** Minimum n per arm before an uplift is considered billable. */
  minSamplesPerArm: number;
  /** Fee rate applied to the lower-bound incremental dollars (default 0.12). */
  feeRate: number;
  currency: CurrencyCode;
}

export const DEFAULT_UPLIFT_CONFIG: UpliftConfig = {
  z: 1.96,
  minSamplesPerArm: 200,
  feeRate: 0.12,
  currency: 'USD',
};

export interface UpliftResult {
  controlRate: number;
  treatmentRate: number;
  /** Point estimate of the rate difference (treatment − control). */
  rateDiff: number;
  /** Lower / upper bounds of the rate-difference confidence interval. */
  rateDiffLower: number;
  rateDiffUpper: number;
  /** Point-estimate incremental recovered dollars (minor units). */
  incrementalDollars: number;
  /** LOWER-BOUND incremental recovered dollars — what we bill on (minor units). */
  incrementalDollarsLower: Money;
  /** 12% (feeRate) of the lower-bound incremental dollars. */
  fee: Money;
  /** False when either arm is below minSamplesPerArm — do NOT bill. */
  billable: boolean;
}

/** Recovery rate for an arm, guarding against divide-by-zero. */
export function recoveryRate(arm: ArmStats): number {
  return arm.n === 0 ? 0 : arm.recovered / arm.n;
}

/** Standard error of a proportion. */
function proportionSe(p: number, n: number): number {
  return n === 0 ? 0 : Math.sqrt((p * (1 - p)) / n);
}

/**
 * Compute the billable uplift from control vs treatment arm stats.
 *
 * The rate difference and its CI are scaled by the *treated* failed volume to get
 * incremental recovered dollars: the dollars Lift's engine produced beyond what
 * the baseline (control) would have recovered on the same population.
 */
export function computeUplift(
  control: ArmStats,
  treatment: ArmStats,
  config: UpliftConfig = DEFAULT_UPLIFT_CONFIG,
): UpliftResult {
  const controlRate = recoveryRate(control);
  const treatmentRate = recoveryRate(treatment);
  const rateDiff = treatmentRate - controlRate;

  // SE of the difference of two independent proportions.
  const seControl = proportionSe(controlRate, control.n);
  const seTreatment = proportionSe(treatmentRate, treatment.n);
  const seDiff = Math.sqrt(seControl ** 2 + seTreatment ** 2);
  const margin = config.z * seDiff;

  const rateDiffLower = rateDiff - margin;
  const rateDiffUpper = rateDiff + margin;

  // Scale rate difference by the treated failed volume to get $ uplift.
  const incrementalDollars = Math.round(rateDiff * treatment.failedVolume);
  // Never bill negative: floor the lower bound at zero dollars.
  const lowerDollars = Math.max(0, Math.round(rateDiffLower * treatment.failedVolume));

  const billable =
    control.n >= config.minSamplesPerArm &&
    treatment.n >= config.minSamplesPerArm &&
    rateDiffLower > 0;

  const feeDollars = billable ? Math.round(lowerDollars * config.feeRate) : 0;

  return {
    controlRate,
    treatmentRate,
    rateDiff,
    rateDiffLower,
    rateDiffUpper,
    incrementalDollars,
    incrementalDollarsLower: { amount: lowerDollars, currency: config.currency },
    fee: { amount: feeDollars, currency: config.currency },
    billable,
  };
}

/**
 * Sample-Ratio-Mismatch (SRM) check (ARCHITECTURE.md §3.2).
 * A chi-square goodness-of-fit test that observed control/treatment counts match
 * the intended split. A significant result means assignment is broken → pause
 * billing and alert. Returns the chi-square statistic and whether it breaches.
 */
export function srmCheck(
  controlN: number,
  treatmentN: number,
  expectedControlFraction: number,
  chiSquareThreshold = 10.83, // ~p<0.001, 1 dof
): { chiSquare: number; breached: boolean } {
  const total = controlN + treatmentN;
  if (total === 0) return { chiSquare: 0, breached: false };
  const expControl = total * expectedControlFraction;
  const expTreatment = total * (1 - expectedControlFraction);
  const chiSquare =
    (controlN - expControl) ** 2 / expControl +
    (treatmentN - expTreatment) ** 2 / expTreatment;
  return { chiSquare, breached: chiSquare > chiSquareThreshold };
}
