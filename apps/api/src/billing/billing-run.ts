/**
 * The billing run: for a period, compute each merchant's signed Uplift Statement, RECORD it to the
 * ledger (the auditable invoice — moves no money), and, only when live billing is enabled and a
 * real charger is wired, collect the fee. Pure core (`runBilling`) so it's testable without a DB;
 * `billing-job.ts` wires the persisted ledger.
 */

import type { LedgerEntry, LedgerEventType, SequentialUpliftConfig, Signer } from '@ax10m/attribution';
import { computeHoldoutEconomics, holdoutFractionFor, type HoldoutScheduleConfig } from '@ax10m/billing';
import { computeMerchantStatement, type SignedBillableStatement } from './billing.js';
import { merchantsInLedger, previousMonth, type BillingLedgerEntry } from './observations.js';
import { NoopBillingCharger, type BillingCharger, type BillingChargeReceipt } from './charger.js';

export interface LedgerAppend {
  merchantId: string;
  type: LedgerEventType;
  occurredAt: string;
  detail: Record<string, unknown>;
}

export interface BillingMerchantResult {
  merchantId: string;
  period: string;
  /** Gross fee = 12% of proven lift (minor units). */
  feeMinor: number;
  currency: string;
  billable: boolean;
  gateReasons: string[];
  lowerDollarsCumMinor: number;
  billableIncrementMinor: number;
  treatedInvoices: number;
  statementHash: string;
  // Holdout economics — the holdout's cost to the merchant, credited against the fee.
  holdoutFraction: number;
  estimatedHoldoutCostMinor: number;
  holdoutCreditMinor: number;
  /** What the merchant is actually billed after the holdout credit (minor units). */
  netBilledMinor: number;
  charge?: BillingChargeReceipt;
}

export interface BillingRunSummary {
  period: string;
  generatedAt: string;
  live: boolean;
  merchants: BillingMerchantResult[];
  /** Sum of gross fees (12% of proven lift) across merchants. */
  totalFeeMinor: number;
  /** Sum of net-billed amounts (after holdout credit) across merchants. */
  totalNetBilledMinor: number;
  totalChargedMinor: number;
}

export interface BillingRunOptions {
  entries: readonly BillingLedgerEntry[];
  ledger: readonly LedgerEntry[]; // for the statement's chain verification
  ledgerHead: string;
  /** Persist an event (the uplift.statement invoice). Omit for a dry PREVIEW (no record). */
  append?: (entry: LedgerAppend) => Promise<void>;
  signer: Signer;
  nowIso: string;
  /** Collect the fee only when true AND a charger is wired. Default false (record only). */
  live?: boolean;
  charger?: BillingCharger;
  config?: SequentialUpliftConfig;
  /** Per-merchant onboarding date (drives the holdout taper). Falls back to the merchant's earliest ledger event. */
  onboardedAt?: Record<string, string>;
  /** Holdout taper schedule (certification window + fractions). Defaults to 90d @ 10% → 2%. */
  holdoutSchedule?: HoldoutScheduleConfig;
}

/** The merchant's onboarding date: explicit, else its earliest ledger event (a proxy). */
function onboardedAtFor(merchantId: string, entries: readonly BillingLedgerEntry[], explicit?: Record<string, string>): string | undefined {
  const given = explicit?.[merchantId];
  if (given) return given;
  let earliest: number | undefined;
  let earliestIso: string | undefined;
  for (const e of entries) {
    if (e.merchantId !== merchantId) continue;
    const t = Date.parse(e.occurredAt);
    if (!Number.isNaN(t) && (earliest === undefined || t < earliest)) {
      earliest = t;
      earliestIso = e.occurredAt;
    }
  }
  return earliestIso;
}

/**
 * Compute (and optionally record + charge) the previous month's Uplift Statements for every
 * merchant in the ledger. Recording is safe (an invoice record); charging is gated by `live`.
 */
