/**
 * Mocked shadow-mode attribution + CFO-reconciliation summary — BILLING-SAFE path.
 *
 * Phase 0 shadow mode shows the merchant, before they activate: (a) projected
 * uplift + the 12% fee, computed by the REAL @lift/attribution billing engine
 * (CUPED + cluster-robust + mSPRT), and (b) the CFO reconciliation — a signed
 * statement whose recovered dollars tie, penny-for-penny, to the processor's own
 * payout export (ATTRIBUTION.md §8.4). Both are derived from the SAME settlement
 * rows, so the invoice and its evidence can never disagree.
 *
 * TODO(lift): replace fabricated SettledOutcomes with a live query against the
 * API's window-closed outcome_log, and the mock payout with the processor's
 * actual payout report.
 */

import {
  buildBillableStatement,
  buildReconciliationExport,
  createEd25519Signer,
  reconcileAgainstPayout,
  settledOutcomeToObservation,
  HashChainedLedger,
  DEFAULT_SEQUENTIAL_CONFIG,
  type BillableStatement,
  type EpochDisclosure,
  type PayoutRow,
  type ReconciliationExport,
  type ReconResult,
  type SettledOutcome,
} from '@lift/attribution';

interface CohortSpec {
  stratum: string;
  controlN: number;
  treatmentN: number;
  controlRate: number;
  treatmentRate: number;
  meanAmount: number;
  spread: number;
}

const COHORTS: CohortSpec[] = [
  { stratum: 'enterprise|soft|na', controlN: 240, treatmentN: 2160, controlRate: 0.45, treatmentRate: 0.58, meanAmount: 50_000, spread: 12_000 },
  { stratum: 'mid|soft|na', controlN: 520, treatmentN: 4680, controlRate: 0.4, treatmentRate: 0.52, meanAmount: 20_000, spread: 8_000 },
  { stratum: 'small|gray|emea', controlN: 610, treatmentN: 5490, controlRate: 0.32, treatmentRate: 0.45, meanAmount: 5_000, spread: 3_000 },
  { stratum: 'micro|hard|apac', controlN: 180, treatmentN: 1620, controlRate: 0.07, treatmentRate: 0.09, meanAmount: 3_000, spread: 1_500 },
];

const EPOCH: EpochDisclosure = {
  epochId: 'ep_2026_08',
  saltRevealed: 'lift-holdout-v1',
  controlFraction: 0.1,
  windowDays: 21,
  alpha: 0.05,
  tau2: 4_000_000,
  billingMode: 'conservative',
};

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

let txn = 0;
function expandArm(spec: CohortSpec, arm: 'control' | 'treatment', seed: number): SettledOutcome[] {
  const n = arm === 'control' ? spec.controlN : spec.treatmentN;
  const rate = arm === 'control' ? spec.controlRate : spec.treatmentRate;
  const rng = lcg(seed);
  const out: SettledOutcome[] = [];
  for (let i = 0; i < n; i++) {
    const recovered = rng() < rate;
    const invoiceAmount = Math.round(spec.meanAmount + (rng() - 0.5) * spec.spread);
    out.push({
      invoiceId: `inv_${arm[0]}_${spec.stratum}_${i}`,
      customerId: `${arm[0]}_${spec.stratum}_${i}`,
      arm,
      stratum: spec.stratum,
      declineCode: 'insufficient_funds',
      outcome: recovered ? 'recovered' : 'failed',
      invoiceAmount,
      recoveredAmount: recovered ? invoiceAmount : 0,
      currency: 'USD',
      processorTxnId: recovered ? `txn_${txn++}` : undefined,
      settledAt: recovered ? '2026-08-20T00:00:00.000Z' : undefined,
      reversalType: 'none',
      reversalAmount: 0,
    });
  }
  return out;
}

function buildOutcomes(): SettledOutcome[] {
  txn = 0;
  const outcomes: SettledOutcome[] = [];
  COHORTS.forEach((c, i) => {
    outcomes.push(...expandArm(c, 'control', 1000 + i * 2));
    outcomes.push(...expandArm(c, 'treatment', 1001 + i * 2));
  });
  return outcomes;
}

function buildLedger(): HashChainedLedger {
  const ledger = new HashChainedLedger();
  for (const c of COHORTS) {
    ledger.append({
      merchantId: 'mrc_demo',
      type: 'uplift.statement',
      occurredAt: '2026-08-31T23:59:59.000Z',
      detail: { stratum: c.stratum, controlN: c.controlN, treatmentN: c.treatmentN },
    });
  }
  return ledger;
}

let cachedStatement: BillableStatement | undefined;
let cachedRecon: { export: ReconciliationExport; recon: ReconResult } | undefined;

/** Billing-safe projected statement (cohort table + KPIs). */
export function getProjectedStatement(): BillableStatement {
  if (cachedStatement) return cachedStatement;
  const observations = buildOutcomes().map(settledOutcomeToObservation);
  const ledger = buildLedger();
  cachedStatement = buildBillableStatement({
    merchantId: 'mrc_demo',
    period: '2026-08',
    observations,
    priorBilledDollars: 0,
    ledger: ledger.all(),
    ledgerHead: ledger.head(),
    config: { ...DEFAULT_SEQUENTIAL_CONFIG, expectedControlFraction: 0.1 },
  });
  return cachedStatement;
}

/**
 * Signed CFO reconciliation export + the penny-for-penny tie-out against a mock
 * processor payout (built from the same recovered rows, so it ties out).
 */
export function getReconciliation(): { export: ReconciliationExport; recon: ReconResult } {
  if (cachedRecon) return cachedRecon;
  const outcomes = buildOutcomes();
  const ledger = buildLedger();
  const { signer } = createEd25519Signer('kms-demo-key-1');
  const exportDoc = buildReconciliationExport({
    merchantId: 'mrc_demo',
    period: '2026-08',
    outcomes,
    epoch: EPOCH,
    ledger: ledger.all(),
    ledgerHead: ledger.head(),
    signer,
    generatedAt: '2026-09-01T00:00:00.000Z',
  });
  // The processor's own payout export: one row per settled recovery (+ an unrelated charge).
  const payout: PayoutRow[] = outcomes
    .filter((o) => o.outcome === 'recovered')
    .map((o) => ({ key: o.processorTxnId!, settledAmount: o.recoveredAmount }));
  payout.push({ key: 'txn_unrelated_fee', settledAmount: 1299 });
  const recon = reconcileAgainstPayout(outcomes, payout);
  cachedRecon = { export: exportDoc, recon };
  return cachedRecon;
}

export function formatMoney(minorUnits: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minorUnits / 100);
}

export function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
