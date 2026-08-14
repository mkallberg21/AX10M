import { beforeEach, describe, expect, it } from 'vitest';
import {
  DeclineCode,
  DeclineFamily,
  type CanonicalEvent,
  type ChargeResult,
  type Customer,
  type Invoice,
  type PaymentMethod,
  type Subscription,
} from '@ax10m/canonical';
import type { Cursor, OpenFailuresPage, ProcessorAdapter, RawWebhook } from '@ax10m/poal';
import { RecoveryCaseService } from './recovery-case.service.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';

/**
 * A fake adapter that records every attemptCharge call (so we can assert the
 * engine→guardrail→adapter path only reaches the processor when it should, and
 * always with a deterministic idempotency key) and returns a scripted outcome.
 */
class FakeAdapter implements ProcessorAdapter {
  readonly id = 'fake';
  readonly charges: Array<{ invoiceId: string; methodId: string; key: string }> = [];
  constructor(private readonly outcome: ChargeResult['outcome'] = 'succeeded') {}

  async ingestWebhook(_raw: RawWebhook): Promise<CanonicalEvent[]> {
    return [];
  }
  async listOpenFailures(_cursor: Cursor): Promise<OpenFailuresPage> {
    return { invoices: [], nextCursor: null };
  }
  async attemptCharge(invoice: Invoice, method: PaymentMethod, idempotencyKey: string): Promise<ChargeResult> {
    this.charges.push({ invoiceId: invoice.id, methodId: method.id, key: idempotencyKey });
    return {
      outcome: this.outcome,
      idempotentReplay: false,
      attempt: {
        id: `att_${this.charges.length}`,
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: this.outcome,
        attemptNumber: 1,
        attemptedAt: '2026-08-14T00:00:00.000Z',
        declineCode: this.outcome === 'failed' ? DeclineCode.InsufficientFunds : undefined,
      },
    };
  }
  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    return null;
  }
  async listPaymentMethods(_customer: Customer): Promise<PaymentMethod[]> {
    return [];
  }
  async pauseNativeDunning(_subscription: Subscription): Promise<void> {}
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
  id: 'ax10m_inv_in_1',
  customerId: 'ax10m_cus_cus_1',
  merchantId: 'mrc_1',
  processorRef: 'in_1',
  amount: { amount: 14900, currency: 'USD' },
  status: 'open',
  createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = {
  id: 'ax10m_pm_pm_1',
  customerId: 'ax10m_cus_cus_1',
  processorRef: 'pm_1',
  token: 'pm_1',
  brand: 'visa',
};
const softDecline = { code: DeclineCode.InsufficientFunds, family: DeclineFamily.Soft };

describe('RecoveryCaseService.executeRecovery', () => {
  let svc: RecoveryCaseService;
  beforeEach(() => {
    svc = new RecoveryCaseService(new OnboardingService());
  });

  it('runs engine → guardrail → adapter and charges on an active soft decline', async () => {
    const adapter = new FakeAdapter('succeeded');
    const head0 = svc.ledgerHead();
    const { action, decision } = await svc.executeRecovery({
      adapter,
      invoice,
      method,
      decline: softDecline,
      attemptNumber: 1,
      shadow: false,
    });
    expect(decision.action).toBe('retry');
    expect(action).toBe('attempted');
    expect(adapter.charges).toHaveLength(1);
    expect(adapter.charges[0]!.invoiceId).toBe('ax10m_inv_in_1');
    // charge.succeeded + case.recovered were appended → the chain head moved.
    expect(svc.ledgerHead()).not.toBe(head0);
  });

  it('SHADOW mode plans + records but never moves money', async () => {
    const adapter = new FakeAdapter('succeeded');
    const { action } = await svc.executeRecovery({
      adapter,
      invoice,
      method,
      decline: softDecline,
      attemptNumber: 1,
      shadow: true,
    });
    expect(action).toBe('shadowed');
    expect(adapter.charges).toHaveLength(0);
  });

  it('routes a dead-credential decline to card-update comms, not a doomed retry', async () => {
    const adapter = new FakeAdapter('succeeded');
    const { action, decision } = await svc.executeRecovery({
      adapter,
      invoice,
      method,
      decline: { code: DeclineCode.ExpiredCard, family: DeclineFamily.Hard },
      attemptNumber: 1,
      shadow: false,
    });
    expect(decision.action).toBe('card_update_comms');
    expect(action).toBe('card_update_comms');
    expect(adapter.charges).toHaveLength(0);
  });

  it('derives a deterministic idempotency key from the saga-owned attemptNumber (exactly-once)', async () => {
    const a1 = new FakeAdapter('failed');
    const a2 = new FakeAdapter('failed');
    await svc.executeRecovery({ adapter: a1, invoice, method, decline: softDecline, attemptNumber: 2, shadow: false });
    await svc.executeRecovery({ adapter: a2, invoice, method, decline: softDecline, attemptNumber: 2, shadow: false });
    expect(a1.charges[0]!.key).toBe(a2.charges[0]!.key); // same tuple → same key → processor de-dupes
  });

  it('lets the guardrail veto a proposed retry BEFORE any charge (cap exceeded)', async () => {
    const adapter = new FakeAdapter('failed');
    // The guardrail is the hard-constraint layer: even a proposed retry is blocked
    // once the all-time cap (DEFAULT_GUARDRAIL_POLICY.maxRetryAttempts = 8) is passed.
    const action = await svc.attemptRecovery({
      adapter,
      invoice,
      method,
      attemptNumber: 12,
      shadow: false,
      proposed: {
        kind: 'charge_retry',
        declineCode: DeclineCode.InsufficientFunds,
        declineFamily: DeclineFamily.Soft,
        attemptsSoFar: 11,
        cardNetwork: 'visa',
        attemptsInWindow: 11,
        localHour: 12,
        hasConsent: true,
        globallyOptedOut: false,
      },
    });
    expect(action).toBe('suppressed');
    expect(adapter.charges).toHaveLength(0);
  });
});

describe('RecoveryCaseService webhook ingress (shadow planning)', () => {
  it('plans recovery for a treatment case without charging', async () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    const head0 = svc.ledgerHead();
    const failEvent: CanonicalEvent = {
      id: 'ce_1',
      type: 'invoice.failed',
      merchantId: 'mrc_1',
      occurredAt: '2026-08-14T00:00:00.000Z',
      processorEventId: 'evt_1',
      payload: { invoice, decline: softDecline },
    };
    const adapter: ProcessorAdapter = Object.assign(new FakeAdapter('succeeded'), {
      ingestWebhook: async () => [failEvent],
    });
    await svc.ingestWithAdapter(adapter, { body: '{}', headers: {} });
    // holdout.assigned was appended regardless of bucket → the chain head moved.
    expect(svc.ledgerHead()).not.toBe(head0);
    expect((adapter as FakeAdapter).charges).toHaveLength(0);
  });
});
