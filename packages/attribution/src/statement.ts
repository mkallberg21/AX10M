/**
 * Monthly Uplift Statement (ARCHITECTURE.md §3.3).
 *
 * A reconcilable, signable summary derived from the hash-chained ledger + the
 * per-stratum uplift computation. This is the product's trust moat: a CFO can
 * line it up against the processor's own payout reports.
 *
 * TODO(lift): render to CSV/PDF and sign the statement (hash of the statement +
 * the ledger head, signed with a KMS/HSM key) for export.
 */

import type { CurrencyCode, Money } from '@lift/canonical';
import { computeUplift, type ArmStats, type UpliftConfig, DEFAULT_UPLIFT_CONFIG } from './uplift.js';
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
 * Build a monthly Uplift Statement. Uplift is computed per-stratum and summed,
 * so heterogeneous cells (e.g. enterprise vs micro MRR) never dilute each other.
 * Only strata that clear the min-sample + positive-lower-bound bar are billed.
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
