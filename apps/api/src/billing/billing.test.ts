import { describe, expect, it } from 'vitest';
import { createEd25519Signer, verifyChain, HashChainedLedger, DEFAULT_SEQUENTIAL_CONFIG, type SequentialUpliftConfig } from '@ax10m/attribution';
import { previousMonth, reconstructObservations, merchantsInLedger, type BillingLedgerEntry } from './observations.js';
import { computeMerchantStatement, priorBilledFromLedger, statementHashMatches } from './billing.js';
import { runBilling, type LedgerAppend } from './billing-run.js';
import { NoopBillingCharger, type BillingCharger, type BillingChargeReceipt } from './charger.js';

// A period well inside the previous calendar month relative to NOW.
const NOW = '2026-08-16T12:00:00.000Z';
const PREV = previousMonth(NOW); // 2026-07
const inPrev = (day: number, hour = 12): string => new Date(Date.UTC(2026, 6, day, hour)).toISOString();

/** Relaxed gates so a small synthetic cohort can prove lift (real gates are validated in @ax10m/attribution). */
const RELAXED: SequentialUpliftConfig = { ...DEFAULT_SEQUENTIAL_CONFIG, minControlClusters: 5, minTreatedInvoices: 5, perStratumFloor: 2, expectedControlFraction: 0.5, srmThreshold: 1e9, useCuped: false };

/**
 * Build a balanced cohort assigned in the previous month: treatment recovers `treatAmount`, control
 * recovers `controlAmount` (< treatment → positive lift). Returns ledger entries.
 */
function cohort(merchantId: string, n: number, treatAmount: number, controlAmount: number): BillingLedgerEntry[] {
  const out: BillingLedgerEntry[] = [];
  for (let i = 0; i < n; i++) {
    const arm = i % 2 === 0 ? 'treatment' : 'control';
    const invoiceId = `inv_${merchantId}_${i}`;
    const day = 1 + (i % 27);
    out.push({ merchantId, type: 'holdout.assigned', occurredAt: inPrev(day), detail: { invoiceId, customerId: `cus_${merchantId}_${i}`, bucket: arm, stratumKey: 'default', amount: 10_000, currency: 'USD' } });
    // Within-arm jitter → non-zero variance (a constant outcome makes SE=0, tripping the estimable gate).
    const base = arm === 'treatment' ? treatAmount : controlAmount;
    const amt = Math.max(0, base + ((i % 7) - 3) * 400);
    if (amt > 0) out.push({ merchantId, type: 'case.recovered', occurredAt: inPrev(day, 14), detail: { invoiceId, processor: 'stripe', amount: amt, currency: 'USD' } });
  }
  return out;
}

describe('reconstructObservations', () => {
  it('builds one observation per in-period assigned invoice with the net recovered outcome', () => {
    const entries: BillingLedgerEntry[] = [
      { merchantId: 'm1', type: 'holdout.assigned', occurredAt: inPrev(5), detail: { invoiceId: 'A', customerId: 'c1', bucket: 'treatment', stratumKey: 's', amount: 10_000 } },
      { merchantId: 'm1', type: 'case.recovered', occurredAt: inPrev(6), detail: { invoiceId: 'A', amount: 10_000, currency: 'USD' } },
      { merchantId: 'm1', type: 'case.reversed', occurredAt: inPrev(9), detail: { invoiceId: 'A', amount: 3_000, currency: 'USD' } },
      // assigned OUTSIDE the period → excluded
      { merchantId: 'm1', type: 'holdout.assigned', occurredAt: '2026-06-15T00:00:00.000Z', detail: { invoiceId: 'B', customerId: 'c2', bucket: 'control', stratumKey: 's', amount: 5_000 } },
    ];
    const obs = reconstructObservations(entries, 'm1', PREV);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ arm: 'treatment', cluster: 'c1', stratum: 's', outcome: 7_000, covariate: 10_000, recovered: true }); // net = 10000 - 3000
  });
});

