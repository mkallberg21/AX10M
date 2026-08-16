/**
 * The billing run: for a period, compute each merchant's signed Uplift Statement, RECORD it to the
 * ledger (the auditable invoice — moves no money), and, only when live billing is enabled and a
 * real charger is wired, collect the fee. Pure core (`runBilling`) so it's testable without a DB;
 * `billing-job.ts` wires the persisted ledger.
 */

import type { LedgerEntry, LedgerEventType, SequentialUpliftConfig, Signer } from '@ax10m/attribution';
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
  feeMinor: number;
  currency: string;
  billable: boolean;
  gateReasons: string[];
  lowerDollarsCumMinor: number;
  billableIncrementMinor: number;
  treatedInvoices: number;
  statementHash: string;
  charge?: BillingChargeReceipt;
}

export interface BillingRunSummary {
  period: string;
  generatedAt: string;
  live: boolean;
  merchants: BillingMerchantResult[];
  totalFeeMinor: number;
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
  let totalCharged = 0;

  for (const merchantId of merchants) {
    const signed = computeMerchantStatement({ entries: opts.entries, merchantId, period, ledger: opts.ledger, ledgerHead: opts.ledgerHead, signer: opts.signer, config: opts.config });
    statements.push(signed);
    const r = signed.result;

    // Record the statement to the ledger — the auditable invoice. No money moves here.
    if (opts.append) {
      await opts.append({
        merchantId,
        type: 'uplift.statement',
        occurredAt: opts.nowIso,
        detail: {
          period: period.label,
          currency: signed.currency,
          feeMinor: r.fee.amount,
          lowerDollarsCum: r.lowerDollarsCum.amount, // the billing watermark (read back next period)
          billableIncrement: r.billableIncrement.amount,
          billable: r.billable,
          gateReasons: r.gateReasons,
          treatedInvoices: r.treatedInvoices,
          statementHash: signed.statementHash,
          signature: signed.signature,
          signingKeyId: signed.signingKeyId,
        },
      });
    }

    // Collect the fee ONLY when live billing is on, a charger is wired, and there's a positive
    // billable fee. Otherwise the invoice stands recorded but uncollected.
    let charge: BillingChargeReceipt | undefined;
    if (opts.live && r.billable && r.fee.amount > 0) {
      charge = await charger.charge({ merchantId, period: period.label, amountMinor: r.fee.amount, currency: signed.currency, statementHash: signed.statementHash });
      if (charge.status === 'charged') totalCharged += r.fee.amount;
    }

    totalFee += r.fee.amount;
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
      charge,
    });
  }

  return {
    summary: { period: period.label, generatedAt: opts.nowIso, live: opts.live ?? false, merchants: results, totalFeeMinor: totalFee, totalChargedMinor: totalCharged },
    statements,
  };
}
