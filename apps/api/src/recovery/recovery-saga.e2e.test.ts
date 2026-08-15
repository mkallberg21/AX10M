import { describe, expect, it } from 'vitest';
import {
  DeclineCode,
  DeclineFamily,
  type CanonicalEvent,
  type ChargeResult,
  type Customer,
  type DeclineEvent,
  type Invoice,
  type PaymentMethod,
  type Subscription,
} from '@ax10m/canonical';
import type { Cursor, OpenFailuresPage, ProcessorAdapter, RawWebhook } from '@ax10m/poal';
import { InMemoryRuntime, runRecoverySaga, runSequencedRecoverySaga, type RecoverySagaInput } from '@ax10m/scheduler';
import { RecoveryCaseService } from './recovery-case.service.js';
import { ServiceRecoveryCasePort } from './recovery-case.port.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';

/** Fails its first `failFirst` charges, then succeeds. Records the idempotency keys used. */
class FlakyAdapter implements ProcessorAdapter {
  readonly id = 'flaky';
  readonly keys: string[] = [];
  constructor(private readonly failFirst: number) {}

  async ingestWebhook(_raw: RawWebhook): Promise<CanonicalEvent[]> {
    return [];
  }
  async listOpenFailures(_cursor: Cursor): Promise<OpenFailuresPage> {
    return { invoices: [], nextCursor: null };
  }
  async attemptCharge(invoice: Invoice, method: PaymentMethod, idempotencyKey: string): Promise<ChargeResult> {
    this.keys.push(idempotencyKey);
    const outcome: ChargeResult['outcome'] = this.keys.length <= this.failFirst ? 'failed' : 'succeeded';
    return {
      outcome,
      idempotentReplay: false,
      attempt: {
        id: `att_${this.keys.length}`,
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: outcome,
        attemptNumber: this.keys.length,
        attemptedAt: '2026-08-14T00:00:00.000Z',
        declineCode: outcome === 'failed' ? DeclineCode.InsufficientFunds : undefined,
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

const invoice: Invoice = {
  id: 'ax10m_inv_1',
  customerId: 'ax10m_cus_1',
  merchantId: 'mrc_1',
  processorRef: 'in_1',
  amount: { amount: 14900, currency: 'USD' },
  status: 'open',
  createdAt: '2026-08-14T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_1', customerId: 'ax10m_cus_1', processorRef: 'pm_1', token: 'pm_1', brand: 'visa' };
const decline: DeclineEvent = {
  id: 'ax10m_dec_1',
  invoiceId: 'ax10m_inv_1',
  chargeAttemptId: 'att_0',
  code: DeclineCode.InsufficientFunds,
  family: DeclineFamily.Soft,
  occurredAt: '2026-08-14T12:00:00.000Z',
};

function newService(): RecoveryCaseService {
  return new RecoveryCaseService(new OnboardingService());
}

describe('recovery saga end-to-end (scheduler → port → service → engine/guardrail → adapter)', () => {
  it('drives real retries through the durable saga and recovers, exactly-once per attempt', async () => {
    const svc = newService();
    const adapter = new FlakyAdapter(1); // fail once, then succeed
    const port = new ServiceRecoveryCasePort(svc, () => adapter, /*shadow*/ false);
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const input: RecoverySagaInput = { attempt: { invoice, method, decline }, shadow: false };

    const head0 = await svc.ledgerHead();
    const res = await runRecoverySaga(port, rt, input);

    expect(res.status).toBe('recovered');
    expect(adapter.keys).toHaveLength(2); // attempt 1 failed, attempt 2 succeeded
    expect(new Set(adapter.keys).size).toBe(2); // distinct keys per attempt (exactly-once within an attempt)
    expect(await svc.ledgerHead()).not.toBe(head0); // charges + case.recovered were ledgered
  });

  it('moves no money in shadow mode but still plans + measures', async () => {
    const svc = newService();
    const adapter = new FlakyAdapter(0);
    const port = new ServiceRecoveryCasePort(svc, () => adapter, /*shadow*/ true);
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const input: RecoverySagaInput = { attempt: { invoice, method, decline }, shadow: true };

    const res = await runRecoverySaga(port, rt, input);

    expect(res.status).toBe('shadow_complete');
    expect(adapter.keys).toHaveLength(0); // never charged
  });

  it('runs the ARSE-planned sequence end-to-end and recovers', async () => {
    const svc = newService();
    const adapter = new FlakyAdapter(1); // first step fails, second succeeds
    const port = new ServiceRecoveryCasePort(svc, () => adapter, /*shadow*/ false);
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const input: RecoverySagaInput = { attempt: { invoice, method, decline }, shadow: false };

    const res = await runSequencedRecoverySaga(port, rt, input);

    expect(res.status).toBe('recovered');
    expect(adapter.keys).toHaveLength(2); // walked step 1 (fail) → step 2 (success)
    expect(res.timeline.some((e) => e.kind === 'planned')).toBe(true);
    expect(res.timeline.filter((e) => e.kind === 'slept').length).toBe(2); // slept to each step
  });
});
