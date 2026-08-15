/**
 * Demo-data generator (Phase 2). Produces the dashboard's numbers from the SAME
 * Phase-1 world model + policies, so the demo can never show a result the backtest
 * contradicts. Concretely:
 *
 *  - the shadow-mode projection is computed from the merchant's BASELINE (Smart
 *    Retries over the whole failure stream) via @ax10m/onboarding — it estimates the
 *    recoverable OPPORTUNITY (labeled holdoutVerified:false), NOT engine performance;
 *  - the cohort table + signed statement come from an ACTIVE-mode holdout (baseline on
 *    control, the real engine on treatment) fed through the REAL @ax10m/attribution
 *    estimator + reconciliation. Because the engine does not beat the baseline (see the
 *    backtest), the statement honestly bills $0 — which is exactly the "unproven months
 *    bill $0" invariant, and a verifiable, signed artifact of it.
 *
 * The signing key is generated fresh at generation time; the caller publishes the
 * matching public key alongside the statement. No private key is persisted.
 */

import { familyOf } from '@ax10m/canonical';
import {
  buildBillableStatement,
  buildReconciliationExport,
  createEd25519Signer,
  HashChainedLedger,
  reconcileAgainstPayout,
  reconciliationCsv,
  settledOutcomeToObservation,
  stratumKey,
  DEFAULT_SEQUENTIAL_CONFIG,
  type BillableStatement,
  type EpochDisclosure,
  type LedgerEntry,
  type PayoutRow,
  type ReconciliationExport,
  type ReconResult,
  type SettledOutcome,
} from '@ax10m/attribution';
import {
  beginOnboarding,
  projectShadow,
  readiness,
  shadowProgress,
  type OnboardingState,
  type Readiness,
  type ShadowObservation,
  type ShadowProgress,
  type ShadowProjection,
} from '@ax10m/onboarding';
import { generateStream, type SimInvoice } from './world/world.js';
import { deriveStratum, splitArms } from './estimate.js';
import { runPolicy, type InvoiceOutcome } from './sim/simulate.js';
import { StripeSmartRetriesBaseline } from './baselines/smart-retries.js';
import { EnginePolicy } from './policy/engine-policy.js';
import { deriveSeed } from './rng.js';

const MERCHANT = 'mrc_demo';
const PERIOD = '2026-08';
const SETTLED_AT = '2026-08-20T00:00:00.000Z';
const GENERATED_AT = '2026-09-01T00:00:00.000Z';

const EPOCH: EpochDisclosure = {
  epochId: 'ep_2026_08',
  saltRevealed: 'ax10m-holdout-v1',
  controlFraction: 0.1,
  windowDays: 35,
  alpha: 0.05,
  tau2: 4_000_000,
  billingMode: 'conservative',
};

function toSettled(o: InvoiceOutcome, arm: 'control' | 'treatment', txnIx: number): SettledOutcome {
  const inv = o.invoice;
  return {
    invoiceId: inv.id,
    customerId: inv.customerId,
    arm,
    stratum: stratumKey(deriveStratum(inv)),
    declineCode: inv.declineCode,
    outcome: o.recovered ? 'recovered' : 'failed',
    invoiceAmount: inv.amountMinor,
    recoveredAmount: o.recovered ? inv.amountMinor : 0,
    currency: 'USD',
    processorTxnId: o.recovered ? `txn_${arm[0]}_${txnIx}` : undefined,
    settledAt: o.recovered ? SETTLED_AT : undefined,
    reversalType: 'none',
    reversalAmount: 0,
  };
}

function shadowObservations(baselineAll: readonly InvoiceOutcome[]): ShadowObservation[] {
  return baselineAll.map((o) => ({ declineCode: o.invoice.declineCode, amount: o.invoice.amountMinor, baselineRecovered: o.recovered }));
}

export interface DemoOnboarding {
  state: OnboardingState;
  progress: ShadowProgress;
  projection: ShadowProjection;
  readiness: Readiness;
}

/** The reconciliation export minus the (large) per-row list — for the page bundle. */
export type ReconSummary = Omit<ReconciliationExport, 'recoveredTransactions'> & { recoveredCount: number };

