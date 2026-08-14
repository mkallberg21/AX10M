/**
 * Mocked shadow-mode attribution summary — BILLING-SAFE path.
 *
 * Phase 0 shadow mode shows the merchant *projected* monthly uplift and the fee
 * Lift would have charged (12%) BEFORE they activate — the "here's the proof,
 * then decide" move (ARCHITECTURE.md §6). This module fabricates realistic
 * per-invoice observations and runs them through the REAL @lift/attribution
 * billing engine (`buildBillableStatement`: CUPED + cluster-robust + mSPRT
 * confidence sequence), so the dashboard numbers are computed exactly as a
 * production bill would be — lower bound, not point estimate.
 *
 * TODO(lift): replace the fabricated observations with a live query against the
 * API's window-closed outcome log.
 */

import {
  buildBillableStatement,
  HashChainedLedger,
  DEFAULT_SEQUENTIAL_CONFIG,
  type BillableStatement,
  type UpliftObservation,
} from '@lift/attribution';

/** One cohort's intended shape; we expand it into per-invoice observations. */
interface CohortSpec {
  stratum: string;
  controlN: number;
  treatmentN: number;
  controlRate: number;
  treatmentRate: number;
  /** Mean invoice face value in minor units. */
  meanAmount: number;
  spread: number;
}

const COHORTS: CohortSpec[] = [
  { stratum: 'enterprise|soft|na', controlN: 240, treatmentN: 2160, controlRate: 0.45, treatmentRate: 0.58, meanAmount: 50_000, spread: 12_000 },
  { stratum: 'mid|soft|na', controlN: 520, treatmentN: 4680, controlRate: 0.4, treatmentRate: 0.52, meanAmount: 20_000, spread: 8_000 },
  { stratum: 'small|gray|emea', controlN: 610, treatmentN: 5490, controlRate: 0.32, treatmentRate: 0.45, meanAmount: 5_000, spread: 3_000 },
  // Hard declines: treatment barely beats control — the engine suppresses retries
  // and leans on card-update comms. Low lift; contributes little to the bill.
  { stratum: 'micro|hard|apac', controlN: 180, treatmentN: 1620, controlRate: 0.07, treatmentRate: 0.09, meanAmount: 3_000, spread: 1_500 },
];

/** Deterministic PRNG (LCG) so the demo is stable across renders. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function expandArm(
  spec: CohortSpec,
  arm: 'control' | 'treatment',
  seed: number,
): UpliftObservation[] {
  const n = arm === 'control' ? spec.controlN : spec.treatmentN;
  const rate = arm === 'control' ? spec.controlRate : spec.treatmentRate;
  const rng = lcg(seed);
  const obs: UpliftObservation[] = [];
  for (let i = 0; i < n; i++) {
    const recovered = rng() < rate;
    const amount = Math.round(spec.meanAmount + (rng() - 0.5) * spec.spread);
    obs.push({
      arm,
      cluster: `${arm[0]}_${spec.stratum}_${i}`,
      stratum: spec.stratum,
      outcome: recovered ? amount : 0,
      covariate: amount, // pre-failure covariate: invoice amount drives CUPED reduction
      recovered,
    });
  }
  return obs;
}

let cached: BillableStatement | undefined;

/** Build (and cache) the mocked billing-safe projected statement for August 2026. */
export function getProjectedStatement(): BillableStatement {
  if (cached) return cached;

  const observations: UpliftObservation[] = [];
  COHORTS.forEach((c, i) => {
    observations.push(...expandArm(c, 'control', 1000 + i * 2));
    observations.push(...expandArm(c, 'treatment', 1001 + i * 2));
  });

  // A small mock ledger so the statement carries a real (verifiable) head hash.
  const ledger = new HashChainedLedger();
  for (const c of COHORTS) {
    ledger.append({
      merchantId: 'mrc_demo',
      type: 'uplift.statement',
      occurredAt: '2026-08-31T23:59:59.000Z',
      detail: { stratum: c.stratum, controlN: c.controlN, treatmentN: c.treatmentN },
    });
  }

  cached = buildBillableStatement({
    merchantId: 'mrc_demo',
    period: '2026-08',
    observations,
    priorBilledDollars: 0,
    ledger: ledger.all(),
    ledgerHead: ledger.head(),
    // Overall control share ≈ 1550 / 15500 = 10%.
    config: { ...DEFAULT_SEQUENTIAL_CONFIG, expectedControlFraction: 0.1 },
  });
  return cached;
}

/** Format integer minor units as a currency string (display only). */
export function formatMoney(minorUnits: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    minorUnits / 100,
  );
}

export function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
