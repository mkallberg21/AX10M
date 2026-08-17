/**
 * ICP + time-to-proven-lift quote — the sales-time answer to "will AX10M work for us, and when
 * will the holdout prove it?". Because AX10M bills only PROVEN lower-bound lift, a merchant needs
 * enough failed-payment volume for the sequential test (mSPRT) to clear the boundary within the
 * certification window. This estimates that from a merchant's volume + a few rate assumptions.
 *
 * It is an ANALYTIC PLANNING ESTIMATE, not a guarantee: the always-valid boundary is approximated
 * by a widened z, and the real timing depends on the live holdout. Labeled as such in the output.
 */

export interface IcpQuoteInput {
  /** Failed payments per month (the raw volume the holdout draws from). */
  monthlyFailedPayments: number;
  /** Average invoice amount, minor units. */
  avgInvoiceAmountMinor: number;
  /** Baseline (control-arm) recovery rate, 0..1 (what the processor's own retries recover). */
  baselineRecoveryRate: number;
  /** Expected incremental recovery from AX10M, in rate POINTS (0.05 = +5pp over baseline). */
  upliftRatePoints: number;
  /** Randomized holdout fraction (default 0.10). */
  controlFraction?: number;
  /** Fee rate (default 0.12). */
  feeRate?: number;
  /** Certification window to prove lift within, days (default 90). */
  certificationDays?: number;
}

export interface IcpQuote {
  /** True if the holdout is estimated to prove positive lift within the certification window. */
  clearsIcpFloor: boolean;
  /** Minimum monthly failed-payment volume to prove within the certification window. */
  minMonthlyFailedPayments: number;
  /** Estimated days until the lower bound clears zero (null if the effect is too small to ever prove). */
  estimatedDaysToProvenLift: number | null;
  /** Expected incremental recovered value per month (minor units) on the treated population. */
  expectedMonthlyLiftMinor: number;
  /** Estimated monthly fee once proven = feeRate × expected monthly lift (minor units). */
  estimatedProvenMonthlyFeeMinor: number;
  assumptions: {
    controlFraction: number;
    feeRate: number;
    certificationDays: number;
    treatmentRate: number;
    perInvoiceLiftMinor: number;
    mixtureBoundaryZ: number;
  };
  note: string;
}

// The always-valid (mSPRT) boundary is wider than a fixed-n 1.96; ~2.5 is a reasonable planning
// constant for the mixture boundary at the volumes/effects this quote targets.
const MIXTURE_BOUNDARY_Z = 2.5;

export function icpQuote(input: IcpQuoteInput): IcpQuote {
  const controlFraction = input.controlFraction ?? 0.1;
  const feeRate = input.feeRate ?? 0.12;
  const certificationDays = input.certificationDays ?? 90;

  const treatmentRate = Math.min(0.999, Math.max(0, input.baselineRecoveryRate) + Math.max(0, input.upliftRatePoints));
  const perInvoiceLiftMinor = Math.max(0, input.upliftRatePoints) * input.avgInvoiceAmountMinor;
  // SD of per-invoice recovered $ under treatment ≈ amount × sqrt(p(1−p)) (Bernoulli recovery × amount).
  const p = treatmentRate;
  const sigma = input.avgInvoiceAmountMinor * Math.sqrt(Math.max(0, p * (1 - p)));
  const delta = perInvoiceLiftMinor;

  const treatedPerMonth = Math.max(0, input.monthlyFailedPayments) * (1 - controlFraction);

  let nNeeded = Infinity;
  let estimatedDaysToProvenLift: number | null = null;
  if (delta > 0 && sigma > 0 && treatedPerMonth > 0) {
    nNeeded = ((MIXTURE_BOUNDARY_Z * sigma) / delta) ** 2; // treated invoices to shrink half-width below delta
    estimatedDaysToProvenLift = Math.ceil((nNeeded / treatedPerMonth) * 30);
  }

  const minMonthlyFailedPayments = delta > 0 && sigma > 0
    ? Math.ceil(nNeeded / ((1 - controlFraction) * (certificationDays / 30)))
    : Number.POSITIVE_INFINITY;

  const clearsIcpFloor = estimatedDaysToProvenLift !== null && estimatedDaysToProvenLift <= certificationDays;
  const expectedMonthlyLiftMinor = Math.round(perInvoiceLiftMinor * treatedPerMonth);
  const estimatedProvenMonthlyFeeMinor = Math.round(feeRate * expectedMonthlyLiftMinor);

  return {
    clearsIcpFloor,
    minMonthlyFailedPayments,
    estimatedDaysToProvenLift,
    expectedMonthlyLiftMinor,
    estimatedProvenMonthlyFeeMinor,
    assumptions: { controlFraction, feeRate, certificationDays, treatmentRate, perInvoiceLiftMinor, mixtureBoundaryZ: MIXTURE_BOUNDARY_Z },
    note: 'Planning ESTIMATE (analytic mSPRT approximation), not a guarantee — the live holdout determines the actual proven lift and timing.',
  };
}
