/**
 * CFO reconciliation export (ATTRIBUTION.md §8.3–§8.5).
 *
 * The trust moat made executable. A CFO must be able to tie AX10M's invoice to the
 * processor's OWN records without trusting our dashboard. This module produces:
 *
 *   1. A recovered-transactions export (each row carries the processor txn id +
 *      settled timestamp) that reconciles line-by-line against the processor's
 *      payout/balance report — `reconcileAgainstPayout` does the tie-out in code.
 *   2. A fee worksheet — every input to `fee = 12% × billable_increment`, so the
 *      arithmetic is recomputable by hand.
 *   3. The epoch disclosure incl. the revealed salt, so the merchant can RECOMPUTE
 *      every arm assignment themselves (assignment was hash-committed before
 *      outcomes — see holdout.ts / the ledger).
 *   4. Ledger-integrity verification + a statement hash signed with Ed25519.
 *
 * This is the direct, mechanical answer to "how do I know the lift is real?" —
 * the failure mode that sank modeled-baseline vendors (COMPETITIVE.md §1).
 *
 * Determinism: given the same outcomes + config + epoch, the fee and hash are
 * reproducible (pass `generatedAt` to pin the timestamp). Signing is the only
 * step that needs a key; production sources it from KMS/HSM (TODO(ax10m)).
 */