export async function runBilling(opts: BillingRunOptions): Promise<{ summary: BillingRunSummary; statements: SignedBillableStatement[] }> {
  const period = previousMonth(opts.nowIso);
  const charger = opts.charger ?? new NoopBillingCharger();
  const merchants = merchantsInLedger(opts.entries);

  const results: BillingMerchantResult[] = [];
  const statements: SignedBillableStatement[] = [];
  let totalFee = 0;
  let totalNetBilled = 0;
  let totalCharged = 0;

  for (const merchantId of merchants) {
    const signed = computeMerchantStatement({ entries: opts.entries, merchantId, period, ledger: opts.ledger, ledgerHead: opts.ledgerHead, signer: opts.signer, config: opts.config });
    statements.push(signed);
    const r = signed.result;

    // Holdout economics: credit the merchant for the recovery forgone on the held-out control
    // group, so the effective rate stays ~12% even during the full-holdout certification window.
    const onboardedAt = onboardedAtFor(merchantId, opts.entries, opts.onboardedAt);
    const holdoutFraction = holdoutFractionFor(onboardedAt ?? opts.nowIso, opts.nowIso, opts.holdoutSchedule);
    const econ = computeHoldoutEconomics({ grossFeeMinor: r.fee.amount, perInvoiceLiftMinor: r.deltaPer, treatedInvoices: r.treatedInvoices, holdoutFraction });

    // Record the statement to the ledger — the auditable invoice. No money moves here.
    if (opts.append) {
      await opts.append({
        merchantId,
        type: 'uplift.statement',
        occurredAt: opts.nowIso,
        detail: {
          period: period.label,
          currency: signed.currency,
          feeMinor: r.fee.amount, // gross (12% of proven lift)
          lowerDollarsCum: r.lowerDollarsCum.amount, // the billing watermark (read back next period)
          billableIncrement: r.billableIncrement.amount,
          billable: r.billable,
          gateReasons: r.gateReasons,
          treatedInvoices: r.treatedInvoices,
          holdoutFraction: econ.holdoutFraction,
          estimatedHoldoutCost: econ.estimatedHoldoutCostMinor,
          holdoutCredit: econ.holdoutCreditMinor,
          netBilled: econ.netBilledMinor,
          statementHash: signed.statementHash,
          signature: signed.signature,
          signingKeyId: signed.signingKeyId,
        },
      });
    }

    // Collect ONLY when live billing is on, a charger is wired, the lift is billable, and there's
    // a positive NET amount after the holdout credit. (During certification net ≈ $0 — the merchant
    // effectively pays via the holdout and gets the signed proof.)
    let charge: BillingChargeReceipt | undefined;
    if (opts.live && r.billable && econ.netBilledMinor > 0) {
      charge = await charger.charge({ merchantId, period: period.label, amountMinor: econ.netBilledMinor, currency: signed.currency, statementHash: signed.statementHash });
      if (charge.status === 'charged') totalCharged += econ.netBilledMinor;
    }

    totalFee += r.fee.amount;
    totalNetBilled += econ.netBilledMinor;
    results.push({
      merchantId,
      period: period.label,
      feeMinor: r.fee.amount,
      currency: signed.currency,
      billable: r.billable,
      gateReasons: r.gateReasons,
      lowerDollarsCumMinor: r.lowerDollarsCum.amount,
      billableIncrementMinor: r.billableIncrement.amount,
      treatedInvoices: r.treatedInvoices,
      statementHash: signed.statementHash,
      holdoutFraction: econ.holdoutFraction,
      estimatedHoldoutCostMinor: econ.estimatedHoldoutCostMinor,
      holdoutCreditMinor: econ.holdoutCreditMinor,
      netBilledMinor: econ.netBilledMinor,
      charge,
    });
  }

  return {
    summary: { period: period.label, generatedAt: opts.nowIso, live: opts.live ?? false, merchants: results, totalFeeMinor: totalFee, totalNetBilledMinor: totalNetBilled, totalChargedMinor: totalCharged },
    statements,
  };
}
