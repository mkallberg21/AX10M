/**
 * The Phase-1 validity checks (§1.3). These guard the exercise against the two ways it
 * could be worthless: a broken estimator (A/A must return null) and a result that only
 * holds at one parameter setting (sensitivity sweep). Plus the power curve (minimum
 * viable merchant size) and determinism.
 */

import { computeBillableUplift, DEFAULT_SEQUENTIAL_CONFIG, stratumKey, type UpliftObservation } from '@ax10m/attribution';
import { bernoulli, deriveSeed, mulberry32 } from './rng.js';
import { DEFAULT_WORLD_PARAMS, generateStream, type WorldParams } from './world/world.js';
import { deriveStratum, runComparison, splitArms } from './estimate.js';
import { EnginePolicy } from './policy/engine-policy.js';
import { StripeSmartRetriesBaseline } from './baselines/smart-retries.js';

// ── A/A: the same policy on both arms must show NO significant lift ────────────
export interface AaResult {
  rateDiff: number;
  lowerPer: number;
  billable: boolean;
  passed: boolean;
}

export function aaTest(nCustomers: number, seed: number): AaResult {
  const invoices = generateStream(nCustomers, seed);
  const engine = new EnginePolicy();
  const r = runComparison({
    invoices,
    controlPolicy: engine,
    treatmentPolicy: engine, // engine vs itself
    controlSeed: deriveSeed(seed, 'aa-control'),
    treatmentSeed: deriveSeed(seed, 'aa-treatment'), // different seeds
  });
  // The estimator PASSES the A/A if it does not declare a positive billable lower bound.
  const passed = r.estimate.lowerPer === 0 && !r.estimate.billable;
  return { rateDiff: r.estimate.rateDiff, lowerPer: r.estimate.lowerPer, billable: r.estimate.billable, passed };
}

// ── Power curve: min invoices to detect a given true lift ─────────────────────
export interface PowerPoint {
  liftPp: number;
  /** Total invoices (both arms) needed for a positive lower bound; null if not reached by the cap. */
  minInvoices: number | null;
  controlClustersAtDetect: number | null;
}

/** Construct observations with a KNOWN injected lift (uses the world's amount variance + clustering). */
function syntheticLiftObservations(nCustomers: number, seed: number, controlRate: number, liftPp: number): UpliftObservation[] {
  const invoices = generateStream(nCustomers, deriveSeed(seed, 'power'));
  const { control, treatment } = splitArms(invoices);
  const rows: UpliftObservation[] = [];
  const emit = (arm: 'control' | 'treatment', list: typeof control, rate: number) => {
    for (const inv of list) {
      const rng = mulberry32(deriveSeed(seed, `${arm}:${inv.id}`));
      const recovered = bernoulli(rng, rate);
      rows.push({
        arm,
        cluster: inv.customerId,
        stratum: stratumKey(deriveStratum(inv)),
        outcome: recovered ? inv.amountMinor : 0,
        covariate: inv.amountMinor,
        recovered,
      });
    }
  };
  emit('control', control, controlRate);
  emit('treatment', treatment, controlRate + liftPp / 100);
  return rows;
}

export function powerCurve(seed: number, liftsPp: readonly number[], controlRate = 0.3): PowerPoint[] {
  const sizes = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000];
  return liftsPp.map((liftPp) => {
    for (const nCustomers of sizes) {
      const obs = syntheticLiftObservations(nCustomers, deriveSeed(seed, `p${liftPp}`), controlRate, liftPp);
      const est = computeBillableUplift(obs, DEFAULT_SEQUENTIAL_CONFIG, 0);
      if (est.lowerPer > 0 && est.billable) {
        return { liftPp, minInvoices: obs.length, controlClustersAtDetect: est.controlClusters };
      }
    }
    return { liftPp, minInvoices: null, controlClustersAtDetect: null };
  });
}

// ── Sensitivity sweep: does the sign + rough magnitude survive ±30%? ──────────
export interface SensitivityPoint {
  param: keyof WorldParams;
  factor: number;
  rateDiff: number;
  lowerPer: number;
  billable: boolean;
}

export function sensitivitySweep(nCustomers: number, seed: number): SensitivityPoint[] {
  const params: Array<keyof WorldParams> = ['recoverableScale', 'onsetScale', 'windowScale', 'residualScale', 'nsfShareScale'];
  const factors = [0.7, 1.3];
  const points: SensitivityPoint[] = [];
  for (const param of params) {
    for (const factor of factors) {
      const world: WorldParams = { ...DEFAULT_WORLD_PARAMS, [param]: factor };
      const invoices = generateStream(nCustomers, seed, world);
      const r = runComparison({
        invoices,
        controlPolicy: new StripeSmartRetriesBaseline(),
        treatmentPolicy: new EnginePolicy(),
        controlSeed: deriveSeed(seed, 'ctrl'),
        treatmentSeed: deriveSeed(seed, 'treat'),
        world,
      });
      points.push({ param, factor, rateDiff: r.estimate.rateDiff, lowerPer: r.estimate.lowerPer, billable: r.estimate.billable });
    }
  }
  return points;
}
