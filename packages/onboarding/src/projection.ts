/**
 * Shadow-mode projection (ARCHITECTURE.md §6, dominance-backlog #2).
 *
 * The "see the proven money before you pay a cent" number. During onboarding AX10M
 * runs in SHADOW MODE: it observes the merchant's existing recovery stack for a
 * window (default 14 days) without touching a charge, and PROJECTS the incremental
 * uplift its engine would add. This is deliberately a *projection*, not the
 * holdout-verified number — it is clearly labeled `holdoutVerified: false`. Once
 * the merchant activates, the live randomized holdout (see @ax10m/attribution)
 * replaces the priors below with a measured lower bound, which is the only thing
 * we ever bill on.
 *
 * Honesty guarantees baked into the math:
 *  - We only ever add recoveries among invoices the baseline MISSED, so a
 *    projection can never claim dollars the merchant already recovered for free.
 *  - Priors are conservative and per-decline-code (hard declines ≈ 0 uplift — we
 *    suppress those retries, we don't pretend to recover them).
 *  - A conservative low-end estimate (haircut) is reported alongside the expected
 *    number, and the whole thing is stamped as a pre-activation projection.
 */

import {
  DeclineCode,
  DeclineFamily,
  familyOf,
  type CurrencyCode,
  type Money,
} from '@ax10m/canonical';

/** One observed baseline failure during the shadow window (baseline-only; AX10M did NOT act). */
export interface ShadowObservation {
  declineCode: DeclineCode;
  /** Invoice face value, minor units. */
  amount: number;
  /** Did the merchant's EXISTING stack recover it within the window? */
  baselineRecovered: boolean;
}

/**
 * Prior P(AX10M recovers | baseline missed it), by decline code (falling back to
 * family). Conservative, cross-merchant-derived; used ONLY for the pre-activation
 * projection. The live holdout replaces these with a measured number once active.
 */
const CAPTURE_OF_REMAINING_BY_CODE: Partial<Record<DeclineCode, number>> = {
  [DeclineCode.ExpiredCard]: 0.3, // Account Updater / network token + card-update comms
  [DeclineCode.InsufficientFunds]: 0.22, // retry-timing sweet spot (payday proximity)
  [DeclineCode.IssuerUnavailable]: 0.28, // frequently just needs a later retry
  [DeclineCode.ProcessingError]: 0.25,
  [DeclineCode.TryAgainLater]: 0.25,
  [DeclineCode.DoNotHonor]: 0.12, // gray zone — issuer-and-context dependent
  [DeclineCode.AuthenticationRequired]: 0.1,
};
const CAPTURE_OF_REMAINING_BY_FAMILY: Record<DeclineFamily, number> = {
  [DeclineFamily.Soft]: 0.18,
  [DeclineFamily.Gray]: 0.1,
  [DeclineFamily.Hard]: 0.02, // suppress retries; an occasional card-update comm win
};

/** Prior probability AX10M recovers an invoice the baseline missed, given its decline code. */
export function captureOfRemaining(code: DeclineCode): number {
  return CAPTURE_OF_REMAINING_BY_CODE[code] ?? CAPTURE_OF_REMAINING_BY_FAMILY[familyOf(code)];
}

export interface ProjectionConfig {
  feeRate: number;
  currency: CurrencyCode;
  /** Haircut for the conservative low-end estimate (0.6 → 60% of expected). */
  conservativeHaircut: number;
  /** Days the window projection is scaled to for the monthly figure. */
  monthlyDays: number;
}

export const DEFAULT_PROJECTION_CONFIG: ProjectionConfig = {
  feeRate: 0.12,
  currency: 'USD',
  conservativeHaircut: 0.6,
  monthlyDays: 30,
};

export interface FamilyProjection {
  family: DeclineFamily;
  failures: number;
  baselineRecovered: number;
  /** $ the baseline missed in this family (minor units). */
  missedValue: number;
  /** Effective capture rate applied (projectedValue / missedValue). */
  captureRate: number;
  /** Projected incremental $ in this family over the window (minor units). */
  projectedValue: number;
}

