import { describe, expect, it } from 'vitest';
import { HashChainedLedger } from './ledger.js';
import {
  buildReconciliationExport,
  createEd25519Signer,
  feeWorksheetCsv,
  reconcileAgainstPayout,
  reconciliationCsv,
  verifyReconciliationSignature,
  type EpochDisclosure,
  type PayoutRow,
  type SettledOutcome,
} from './reconciliation.js';

/** Deterministic PRNG (LCG). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

let txnCounter = 0;
function makeArm(params: {
  arm: 'control' | 'treatment';
  n: number;
  rate: number;
  meanAmount: number;
  spread: number;
  seed: number;
}): SettledOutcome[] {
  const rng = lcg(params.seed);
  const out: SettledOutcome[] = [];
  for (let i = 0; i < params.n; i++) {
    const recovered = rng() < params.rate;
    const invoiceAmount = Math.round(params.meanAmount + (rng() - 0.5) * params.spread);
    const recoveredAmount = recovered ? invoiceAmount : 0;
    out.push({
      invoiceId: `inv_${params.arm}_${i}`,
      customerId: `cus_${params.arm}_${i}`,
      arm: params.arm,
      stratum: 's1',
      declineCode: 'insufficient_funds',
      outcome: recovered ? 'recovered' : 'failed',
      invoiceAmount,
      recoveredAmount,
      currency: 'USD',
      processorTxnId: recovered ? `txn_${txnCounter++}` : undefined,
      settledAt: recovered ? '2026-11-10T00:00:00.000Z' : undefined,
      reversalType: 'none',
      reversalAmount: 0,
    });
  }
  return out;
}

const epoch: EpochDisclosure = {
  epochId: 'ep_2026_11',
  saltRevealed: 'lift-holdout-v1',
  controlFraction: 0.1,
  windowDays: 21,
  alpha: 0.05,
  tau2: 4_000_000,
  billingMode: 'conservative',
};

function buildLedger(): { ledger: HashChainedLedger } {
  const ledger = new HashChainedLedger();
  ledger.append({ merchantId: 'mrc_1', type: 'uplift.statement', occurredAt: '2026-11-30T00:00:00.000Z', detail: {} });
  return { ledger };
}

describe('buildReconciliationExport', () => {
  const control = makeArm({ arm: 'control', n: 1200, rate: 0.4, meanAmount: 10_000, spread: 6_000, seed: 1 });
  const treatment = makeArm({ arm: 'treatment', n: 10_800, rate: 0.55, meanAmount: 10_000, spread: 6_000, seed: 2 });
  const outcomes = [...control, ...treatment];

  it('produces a fee that ties to the summary and gates, and is reproducible', () => {
    const { ledger } = buildLedger();
    const args = {
      merchantId: 'mrc_1',
      period: '2026-11',
      outcomes,
      epoch,
      ledger: ledger.all(),
      ledgerHead: ledger.head(),
      generatedAt: '2026-12-01T00:00:00.000Z',
    };
    const a = buildReconciliationExport(args);
    const b = buildReconciliationExport(args);

    expect(a.fee.billable).toBe(true);
    expect(a.fee.fee).toBe(Math.round(a.fee.feeRate * a.fee.billableIncrement));
    expect(a.fee.lowerPer).toBeLessThan(a.fee.deltaPer); // under-claim preserved
    expect(a.summary.treatment.recovered).toBeGreaterThan(0);
    expect(a.ledgerVerified).toBe(true);
    // Deterministic given pinned timestamp: same hash both times.
    expect(a.statementHash).toBe(b.statementHash);
  });

  it('signs the statement and the signature verifies; tampering breaks it', () => {
    const { ledger } = buildLedger();
    const { signer, publicKeyPem } = createEd25519Signer('kms-key-1');
    const doc = buildReconciliationExport({
      merchantId: 'mrc_1',
      period: '2026-11',
      outcomes,
      epoch,
      ledger: ledger.all(),
      ledgerHead: ledger.head(),
      signer,
      generatedAt: '2026-12-01T00:00:00.000Z',
    });

    expect(doc.signingKeyId).toBe('kms-key-1');
    const ok = verifyReconciliationSignature(doc, publicKeyPem);
    expect(ok.hashMatches).toBe(true);
    expect(ok.signatureValid).toBe(true);

    // Tamper with the fee → hash no longer matches → verification fails.
    const tampered = { ...doc, fee: { ...doc.fee, fee: doc.fee.fee + 100_00 } };
    const bad = verifyReconciliationSignature(tampered, publicKeyPem);
    expect(bad.hashMatches).toBe(false);
    expect(bad.signatureValid).toBe(false);
  });

  it('emits CSVs whose recovered rows equal the recovered outcomes', () => {
    const { ledger } = buildLedger();
    const doc = buildReconciliationExport({
      merchantId: 'mrc_1', period: '2026-11', outcomes, epoch,
      ledger: ledger.all(), ledgerHead: ledger.head(), generatedAt: '2026-12-01T00:00:00.000Z',
    });
    const csv = reconciliationCsv(doc);
    const dataRows = csv.trim().split('\n').length - 1; // minus header
    const recoveredCount = outcomes.filter((o) => o.outcome === 'recovered').length;
    expect(dataRows).toBe(recoveredCount);
    expect(csv.split('\n')[0]).toContain('processor_txn_id');

    const worksheet = feeWorksheetCsv(doc);
    expect(worksheet).toContain('fee_minor');
    expect(worksheet).toContain(String(doc.fee.fee));
    expect(worksheet).toContain(doc.statementHash);
  });
});

describe('reconcileAgainstPayout', () => {
  const recovered: SettledOutcome[] = [
    { invoiceId: 'inv_1', customerId: 'c1', arm: 'treatment', stratum: 's1', outcome: 'recovered', invoiceAmount: 14900, recoveredAmount: 14900, currency: 'USD', processorTxnId: 'txn_a' },
    { invoiceId: 'inv_2', customerId: 'c2', arm: 'treatment', stratum: 's1', outcome: 'recovered', invoiceAmount: 8900, recoveredAmount: 8900, currency: 'USD', processorTxnId: 'txn_b' },
    { invoiceId: 'inv_3', customerId: 'c3', arm: 'control', stratum: 's1', outcome: 'failed', invoiceAmount: 5000, recoveredAmount: 0, currency: 'USD' },
  ];

  it('ties out penny-for-penny against a matching payout export', () => {
    const payout: PayoutRow[] = [
      { key: 'txn_a', settledAmount: 14900 },
      { key: 'txn_b', settledAmount: 8900 },
      { key: 'txn_unrelated', settledAmount: 500 }, // a non-recovery charge in the same payout
    ];
    const r = reconcileAgainstPayout(recovered, payout);
    expect(r.oursTotal).toBe(23800);
    expect(r.theirsTotal).toBe(23800);
    expect(r.matched).toBe(2);
    expect(r.mismatched).toBe(0);
    expect(r.missingInPayout).toBe(0);
    expect(r.extraInPayout).toBe(1); // txn_unrelated
    expect(r.tiesOut).toBe(true);
  });

  it('flags a recovery we claim that the processor never settled', () => {
    const payout: PayoutRow[] = [{ key: 'txn_a', settledAmount: 14900 }]; // txn_b missing
    const r = reconcileAgainstPayout(recovered, payout);
    expect(r.missingInPayout).toBe(1);
    expect(r.tiesOut).toBe(false);
  });

  it('flags an amount mismatch beyond tolerance', () => {
    const payout: PayoutRow[] = [
      { key: 'txn_a', settledAmount: 14900 },
      { key: 'txn_b', settledAmount: 8800 }, // $1.00 short
    ];
    const r = reconcileAgainstPayout(recovered, payout);
    expect(r.mismatched).toBe(1);
    expect(r.tiesOut).toBe(false);
    // Within a $1 tolerance it ties out.
    const r2 = reconcileAgainstPayout(recovered, payout, { toleranceMinor: 100 });
    expect(r2.mismatched).toBe(0);
    expect(r2.tiesOut).toBe(true);
  });
});
