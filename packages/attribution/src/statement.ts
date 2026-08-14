/**
 * Monthly Uplift Statement (ARCHITECTURE.md §3.3, ATTRIBUTION.md §8.3).
 *
 * A reconcilable, signable summary derived from the hash-chained ledger + the
 * uplift computation. This is the product's trust moat: a CFO can line it up
 * against the processor's own payout reports.
 *
 * There are two builders:
 *   - `buildBillableStatement` — the BILLING path. Runs `computeBillableUplift`
 *     (mSPRT + CUPED + cluster-robust) over window-closed observations and bills
 *     the newly-proven lower-bound increment. Use this for anything a merchant
 *     is charged.
 *   - `buildUpliftStatement` — DIAGNOSTIC ONLY. A per-stratum aggregate view on
 *     the fixed-horizon `computeUplift`, for quick rate-lift summaries. Never bill
 *     from it.
 *
 * TODO(lift): render to CSV/PDF and sign the statement (Ed25519 over the
 * statement hash, which covers the ledger hash range) for export — ATTRIBUTION §8.5.
 */

export interface BillableStatement {
  merchantId: string;
  /** Billing period, e.g. "2026-08". */
  period: string;
  currency: CurrencyCode;
  /** The full billing-safe computation (per-stratum lines, lower bound, fee, gates). */
  result: BillableUpliftResult;
  /** Ledger head hash the statement was computed against (for signing). */
  ledgerHead: string;
  /** Whether the underlying ledger passed integrity verification. */
  ledgerVerified: boolean;
  generatedAt: string;
}

/**
 * Build the billing-safe monthly Uplift Statement from window-closed observations.
 * The fee is 12% of the lower-bound dollars newly proven this period (never
 * re-billing prior periods, §7.4); $0 if the holdout hasn't proven positive lift.
 */
export function buildBillableStatement(params: {
  merchantId: string;
  period: string;
  observations: readonly UpliftObservation[];
  /** Cumulative lower-bound dollars already billed this epoch (minor units). */
  priorBilledDollars?: number;
  ledger: readonly LedgerEntry[];
  ledgerHead: string;
  config?: SequentialUpliftConfig;
}): BillableStatement {
  const config = params.config ?? DEFAULT_SEQUENTIAL_CONFIG;
  const result = computeBillableUplift(params.observations, config, params.priorBilledDollars ?? 0);
  const verification = verifyChain(params.ledger);
  return {
    merchantId: params.merchantId,
    period: params.period,
    currency: config.currency,
    result,
    ledgerHead: params.ledgerHead,
    ledgerVerified: verification.valid,
    generatedAt: new Date().toISOString(),
  };
}

import type { CurrencyCode, Money } from '@lift/canonical';
import { computeUplift, type ArmStats, type UpliftConfig, DEFAULT_UPLIFT_CONFIG } from './uplift.js';
import {
  computeBillableUplift,
  DEFAULT_SEQUENTIAL_CONFIG,
  type BillableUpliftResult,
  type SequentialUpliftConfig,
  type UpliftObservation,
} from './sequential.js';
import { verifyChain, type LedgerEntry } from './ledger.js';

/** Per-stratum arm stats feeding the statement. */
export interface StratumArms {
  stratumKey: string;
  control: ArmStats;
  treatment: ArmStats;
}

export interface UpliftStatementLine {
  stratumKey: string;
  controlRate: number;
  treatmentRate: number;
  rateDiff: number;
  rateDiffLower: number;
  incrementalDollarsLower: Money;
  fee: Money;
  billable: boolean;
}

export interface UpliftStatement {
  merchantId: string;
  /** Billing period, e.g. "2026-08". */
  period: string;
  currency: CurrencyCode;
  lines: UpliftStatementLine[];
  /** Sum of billable lower-bound incremental dollars across strata. */
  totalIncrementalLower: Money;
  /** Sum of fees across billable strata — the invoice total. */
  totalFee: Money;
  /** Ledger head hash the statement was computed against (for signing). */
  ledgerHead: string;
  /** Whether the underlying ledger passed integrity verification. */
  ledgerVerified: boolean;
  generatedAt: string;
}

/**
 * DIAGNOSTIC aggregate statement (fixed-horizon `computeUplift`). Per-stratum
 * rate-lift summary for dashboards/quick checks — NOT a billing artifact. For
 * anything a merchant is charged, use `buildBillableStatement`.
 */
export function buildUpliftStatement(params: {
  merchantId: string;
  period: string;
  strata: StratumArms[];
  ledger: readonly LedgerEntry[];
  ledgerHead: string;
  config?: UpliftConfig;
}): UpliftStatement {
  const config = params.config ?? DEFAULT_UPLIFT_CONFIG;
  const lines: UpliftStatementLine[] = [];
  let totalLower = 0;
  let totalFee = 0;

  for (const s of params.strata) {
    const u = computeUplift(s.control, s.treatment, config);
    lines.push({
      stratumKey: s.stratumKey,
      controlRate: u.controlRate,
      treatmentRate: u.treatmentRate,
      rateDiff: u.rateDiff,
      rateDiffLower: u.rateDiffLower,
      incrementalDollarsLower: u.incrementalDollarsLower,
      fee: u.fee,
      billable: u.billable,
    });
    if (u.billable) {
      totalLower += u.incrementalDollarsLower.amount;
      totalFee += u.fee.amount;
    }
  }

  const verification = verifyChain(params.ledger);

  return {
    merchantId: params.merchantId,
    period: params.period,
    currency: config.currency,
    lines,
    totalIncrementalLower: { amount: totalLower, currency: config.currency },
    totalFee: { amount: totalFee, currency: config.currency },
    ledgerHead: params.ledgerHead,
    ledgerVerified: verification.valid,
    generatedAt: new Date().toISOString(),
  };
}
