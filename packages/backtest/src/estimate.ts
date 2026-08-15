/**
 * Wire the two arms into the REAL billing estimator. We do not write any statistics
 * here — assignment is `@ax10m/attribution` `assign` (customer-clustered, stratified),
 * and the lift + mSPRT lower bound + fee come from `computeBillableUplift` (CUPED +
 * cluster-robust variance + the always-valid confidence sequence). This validates the
 * estimator and the engine at once.
 */

import { familyOf, type MrrTier } from '@ax10m/canonical';
import {
  assign,
  computeBillableUplift,
  DEFAULT_HOLDOUT_CONFIG,
  DEFAULT_SEQUENTIAL_CONFIG,
  stratumKey,
  type BillableUpliftResult,
  type HoldoutConfig,
  type SequentialUpliftConfig,
  type Stratum,
  type UpliftObservation,
} from '@ax10m/attribution';
import type { SimInvoice } from './world/world.js';
import type { InvoiceOutcome } from './sim/simulate.js';
import { runPolicy } from './sim/simulate.js';
import type { Policy } from './policy/policy.js';
import type { WorldParams } from './world/world.js';
import { DEFAULT_WORLD_PARAMS } from './world/world.js';

const MERCHANT = 'mrc_backtest';

/** Coarse MRR-tier bucket from amount in minor units (mirrors the API service). */
function mrrTierFromAmount(minor: number): MrrTier {
  if (minor < 2_000) return 'micro';
  if (minor < 10_000) return 'small';
  if (minor < 50_000) return 'mid';
  if (minor < 200_000) return 'large';
  return 'enterprise';
}

export function deriveStratum(inv: SimInvoice): Stratum {
  return { mrrTier: mrrTierFromAmount(inv.amountMinor), declineFamily: familyOf(inv.declineCode), issuerRegion: inv.issuerRegion };
}

export interface ArmSplit {
  control: SimInvoice[];
  treatment: SimInvoice[];
}

/** Split the stream into control/treatment by the real customer-clustered holdout. */
export function splitArms(invoices: readonly SimInvoice[], holdout: HoldoutConfig = DEFAULT_HOLDOUT_CONFIG): ArmSplit {
  const control: SimInvoice[] = [];
  const treatment: SimInvoice[] = [];
  for (const inv of invoices) {
    const a = assign({ merchantId: MERCHANT, customerId: inv.customerId, invoiceId: inv.id, stratum: deriveStratum(inv) }, holdout);
    (a.bucket === 'control' ? control : treatment).push(inv);
  }
  return { control, treatment };
}

/** Build estimator observations from both arms' outcomes. */
export function toObservations(control: readonly InvoiceOutcome[], treatment: readonly InvoiceOutcome[]): UpliftObservation[] {
  const rows: UpliftObservation[] = [];
  const push = (o: InvoiceOutcome, arm: 'control' | 'treatment') => {
    rows.push({
      arm,
      cluster: o.invoice.customerId,
      stratum: stratumKey(deriveStratum(o.invoice)),
      outcome: o.recoveredMinor, // Y_i: recovered dollars (minor units)
      covariate: o.invoice.amountMinor, // X_i: a genuine pre-failure covariate for CUPED
      recovered: o.recovered,
    });
  };
  for (const o of control) push(o, 'control');
  for (const o of treatment) push(o, 'treatment');
  return rows;
}

export interface ArmResult {
  controlOutcomes: InvoiceOutcome[];
  treatmentOutcomes: InvoiceOutcome[];
  estimate: BillableUpliftResult;
}

/**
 * Full comparison: split → run each arm's policy through the world → estimate.
 * `controlPolicy` defaults to the baseline, `treatmentPolicy` to the engine, but the
 * A/A test passes the SAME policy for both.
 */
export function runComparison(params: {
  invoices: readonly SimInvoice[];
  controlPolicy: Policy;
  treatmentPolicy: Policy;
  controlSeed: number;
  treatmentSeed: number;
  world?: WorldParams;
  holdout?: HoldoutConfig;
  estimator?: SequentialUpliftConfig;
}): ArmResult {
  const world = params.world ?? DEFAULT_WORLD_PARAMS;
  const { control, treatment } = splitArms(params.invoices, params.holdout);
  const controlOutcomes = runPolicy(control, params.controlPolicy, params.controlSeed, world);
  const treatmentOutcomes = runPolicy(treatment, params.treatmentPolicy, params.treatmentSeed, world);
  const estimate = computeBillableUplift(
    toObservations(controlOutcomes, treatmentOutcomes),
    params.estimator ?? DEFAULT_SEQUENTIAL_CONFIG,
    0,
  );
  return { controlOutcomes, treatmentOutcomes, estimate };
}