import { createHash, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import type { CurrencyCode, Money } from '@ax10m/canonical';
import {
  computeBillableUplift,
  DEFAULT_SEQUENTIAL_CONFIG,
  type SequentialUpliftConfig,
  type UpliftObservation,
} from './sequential.js';
import { verifyChain, type LedgerEntry } from './ledger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Inputs — a window-closed outcome row (ATTRIBUTION.md §10.5 outcome_log)
// ─────────────────────────────────────────────────────────────────────────────

/** A window-closed failed-invoice outcome with the settlement detail needed to reconcile. */
export interface SettledOutcome {
  invoiceId: string;
  customerId: string;
  arm: 'control' | 'treatment';
  stratum: string;
  declineCode?: string;
  outcome: 'recovered' | 'failed' | 'pending';
  /** Face value of the invoice, minor units. Also the CUPED covariate. */
  invoiceAmount: number;
  /** Actually-settled recovered amount, minor units (partial-aware). 0 if not recovered. */
  recoveredAmount: number;
  currency: CurrencyCode;
  /** Processor transaction id — the reconciliation key against the payout report. */
  processorTxnId?: string;
  /** ISO settle timestamp (present for recovered rows). */
  settledAt?: string;
  reversalType?: 'none' | 'refund' | 'chargeback' | 'dispute';
  /** Clawed-back amount within the window, minor units. */
  reversalAmount?: number;
  reversalAt?: string;
}

/** The pre-registered epoch config disclosed so the merchant can recompute buckets (§2.6, §8.1). */
export interface EpochDisclosure {
  epochId: string;
  /** The salt, REVEALED post-epoch so every arm assignment can be recomputed. */
  saltRevealed: string;
  controlFraction: number;
  windowDays: number;
  alpha: number;
  tau2: number;
  cupedModelVersion?: string;
  billingMode: 'conservative' | 'full_value';
}

// ─────────────────────────────────────────────────────────────────────────────
// Signing (Ed25519) — ATTRIBUTION.md §8.5
// ─────────────────────────────────────────────────────────────────────────────

/** Signs a message (hex string) and returns a hex signature. Prod impl is KMS/HSM-backed. */
export interface Signer {
  readonly keyId: string;
  sign(messageHex: string): string;
}

export interface Ed25519KeyMaterial {
  signer: Signer;
  publicKeyPem: string;
  privateKeyPem: string;
}

/**
 * Create an in-memory Ed25519 signer (reference/dev). Generates a keypair unless a
 * private key PEM is supplied. The public key is published so anyone can verify a
 * statement without trusting AX10M. Production replaces this with a KMS/HSM signer
 * exposing the same `Signer` interface.
 */
export function createEd25519Signer(
  keyId = 'ax10m-ed25519-dev',
  privateKeyPem?: string,
): Ed25519KeyMaterial {
  let priv: string;
  let pub: string;
  if (privateKeyPem) {
    priv = privateKeyPem;
    pub = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
  } else {
    const kp = generateKeyPairSync('ed25519');
    priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }
  const signer: Signer = {
    keyId,
    sign(messageHex: string): string {
      // Ed25519 uses a null algorithm; sign the raw message bytes.
      return edSign(null, Buffer.from(messageHex), priv).toString('hex');
    },
  };
  return { signer, publicKeyPem: pub, privateKeyPem: priv };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ArmSummary {
  invoices: number;
  recovered: number;
  /** Gross settled recovered dollars (minor units). */
  recoveredAmount: number;
  /** Reversed/clawed-back dollars within window (minor units). */
  reversedAmount: number;
}

/** Every input to the fee, so `fee = feeRate × billableIncrement` is recomputable by hand. */
export interface FeeWorksheet {
  feeRate: number;
  deltaPer: number;
  se: number;
  halfWidth: number;
  lowerPer: number;
  treatedInvoices: number;
  lowerDollarsCum: number;
  priorBilledDollars: number;
  billableIncrement: number;
  fee: number;
  billable: boolean;
  gateReasons: string[];
  cupedVarianceReduction: number;
  effectiveN: number;
}

export interface ReconciliationExport {
  merchantId: string;
  period: string;
  currency: CurrencyCode;
  summary: { control: ArmSummary; treatment: ArmSummary };
  fee: FeeWorksheet;
  epoch: EpochDisclosure;
  /** Recovered (and/or reversed) rows — the CSV a CFO ties to the payout report. */
  recoveredTransactions: SettledOutcome[];
  ledgerHead: string;
  ledgerVerified: boolean;
  /** SHA-256 over the canonical statement (everything except the signature block). */
  statementHash: string;
  signature?: string;
  signingKeyId?: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

/** Net recovered value within window: gross settled minus in-window reversal, floored at 0. */
function netRecovered(o: SettledOutcome): number {
  return Math.max(0, o.recoveredAmount - (o.reversalAmount ?? 0));
}

/** Map a settlement row to the billing-engine observation (net-of-clawback dollars). */
export function settledOutcomeToObservation(o: SettledOutcome): UpliftObservation {
  return {
    arm: o.arm,
    cluster: o.customerId,
    stratum: o.stratum,
    outcome: netRecovered(o),
    covariate: o.invoiceAmount,
    recovered: o.outcome === 'recovered',
  };
}

function armSummary(rows: readonly SettledOutcome[]): ArmSummary {
  let recovered = 0;
  let recoveredAmount = 0;
  let reversedAmount = 0;
  for (const o of rows) {
    if (o.outcome === 'recovered') {
      recovered += 1;
      recoveredAmount += o.recoveredAmount; // only recovered rows count toward recovered $
    }
    reversedAmount += o.reversalAmount ?? 0;
  }
  return { invoices: rows.length, recovered, recoveredAmount, reversedAmount };
}

/**
 * Build the signed CFO reconciliation export. The fee is computed from the same
 * outcomes that populate the reconciliation CSV, so the invoice and the evidence
 * can never disagree.
 */
export function buildReconciliationExport(params: {
  merchantId: string;
  period: string;
  outcomes: readonly SettledOutcome[];
  epoch: EpochDisclosure;
  ledger: readonly LedgerEntry[];
  ledgerHead: string;
  priorBilledDollars?: number;
  config?: SequentialUpliftConfig;
  signer?: Signer;
  /** Pin the timestamp for reproducibility/testing; defaults to now. */
  generatedAt?: string;
}): ReconciliationExport {
  const currency = params.outcomes[0]?.currency ?? params.config?.currency ?? DEFAULT_SEQUENTIAL_CONFIG.currency;
  const config: SequentialUpliftConfig = {
    ...DEFAULT_SEQUENTIAL_CONFIG,
    alpha: params.epoch.alpha,
    tau2: params.epoch.tau2,
    expectedControlFraction: params.epoch.controlFraction,
    currency,
    ...params.config,
  };

  const observations = params.outcomes.map(settledOutcomeToObservation);
  const priorBilled = params.priorBilledDollars ?? 0;
  const result = computeBillableUplift(observations, config, priorBilled);

  const control = params.outcomes.filter((o) => o.arm === 'control');
  const treatment = params.outcomes.filter((o) => o.arm === 'treatment');

  const fee: FeeWorksheet = {
    feeRate: config.feeRate,
    deltaPer: result.deltaPer,
    se: result.se,
    halfWidth: result.halfWidth,
    lowerPer: result.lowerPer,
    treatedInvoices: result.treatedInvoices,
    lowerDollarsCum: result.lowerDollarsCum.amount,
    priorBilledDollars: priorBilled,
    billableIncrement: result.billableIncrement.amount,
    fee: result.fee.amount,
    billable: result.billable,
    gateReasons: result.gateReasons,
    cupedVarianceReduction: result.cupedVarianceReduction,
    effectiveN: result.effectiveN,
  };

  // Rows a CFO reconciles: anything recovered or reversed carries a processor txn id.
  const recoveredTransactions = params.outcomes
    .filter((o) => o.outcome === 'recovered' || (o.reversalAmount ?? 0) > 0)
    .map((o) => ({ ...o }));

  const ledgerVerified = verifyChain(params.ledger).valid;
  const generatedAt = params.generatedAt ?? new Date().toISOString();

  // Statement hash over the canonical content (excludes the signature block).
  const core = {
    merchantId: params.merchantId,
    period: params.period,
    currency,
    summary: { control: armSummary(control), treatment: armSummary(treatment) },
    fee,
    epoch: params.epoch,
    recoveredTransactions,
    ledgerHead: params.ledgerHead,
    ledgerVerified,
    generatedAt,
  };
  const statementHash = sha256Hex(stableStringify(core));
  const signature = params.signer?.sign(statementHash);
  const signingKeyId = params.signer?.keyId;

  return { ...core, statementHash, signature, signingKeyId };
}

/** Verify a reconciliation export: (1) recompute the statement hash, (2) check the signature. */
export function verifyReconciliationSignature(
  exportDoc: ReconciliationExport,
  publicKeyPem: string,
): { hashMatches: boolean; signatureValid: boolean } {
  const { statementHash, signature, signingKeyId, ...core } = exportDoc;
  void signingKeyId;
  const recomputed = sha256Hex(stableStringify(core));
  const hashMatches = recomputed === statementHash;
  let signatureValid = false;
  if (hashMatches && signature) {
    try {
      signatureValid = edVerify(null, Buffer.from(statementHash), publicKeyPem, Buffer.from(signature, 'hex'));
    } catch {
      signatureValid = false;
    }
  }
  return { hashMatches, signatureValid };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV artifacts
// ─────────────────────────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  // Neutralize CSV formula/DDE injection: a cell a spreadsheet would evaluate as a
  // formula (leading = + - @, tab, or CR) is prefixed with a quote so Excel/Sheets
  // treats it as text. Merchant-controlled fields (invoiceId, etc.) can be hostile.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * The recovered-transactions CSV. A CFO filters their processor's payout export to
 * these `processor_txn_id`s and checks the settled amounts sum to our total, penny
 * for penny. All amounts in integer MINOR UNITS (+ currency) to avoid float error.
 */
export function reconciliationCsv(exportDoc: ReconciliationExport): string {
  const header = [
    'invoice_id', 'customer_id', 'arm', 'stratum', 'decline_code', 'outcome',
    'invoice_amount_minor', 'recovered_amount_minor', 'currency',
    'processor_txn_id', 'settled_at', 'reversal_type', 'reversal_amount_minor', 'reversal_at',
  ];
  const rows = exportDoc.recoveredTransactions.map((o) =>
    csvRow([
      o.invoiceId, o.customerId, o.arm, o.stratum, o.declineCode ?? '', o.outcome,
      o.invoiceAmount, o.recoveredAmount, o.currency,
      o.processorTxnId ?? '', o.settledAt ?? '', o.reversalType ?? 'none', o.reversalAmount ?? 0, o.reversalAt ?? '',
    ]),
  );
  return [csvRow(header), ...rows].join('\n');
}

/** The fee worksheet CSV — every input to `fee = feeRate × billable_increment`, recomputable. */
export function feeWorksheetCsv(exportDoc: ReconciliationExport): string {
  const f = exportDoc.fee;
  const lines: Array<[string, unknown]> = [
    ['metric', 'value'],
    ['fee_rate', f.feeRate],
    ['delta_per_invoice_minor', f.deltaPer],
    ['cluster_robust_se_minor', f.se],
    ['msprt_half_width_minor', f.halfWidth],
    ['lower_bound_per_invoice_minor', f.lowerPer],
    ['treated_invoices', f.treatedInvoices],
    ['lower_bound_cumulative_minor', f.lowerDollarsCum],
    ['prior_billed_minor', f.priorBilledDollars],
    ['billable_increment_minor', f.billableIncrement],
    ['fee_minor', f.fee],
    ['billable', f.billable],
    ['gate_reasons', f.gateReasons.join('; ')],
    ['cuped_variance_reduction', f.cupedVarianceReduction],
    ['effective_n', f.effectiveN],
    ['statement_hash', exportDoc.statementHash],
    ['signing_key_id', exportDoc.signingKeyId ?? ''],
    ['signature', exportDoc.signature ?? ''],
  ];
  return lines.map(csvRow).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The tie-out — reconcile our recovered rows against the processor's payout export
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the processor's own payout/balance export, in minor units. */
export interface PayoutRow {
  /** Match key — processor txn id (preferred) or invoice id. */
  key: string;
  settledAmount: number;
}

export interface ReconLine {
  key: string;
  invoiceId: string;
  ours: number;
  theirs: number | null;
  delta: number;
  match: boolean;
}

export interface ReconResult {
  lines: ReconLine[];
  oursTotal: number;
  theirsTotal: number;
  matched: number;
  mismatched: number;
  /** Recovered rows we claim that are absent from the processor payout — must be 0. */
  missingInPayout: number;
  /** Payout rows not tied to any recovered row we claim (informational). */
  extraInPayout: number;
  /** True iff every claimed recovery ties to a payout line and totals match within tolerance. */
  tiesOut: boolean;
}

/**
 * Reconcile AX10M's recovered transactions against the processor's OWN payout export,
 * penny for penny. This is the CFO's check, as code: because we never touch the
 * money flow, the processor's ledger is the independent source of truth (§8.4).
 *
 * Matches on `processor_txn_id` (falling back to `invoice_id`) and compares the
 * GROSS settled recovered amount — the figure that appears in the payout. (Reversals
 * tie out separately against the processor's refund/dispute report.)
 */
export function reconcileAgainstPayout(
  recovered: readonly SettledOutcome[],
  payout: readonly PayoutRow[],
  opts: { toleranceMinor?: number } = {},
): ReconResult {
  const tolerance = opts.toleranceMinor ?? 0;

  // Aggregate BOTH sides by key. Comparing per-key totals (not per-row against the
  // full balance) is what prevents a duplicate/shared processor_txn_id from tying
  // out falsely: two claimed rows on one settlement sum to 2× ours vs 1× theirs and
  // correctly mismatch, instead of each row independently "matching" the balance.
  const payoutByKey = new Map<string, number>();
  for (const p of payout) payoutByKey.set(p.key, (payoutByKey.get(p.key) ?? 0) + p.settledAmount);

  const claimed = recovered.filter((o) => o.outcome === 'recovered' && o.recoveredAmount > 0);
  const oursByKey = new Map<string, { ours: number; invoiceIds: string[] }>();
  for (const o of claimed) {
    const key = o.processorTxnId ?? o.invoiceId;
    const agg = oursByKey.get(key) ?? { ours: 0, invoiceIds: [] };
    agg.ours += o.recoveredAmount;
    agg.invoiceIds.push(o.invoiceId);
    oursByKey.set(key, agg);
  }

  const lines: ReconLine[] = [];
  let oursTotal = 0;
  let theirsTotal = 0;
  let matched = 0;
  let mismatched = 0;
  let missingInPayout = 0;

  for (const [key, agg] of oursByKey) {
    const ours = agg.ours;
    const theirs = payoutByKey.has(key) ? payoutByKey.get(key)! : null;
    const delta = ours - (theirs ?? 0);
    const match = theirs !== null && Math.abs(delta) <= tolerance;
    if (theirs === null) missingInPayout += 1;
    else if (match) matched += 1;
    else mismatched += 1;
    oursTotal += ours;
    if (theirs !== null) theirsTotal += theirs;
    lines.push({ key, invoiceId: agg.invoiceIds.join(','), ours, theirs, delta, match });
  }

  const extraInPayout = [...payoutByKey.keys()].filter((k) => !oursByKey.has(k)).length;
  const tiesOut =
    mismatched === 0 && missingInPayout === 0 && Math.abs(oursTotal - theirsTotal) <= tolerance;

  return { lines, oursTotal, theirsTotal, matched, mismatched, missingInPayout, extraInPayout, tiesOut };
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Canonical JSON with sorted keys, so the statement hashes identically regardless of key order. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

/** Convenience: format minor units as a decimal string (2dp) for display only. */
export function minorToDecimal(minor: number): string {
  return (minor / 100).toFixed(2);
}

export type { Money };
