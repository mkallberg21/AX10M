/**
 * Holdout economics — makes the randomized-holdout measurement merchant-friendly.
 *
 * The holdout is what lets AX10M bill only PROVEN lift, but it has a real cost to the merchant:
 * the recovery they forgo on the held-out control group (which AX10M deliberately doesn't treat).
 * A permanent 10% holdout can cost roughly as much as the fee itself. Two mechanisms fix that:
 *
 *   1. TAPER. A full-holdout CERTIFICATION window (default 90 days at 10%) proves the lift, then
 *      the holdout tapers to a thin permanent AUDIT holdout (default 2%) — enough to keep the
 *      measurement honest, small enough that the forgone recovery is minor.
 *   2. CREDIT. The estimated forgone recovery is credited against the fee, so the merchant's TOTAL
 *      cost (fee paid + recovery forgone) stays ≈ the fee — i.e. the effective rate stays ~12%
 *      even during the full-holdout certification window (when the merchant effectively pays ~$0
 *      and gets the signed proof).
 *
 * Both are disclosed on the Uplift Statement so the purest measurement is never a hidden cost.
 */

export interface HoldoutScheduleConfig {
  /** Length of the full-holdout certification window, in days from onboarding. */
  certificationDays: number;
  /** Holdout fraction during certification (e.g. 0.10 = 10%). */
  certificationFraction: number;
  /** Thin permanent audit-holdout fraction after certification (e.g. 0.02 = 2%). */
  auditFraction: number;
}

export const DEFAULT_HOLDOUT_SCHEDULE: HoldoutScheduleConfig = {
  certificationDays: 90,
  certificationFraction: 0.1,
  auditFraction: 0.02,
};

/** The holdout fraction as-of a date: the full certification fraction until the window closes, then the audit fraction. */
export function holdoutFractionFor(onboardedAtIso: string, asOfIso: string, cfg: HoldoutScheduleConfig = DEFAULT_HOLDOUT_SCHEDULE): number {
  const onb = Date.parse(onboardedAtIso);
  const asOf = Date.parse(asOfIso);
  if (Number.isNaN(onb) || Number.isNaN(asOf)) return cfg.certificationFraction; // unknown onboarding → assume certifying (conservative: larger credit)
  const days = (asOf - onb) / 86_400_000;
  return days < cfg.certificationDays ? cfg.certificationFraction : cfg.auditFraction;
}

export interface HoldoutEconomics {
  /** The holdout fraction in force this period (from the taper schedule). */
  holdoutFraction: number;
  /** Estimated recovery the merchant forwent on the held-out control group this period (minor units). */
  estimatedHoldoutCostMinor: number;
  /** The gross fee (12% of proven lift), minor units. */
  grossFeeMinor: number;
  /** Credit applied against the fee to offset the holdout cost (minor units), capped at the fee. */
  holdoutCreditMinor: number;
  /** What the merchant is actually billed after the credit (minor units), floored at 0. */
  netBilledMinor: number;
}

/**
 * Compute the holdout cost + credit for a period. The forgone recovery is the per-invoice
 * incremental lift applied to the volume held out at the current fraction: for a holdout fraction
 * h and `treatedInvoices` treated, the held-out count ≈ treated × h/(1−h) (same population rate),
 * and the cost is that count × the per-invoice lift point estimate. The credit offsets it (capped
 * at the fee), so net billed = fee − credit.
 */
export function computeHoldoutEconomics(params: {
  grossFeeMinor: number;
  perInvoiceLiftMinor: number;
  treatedInvoices: number;
  holdoutFraction: number;
}): HoldoutEconomics {
  const h = Math.max(0, Math.min(0.99, params.holdoutFraction));
  const heldOutInvoices = h > 0 ? params.treatedInvoices * (h / (1 - h)) : 0;
  const cost = Math.max(0, Math.round(Math.max(0, params.perInvoiceLiftMinor) * heldOutInvoices));
  const credit = Math.min(Math.max(0, params.grossFeeMinor), cost);
  return {
    holdoutFraction: h,
    estimatedHoldoutCostMinor: cost,
    grossFeeMinor: params.grossFeeMinor,
    holdoutCreditMinor: credit,
    netBilledMinor: Math.max(0, params.grossFeeMinor - credit),
  };
}