describe('computeMerchantStatement + signing + watermark', () => {
  const ledgerHead = 'head_abc';
  const signer = createEd25519Signer('test').signer;

  it('produces a signed statement with a positive fee when the holdout proves lift', () => {
    const entries = cohort('m1', 300, 8_000, 2_000); // treatment nets 8000, control 2000
    const s = computeMerchantStatement({ entries, merchantId: 'm1', period: PREV, ledger: [], ledgerHead, signer, config: RELAXED });
    expect(s.period).toBe('2026-07');
    expect(s.result.billable).toBe(true);
    expect(s.result.fee.amount).toBeGreaterThan(0);
    // 12% of the proven lower-bound increment
    expect(s.result.fee.amount).toBe(Math.round(s.result.billableIncrement.amount * 0.12));
    expect(statementHashMatches(s)).toBe(true);
    expect(s.signature).toMatch(/^[0-9a-f]+$/);
  });

  it('never re-bills: the prior watermark zeroes out the next period increment', () => {
    const entries = cohort('m1', 300, 8_000, 2_000);
    const first = computeMerchantStatement({ entries, merchantId: 'm1', period: PREV, ledger: [], ledgerHead, signer, config: RELAXED });
    // Record the first statement's watermark and recompute — increment should collapse to ~0.
    const withWatermark: BillingLedgerEntry[] = [
      ...entries,
      { merchantId: 'm1', type: 'uplift.statement', occurredAt: NOW, detail: { lowerDollarsCum: first.result.lowerDollarsCum.amount } },
    ];
    expect(priorBilledFromLedger(withWatermark, 'm1')).toBe(first.result.lowerDollarsCum.amount);
    const second = computeMerchantStatement({ entries: withWatermark, merchantId: 'm1', period: PREV, ledger: [], ledgerHead, signer, config: RELAXED });
    expect(second.result.billableIncrement.amount).toBeLessThanOrEqual(0); // nothing new to bill
    expect(second.result.fee.amount).toBeLessThanOrEqual(0);
  });
});

describe('runBilling', () => {
  const signer = createEd25519Signer('test').signer;

  it('records an uplift.statement per merchant and does NOT charge by default', async () => {
    const entries = cohort('m1', 300, 8_000, 2_000);
    const appended: LedgerAppend[] = [];
    const { summary } = await runBilling({ entries, ledger: [], ledgerHead: 'h', append: async (e) => void appended.push(e), signer, nowIso: NOW, config: RELAXED });
    expect(summary.merchants).toHaveLength(1);
    expect(summary.merchants[0]!.feeMinor).toBeGreaterThan(0);
    expect(summary.merchants[0]!.charge).toBeUndefined(); // not live → no charge
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ type: 'uplift.statement', merchantId: 'm1' });
    expect((appended[0]!.detail as { lowerDollarsCum?: number }).lowerDollarsCum).toBeGreaterThan(0);
  });

  it('collects the fee only when live AND a charger is wired', async () => {
    const entries = cohort('m1', 300, 8_000, 2_000);
    const charges: number[] = [];
    const charger: BillingCharger = { async charge(req): Promise<BillingChargeReceipt> { charges.push(req.amountMinor); return { status: 'charged', provider: 'test', reference: 'ch_1' }; } };
    const { summary } = await runBilling({ entries, ledger: [], ledgerHead: 'h', signer, nowIso: NOW, live: true, charger, config: RELAXED });
    expect(summary.merchants[0]!.charge?.status).toBe('charged');
    expect(charges[0]).toBe(summary.merchants[0]!.feeMinor);
    expect(summary.totalChargedMinor).toBe(summary.totalFeeMinor);
  });

  it('the default NoopBillingCharger collects nothing even when live', async () => {
    const entries = cohort('m1', 300, 8_000, 2_000);
    const { summary } = await runBilling({ entries, ledger: [], ledgerHead: 'h', signer, nowIso: NOW, live: true, charger: new NoopBillingCharger(), config: RELAXED });
    expect(summary.merchants[0]!.charge?.status).toBe('skipped');
    expect(summary.totalChargedMinor).toBe(0);
  });

  it('the recorded statement keeps the ledger a verifiable chain', async () => {
    const entries = cohort('m1', 300, 8_000, 2_000);
    const chain = new HashChainedLedger();
    await runBilling({ entries, ledger: chain.all(), ledgerHead: chain.head(), append: async (e) => void chain.append(e), signer, nowIso: NOW, config: RELAXED });
    expect(verifyChain(chain.all()).valid).toBe(true);
    expect(chain.all().some((e) => e.type === 'uplift.statement')).toBe(true);
  });

  it('lists merchants from the ledger', () => {
    expect(merchantsInLedger([...cohort('m1', 2, 1, 1), ...cohort('m2', 2, 1, 1)]).sort()).toEqual(['m1', 'm2']);
  });
});
