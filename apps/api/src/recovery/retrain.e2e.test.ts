import { describe, expect, it } from 'vitest';
import {
  DeclineFamily,
  familyOf,
  type CanonicalEvent,
  type ChargeResult,
  type Customer,
  type Invoice,
  type PaymentMethod,
  type Subscription,
} from '@ax10m/canonical';
import type { Cursor, OpenFailuresPage, ProcessorAdapter, RawWebhook } from '@ax10m/poal';
import {
  BOOTSTRAP_RECOVERABILITY_WEIGHTS,
  FEATURE_DIM,
  retrainFromLedger,
  simulateSamples,
} from '@ax10m/recovery-engine';
import { RecoveryCaseService } from './recovery-case.service.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';

/** Adapter whose charge outcome is scripted per invoice (drawn from the DGP). */
class ScriptedOutcomeAdapter implements ProcessorAdapter {
  readonly id = 'sim';
  constructor(private readonly outcomes: Map<string, boolean>) {}
  async ingestWebhook(_r: RawWebhook): Promise<CanonicalEvent[]> {
    return [];
  }
  async listOpenFailures(_c: Cursor): Promise<OpenFailuresPage> {
    return { invoices: [], nextCursor: null };
  }
  async attemptCharge(invoice: Invoice, method: PaymentMethod, idempotencyKey: string): Promise<ChargeResult> {
    const ok = this.outcomes.get(invoice.id) ?? false;
    const outcome: ChargeResult['outcome'] = ok ? 'succeeded' : 'failed';
    return {
      outcome,
      idempotentReplay: false,
      attempt: {
        id: `att_${invoice.id}`,
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: outcome,
        attemptNumber: 1,
        attemptedAt: '2026-08-14T00:00:00.000Z',
      },
    };
  }
  async fetchUpdatedCard(): Promise<PaymentMethod | null> {
    return null;
  }
  async listPaymentMethods(_c: Customer): Promise<PaymentMethod[]> {
    return [];
  }
  async pauseNativeDunning(_s: Subscription): Promise<void> {}
  capabilities() {
    return {
      integrationMode: 'drive' as const,
      externalRetryControl: true,
      accountUpdater: false,
      networkTokens: false,
      partialCapture: false,
      pauseNativeDunning: false,
      webhooks: true,
      listPaymentMethods: true,
    };
  }
}

/**
 * Run the REAL recovery service over a stream of simulated failed invoices in active
 * mode, so the tamper-evident ledger fills with genuine recovery.planned + charge
 * outcome entries — exactly what production accumulates. Returns the service so we can
 * read `ledgerEntries()`.
 */
async function buildLedgerFromService(n: number, seed: number): Promise<RecoveryCaseService> {
  const { samples } = simulateSamples(n, seed);
  const outcomes = new Map<string, boolean>();
  const svc = new RecoveryCaseService(new OnboardingService());
  const adapter = new ScriptedOutcomeAdapter(outcomes);

  for (let i = 0; i < samples.length; i++) {
    const f = samples[i]!.features;
    const invoice: Invoice = {
      id: `ax10m_inv_${i}`,
      customerId: `ax10m_cus_${i}`,
      merchantId: 'mrc_1',
      processorRef: `in_${i}`,
      amount: { amount: f.amountMinor, currency: 'USD' },
      status: 'open',
      createdAt: '2026-08-14T00:00:00.000Z',
    };
    const method: PaymentMethod = { id: `ax10m_pm_${i}`, customerId: invoice.customerId, processorRef: `pm_${i}`, token: `pm_${i}`, brand: 'visa' };
    const decline = {
      id: `dec_${i}`,
      invoiceId: invoice.id,
      chargeAttemptId: '',
      code: f.declineCode,
      family: familyOf(f.declineCode),
      occurredAt: '2026-08-14T12:00:00.000Z',
    };
    outcomes.set(invoice.id, samples[i]!.recovered);
    // Only treatment-bucket cases are charged; here we drive every case active so the
    // ledger fills. Hard declines route to comms (no charge → no training label).
    if (decline.family !== DeclineFamily.Hard) {
      await svc.executeRecovery({ adapter, invoice, method, decline, attemptNumber: 1, shadow: false });
    }
  }
  return svc;
}

describe('retrain on the ledger the service actually produces', () => {
  it('extracts a labeled corpus from the real ledger and fits a challenger through the promotion gate', async () => {
    const svc = await buildLedgerFromService(4000, 123);
    const entries = svc.ledgerEntries();

    // Against a blank champion (AUC 0.5), a challenger fit on the real ledger should
    // learn the decline/amount signal and be promoted.
    const blankChampion = { w: new Array<number>(FEATURE_DIM).fill(0), b: 0 };
    const report = retrainFromLedger(entries, blankChampion);

    expect(report.accepted).toBe(true);
    expect(report.nSamples).toBeGreaterThanOrEqual(500);
    expect(report.nPositives).toBeGreaterThan(50);
    expect(report.nNegatives).toBeGreaterThan(50);
    expect(report.challenger!.auc).toBeGreaterThan(0.6); // real signal present in the ledger
    expect(report.promoted).toBe(true);
    expect(report.weights!.w).toHaveLength(FEATURE_DIM);
  });

  it('never ships a regression: if promoted, the challenger beat the champion on held-out data', async () => {
    const svc = await buildLedgerFromService(4000, 321);
    const entries = svc.ledgerEntries();

    // Compare against the strong shipped bootstrap champion. The gate must either
    // decline to promote, or promote something genuinely better — never a regression.
    const report = retrainFromLedger(entries, BOOTSTRAP_RECOVERABILITY_WEIGHTS);
    expect(report.accepted).toBe(true);
    if (report.promoted) {
      expect(report.challenger!.auc).toBeGreaterThanOrEqual(report.champion!.auc);
    }
  });

  it('rejects a too-thin ledger via the data-quality gate (no model shipped)', async () => {
    const svc = await buildLedgerFromService(60, 7);
    const entries = svc.ledgerEntries();
    const report = retrainFromLedger(entries, BOOTSTRAP_RECOVERABILITY_WEIGHTS);
    expect(report.accepted).toBe(false);
    expect(report.reason).toBe('insufficient_samples');
    expect(report.promoted).toBe(false);
    expect(report.weights).toBeUndefined();
  });
});