export interface ShadowProjection {
  observedFailures: number;
  baselineRecovered: number;
  baselineRecoveryRate: number;
  /** $ value of invoices the baseline missed over the window (minor units). */
  missedValue: Money;
  /** Expected count of incremental recoveries AX10M would add. */
  projectedIncrementalRecoveries: number;
  /** Expected incremental $ over the OBSERVED window (minor units). */
  projectedWindowValue: Money;
  /** Expected incremental $ scaled to a 30-day month (minor units). */
  projectedMonthlyValue: Money;
  /** Conservative low-end monthly estimate (haircut applied). */
  projectedMonthlyConservative: Money;
  /** Projected monthly fee = feeRate × expected monthly incremental. */
  projectedMonthlyFee: Money;
  byFamily: FamilyProjection[];
  /** Always false: this is a model projection, not a holdout-verified bill. */
  holdoutVerified: false;
}

/**
 * Project the incremental uplift AX10M would add, from baseline-only shadow data.
 *
 * @param observations window-observed baseline failures + whether baseline recovered each.
 * @param elapsedDays days of shadow observation the window represents (for monthly scaling).
 */
export function projectShadow(
  observations: readonly ShadowObservation[],
  elapsedDays: number,
  config: ProjectionConfig = DEFAULT_PROJECTION_CONFIG,
): ShadowProjection {
  const currency = config.currency;
  const money = (amount: number): Money => ({ amount: Math.round(amount), currency });

  const families = new Map<DeclineFamily, { failures: number; baselineRecovered: number; missedValue: number; projectedValue: number }>();
  const bump = (fam: DeclineFamily) => {
    let f = families.get(fam);
    if (!f) {
      f = { failures: 0, baselineRecovered: 0, missedValue: 0, projectedValue: 0 };
      families.set(fam, f);
    }
    return f;
  };

  let baselineRecovered = 0;
  let missedValue = 0;
  let projectedWindow = 0;
  let projectedRecoveries = 0;

  for (const o of observations) {
    const fam = familyOf(o.declineCode);
    const f = bump(fam);
    f.failures += 1;
    if (o.baselineRecovered) {
      f.baselineRecovered += 1;
      baselineRecovered += 1;
      continue; // baseline already got it — AX10M can add nothing here (no double-count)
    }
    const capture = captureOfRemaining(o.declineCode);
    const projected = o.amount * capture;
    f.missedValue += o.amount;
    f.projectedValue += projected;
    missedValue += o.amount;
    projectedWindow += projected;
    projectedRecoveries += capture;
  }

  const observedFailures = observations.length;
  const scale = elapsedDays > 0 ? config.monthlyDays / elapsedDays : 1;
  const projectedMonthly = projectedWindow * scale;

  const byFamily: FamilyProjection[] = [...families.entries()]
    .map(([family, f]) => ({
      family,
      failures: f.failures,
      baselineRecovered: f.baselineRecovered,
      missedValue: Math.round(f.missedValue),
      captureRate: f.missedValue > 0 ? f.projectedValue / f.missedValue : 0,
      projectedValue: Math.round(f.projectedValue),
    }))
    .sort((a, b) => b.projectedValue - a.projectedValue);

  return {
    observedFailures,
    baselineRecovered,
    baselineRecoveryRate: observedFailures > 0 ? baselineRecovered / observedFailures : 0,
    missedValue: money(missedValue),
    projectedIncrementalRecoveries: Math.round(projectedRecoveries),
    projectedWindowValue: money(projectedWindow),
    projectedMonthlyValue: money(projectedMonthly),
    projectedMonthlyConservative: money(projectedMonthly * config.conservativeHaircut),
    projectedMonthlyFee: money(projectedMonthly * config.feeRate),
    byFamily,
    holdoutVerified: false,
  };
}
