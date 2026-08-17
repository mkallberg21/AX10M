/**
 * The cost- and compliance-aware objective — the recovery brain's PRIMARY score.
 *
 * Recovery rate alone is the wrong objective: a "just retry harder" baseline wins on rate but
 * burns processing fees and, worse, courts card-network excessive-retry fines. AX10M optimizes
 * NET VALUE instead — expected recovered value minus the expected cost of getting it, where cost
 * includes the per-attempt processing fee AND an expected compliance/fine cost that rises as
 * attempts approach the network retry cap. So the engine prefers the recovery that is cheap and
 * compliant, and self-suppresses low-value or near-cap attempts before the hard guardrail must.
 *
 * Pure: numbers in, numbers out. The guardrail is still the hard constraint that DISPOSES; this
 * objective shapes which candidate the engine PROPOSES.
 */

export interface CostModel {
  /** Processor fee per charge attempt (minor units). */
  attemptFeeMinor: number;
  /** Cost of one card-update comms send (minor units). */
  commsCostMinor: number;
  /** Fine exposure if an over-cap / non-compliant attempt is penalized by the network (minor units). */
  fineExposureMinor: number;
  /** LTV multiplier on recovered invoice value (retained-subscription value beyond the invoice). */
  retentionMultiplier: number;
}

export const DEFAULT_COST_MODEL: CostModel = {
  attemptFeeMinor: 15, // ~$0.15 processing
  commsCostMinor: 5, // ~$0.05 email/SMS send
  fineExposureMinor: 2_500, // ~$25 excessive-retry penalty allowance if fined
  retentionMultiplier: 1.6,
};

export interface ComplianceContext {
  /** Attempts already made on this credential in the current network retry window. */
  attemptsInNetworkWindow?: number;
  /** The network's max attempts per window for this card (e.g. Visa 15 / 30d). */
  networkCap?: number;
  /** Fraction of the cap where fine risk begins ramping (default 0.6 = 60% of the cap). */
  fineRampStart?: number;
}

/**
 * Expected compliance/fine cost of a retry attempt (minor units). Zero well below the cap, then
 * ramps linearly from `fineRampStart` of the cap to full exposure at/above the cap. This makes the
 * objective treat near-cap attempts as increasingly expensive — the engine backs off before the
 * guardrail's hard block, which is exactly the compliance edge a blind "retry harder" lacks.
 */
export function expectedFineCostMinor(cmp: ComplianceContext | undefined, cost: CostModel): number {
  if (!cmp || cmp.networkCap === undefined || cmp.networkCap <= 0) return 0;
  const used = Math.max(0, cmp.attemptsInNetworkWindow ?? 0);
  const ratio = used / cmp.networkCap;
  const start = cmp.fineRampStart ?? 0.6;
  const pFine = ratio >= 1 ? 1 : ratio <= start ? 0 : (ratio - start) / (1 - start);
  return Math.round(pFine * cost.fineExposureMinor);
}

/** Cost breakdown for one action, for transparency on the decision + ledger. */
export interface ActionCost {
  feeMinor: number;
  fineCostMinor: number;
  totalMinor: number;
}

export interface ActionValue {
  netValueMinor: number;
  grossMinor: number;
  cost: ActionCost;
}

/** Net value of a same-card RETRY: expected recovered value − attempt fee − expected fine cost. */
export function retryNetValue(params: {
  recoverability: number;
  amountMinor: number;
  cost?: CostModel;
  compliance?: ComplianceContext;
}): ActionValue {
  const cost = params.cost ?? DEFAULT_COST_MODEL;
  const gross = Math.round(Math.max(0, params.recoverability) * params.amountMinor * cost.retentionMultiplier);
  const fine = expectedFineCostMinor(params.compliance, cost);
  const total = cost.attemptFeeMinor + fine;
  return { netValueMinor: gross - total, grossMinor: gross, cost: { feeMinor: cost.attemptFeeMinor, fineCostMinor: fine, totalMinor: total } };
}

/**
 * Net value of a card-update COMMS action: expected recovered value via a FRESH credential minus
 * the comms send cost. No network-fine risk (it isn't a card-network retry).
 */
export function commsNetValue(params: { recoverability: number; amountMinor: number; cost?: CostModel }): ActionValue {
  const cost = params.cost ?? DEFAULT_COST_MODEL;
  const gross = Math.round(Math.max(0, params.recoverability) * params.amountMinor * cost.retentionMultiplier);
  return { netValueMinor: gross - cost.commsCostMinor, grossMinor: gross, cost: { feeMinor: cost.commsCostMinor, fineCostMinor: 0, totalMinor: cost.commsCostMinor } };
}
