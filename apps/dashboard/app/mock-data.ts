/**
 * Mocked shadow-mode attribution summary.
 *
 * Phase 0 shadow mode shows the merchant *projected* monthly uplift and the fee
 * Lift would have charged (12%) BEFORE they activate — the "here's the proof,
 * then decide" move (ARCHITECTURE.md §6). This module fabricates per-stratum arm
 * stats and runs them through the REAL @lift/attribution engine so the dashboard
 * numbers are computed exactly as production would compute them.
 *
 * TODO(lift): replace with a live query against the API's attribution summary.
 */

import {
  buildUpliftStatement,
  HashChainedLedger,
  type StratumArms,
  type UpliftStatement,
} from '@lift/attribution';

/** Fabricated per-stratum arm stats (control = baseline-only, treatment = Lift). */
const STRATA: StratumArms[] = [
  {
    stratumKey: 'enterprise|soft|na',
    control: { n: 240, recovered: 108, failedVolume: 12_000_000, recoveredVolume: 5_400_000 },
    treatment: { n: 2160, recovered: 1123, failedVolume: 108_000_000, recoveredVolume: 56_150_000 },
  },
  {
    stratumKey: 'mid|soft|na',
    control: { n: 520, recovered: 208, failedVolume: 5_200_000, recoveredVolume: 2_080_000 },
    treatment: { n: 4680, recovered: 2200, failedVolume: 46_800_000, recoveredVolume: 22_000_000 },
  },
  {
    stratumKey: 'small|gray|emea',
    control: { n: 610, recovered: 195, failedVolume: 3_050_000, recoveredVolume: 975_000 },
    treatment: { n: 5490, recovered: 1920, failedVolume: 27_450_000, recoveredVolume: 9_600_000 },
  },
  {
    stratumKey: 'micro|hard|apac',
    // Hard declines: treatment barely beats control — engine correctly suppresses
    // retries and leans on card-update comms. Not billable (thin, low lift).
    control: { n: 180, recovered: 12, failedVolume: 540_000, recoveredVolume: 36_000 },
    treatment: { n: 1620, recovered: 118, failedVolume: 4_860_000, recoveredVolume: 354_000 },
  },
];

let cachedStatement: UpliftStatement | undefined;

/** Build (and cache) the mocked projected-uplift statement for August 2026. */
export function getProjectedStatement(): UpliftStatement {
  if (cachedStatement) return cachedStatement;

  // A small mock ledger so the statement carries a real (verifiable) head hash.
  const ledger = new HashChainedLedger();
  for (const s of STRATA) {
    ledger.append({
      merchantId: 'mrc_demo',
      type: 'uplift.statement',
      occurredAt: '2026-08-31T23:59:59.000Z',
      detail: { stratumKey: s.stratumKey, treatmentN: s.treatment.n, controlN: s.control.n },
    });
  }

  cachedStatement = buildUpliftStatement({
    merchantId: 'mrc_demo',
    period: '2026-08',
    strata: STRATA,
    ledger: ledger.all(),
    ledgerHead: ledger.head(),
  });
  return cachedStatement;
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
