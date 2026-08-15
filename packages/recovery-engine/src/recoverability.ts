/**
 * Recoverability model — P(recover | we act) for a failed invoice.
 *
 * This is the FIRST half of the recovery brain: given the decline and the customer
 * context, how likely are we to get the money if we retry (and how much better than
 * doing nothing)? The heuristic below is a grounded COLD-START baseline — it is not
 * yet a trained model and makes no claim to beat the incumbent on its own. Its job
 * is to (a) be a sane default before we have data, and (b) define the exact feature
 * contract and `RecoverabilityModel` interface a trained model / contextual bandit
 * drops into unchanged.
 *
 * HONESTY: the differentiator is not this scorer — a naive retry can match it. The
 * differentiator is measured incremental lift over the baseline (see @ax10m/
 * attribution) and the ability to *learn* per-issuer timing at scale. This file is
 * the seam that learning plugs into.
 */

import { DeclineCode, DeclineFamily, familyOf, type IssuerRegion } from '@ax10m/canonical';

/** Card product type — a BIN-derived signal (debit/prepaid recover differently than credit). */
export type CardProductType = 'credit' | 'debit' | 'prepaid' | 'unknown';

/** Everything the model sees. All pre-decision / observed-at-failure — no leakage. */
export interface RecoveryFeatures {
  declineCode: DeclineCode;
  amountMinor: number;
  currency: string;
  issuerRegion: IssuerRegion;
  /** BIN-derived card product type (credit/debit/prepaid); 'unknown' when the BIN is unmapped. */
  cardType?: CardProductType;
  /** Customer age at failure, days. */
  customerTenureDays: number;
  /** Customer's historical share of failed invoices eventually recovered, 0..1. */
  priorRecoveryRate: number;
  /** 1-based attempt number for this invoice. */
  attemptNumber: number;
  /** Days since the first decline on this invoice. */
  daysSinceFirstFail: number;
  /** Cross-merchant issuer/BIN approval propensity, 0..1 (neutral 0.5 if unknown). */
  issuerApprovalPrior?: number;
}

export interface RecoverabilityModel {
  /** P(recover | act now), clamped to [0,1]. */
  score(f: RecoveryFeatures): number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const logistic = (z: number): number => 1 / (1 + Math.exp(-z));

/** Base log-odds contribution by decline code — the dominant signal. */
function baseLogOdds(code: DeclineCode): number {
  switch (familyOf(code)) {
    case DeclineFamily.Hard:
      return -3.2; // ~4% — lost/stolen/closed rarely recover on the same credential
    case DeclineFamily.Gray:
      return code === DeclineCode.ExpiredCard ? -2.0 : -0.4; // expired needs an update, not a retry
    case DeclineFamily.Soft:
    default:
      // Soft declines are the bread and butter. Issuer-unavailable/try-again recover
      // the most; insufficient-funds is timing-dependent.
      if (code === DeclineCode.IssuerUnavailable || code === DeclineCode.TryAgainLater || code === DeclineCode.ProcessingError) return 1.1;
      return 0.5; // insufficient_funds, velocity, auth-required
  }
}

/**
 * Grounded heuristic recoverability. Combines the decline base rate with customer,
 * issuer, amount, and attempt-decay signals via a logistic link. Every term has a
 * documented sign; the magnitudes are conservative and meant to be replaced by
 * fitted coefficients once outcome data exists.
 */
export class HeuristicRecoverability implements RecoverabilityModel {
  score(f: RecoveryFeatures): number {
    let z = baseLogOdds(f.declineCode);

    // Customer history: a customer who usually recovers is more likely to again.
    z += (f.priorRecoveryRate - 0.4) * 1.5;

    // Cross-merchant issuer/BIN prior (the data-flywheel signal): centered at 0.5.
    z += ((f.issuerApprovalPrior ?? 0.5) - 0.5) * 1.2;

    // Attempt decay: each successive failed attempt lowers the odds of the next.
    z -= Math.max(0, f.attemptNumber - 1) * 0.45;

    // Staleness: the longer an invoice sits failed, the lower the odds.
    z -= Math.max(0, f.daysSinceFirstFail - 3) * 0.05;

    // Tenure: long-tenured customers recover slightly more (engaged relationship).
    z += Math.min(f.customerTenureDays / 365, 3) * 0.1;

    // Large tickets recover slightly less (more likely a genuine funds problem).
    const usdish = f.amountMinor / 100;
    z -= Math.min(usdish / 1000, 2) * 0.15;

    return clamp01(logistic(z));
  }
}