export interface DemoData {
  onboarding: DemoOnboarding;
  statement: BillableStatement;
  reconSummary: ReconSummary;
  reconResult: ReconResult;
  /** Full signed export incl. every recovered row — for download only. */
  fullExport: ReconciliationExport;
  ledger: LedgerEntry[];
  publicKeyPem: string;
  csv: string;
  meta: {
    generatedAt: string;
    nCustomers: number;
    seed: number;
    backtestVerdict: string;
    note: string;
  };
}

export function buildDemoData(opts: { seed?: number; nCustomers?: number } = {}): DemoData {
  const seed = opts.seed ?? 20260814;
  const nCustomers = opts.nCustomers ?? 60_000;
  const stream: SimInvoice[] = generateStream(nCustomers, seed);

  // Shadow projection: baseline over the WHOLE stream (the merchant's own stack).
  const baselineAll = runPolicy(stream, new StripeSmartRetriesBaseline(), deriveSeed(seed, 'shadow'));
  const state = beginOnboarding({ merchantId: MERCHANT, processor: 'stripe', now: '2026-08-06T00:00:00.000Z' });
  const progress = shadowProgress(state, '2026-08-15T00:00:00.000Z');
  const projection = projectShadow(shadowObservations(baselineAll), progress.elapsedDays);
  const ready = readiness(state, projection, progress);

  // Active-mode holdout: baseline on control, the real engine on treatment.
  const { control, treatment } = splitArms(stream);
  const controlOut = runPolicy(control, new StripeSmartRetriesBaseline(), deriveSeed(seed, 'control'));
  const treatmentOut = runPolicy(treatment, new EnginePolicy(), deriveSeed(seed, 'treatment'));
  const outcomes: SettledOutcome[] = [
    ...controlOut.map((o, i) => toSettled(o, 'control', i)),
    ...treatmentOut.map((o, i) => toSettled(o, 'treatment', i)),
  ];

  const ledger = new HashChainedLedger();
  ledger.append({ merchantId: MERCHANT, type: 'uplift.statement', occurredAt: GENERATED_AT, detail: { period: PERIOD, invoices: outcomes.length } });

  const statement = buildBillableStatement({
    merchantId: MERCHANT,
    period: PERIOD,
    observations: outcomes.map(settledOutcomeToObservation),
    priorBilledDollars: 0,
    ledger: ledger.all(),
    ledgerHead: ledger.head(),
    config: { ...DEFAULT_SEQUENTIAL_CONFIG, expectedControlFraction: 0.1 },
  });

  const { signer, publicKeyPem } = createEd25519Signer('ax10m-demo-ed25519');
  const fullExport = buildReconciliationExport({
    merchantId: MERCHANT,
    period: PERIOD,
    outcomes,
    epoch: EPOCH,
    ledger: ledger.all(),
    ledgerHead: ledger.head(),
    signer,
    generatedAt: GENERATED_AT,
  });

  // A synthetic processor payout that the recovered rows tie out against, penny-for-penny.
  const payout: PayoutRow[] = outcomes
    .filter((o) => o.outcome === 'recovered')
    .map((o) => ({ key: o.processorTxnId!, settledAmount: o.recoveredAmount }));
  payout.push({ key: 'txn_unrelated_platform_fee', settledAmount: 1299 });
  const reconResult = reconcileAgainstPayout(outcomes, payout);

  const { recoveredTransactions, ...rest } = fullExport;
  const reconSummary: ReconSummary = { ...rest, recoveredCount: recoveredTransactions.length };

  return {
    onboarding: { state, progress, projection, readiness: ready },
    statement,
    reconSummary,
    reconResult,
    fullExport,
    ledger: [...ledger.all()],
    publicKeyPem,
    csv: reconciliationCsv(fullExport),
    meta: {
      generatedAt: GENERATED_AT,
      nCustomers,
      seed,
      backtestVerdict:
        'The AX10M engine does NOT beat Stripe Smart Retries in the Phase-1 backtest (~-19 pp recovery rate). ' +
        'This demo shows PROJECTED opportunity (not verified) and an honest signed statement that bills $0 until lift is proven.',
      note: 'Synthetic demo data generated by the Phase-1 world model. Not a real merchant; not a performance claim.',
    },
  };
}
