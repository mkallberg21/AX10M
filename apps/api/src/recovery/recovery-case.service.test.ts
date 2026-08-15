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
import type { DurableRecoveryRequest, RecoveryDispatcher } from './recovery-dispatcher.js';

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
    const { result } = await svc.attemptRecovery({
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
    expect(result).toBe('suppressed');
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

describe('durable recovery dispatch (webhook → Temporal workflow)', () => {
  /** Records every dispatched workflow so we can assert on it. */
  class RecordingDispatcher implements RecoveryDispatcher {
    readonly dispatched: DurableRecoveryRequest[] = [];
    async dispatch(req: DurableRecoveryRequest): Promise<void> {
      this.dispatched.push(req);
    }
  }

  const failEvent = (inv: Invoice, withMethod: boolean): CanonicalEvent => ({
    id: `ce_${inv.id}`,
    type: 'invoice.failed',
    merchantId: inv.merchantId,
    occurredAt: '2026-08-14T00:00:00.000Z',
    processorEventId: `evt_${inv.id}`,
    payload: { invoice: inv, decline: softDecline, ...(withMethod ? { method: { ...method, customerId: inv.customerId } } : {}) },
  });

  const feed = async (svc: RecoveryCaseService, inv: Invoice, withMethod: boolean): Promise<void> => {
    const adapter: ProcessorAdapter = Object.assign(new FakeAdapter('succeeded'), { ingestWebhook: async () => [failEvent(inv, withMethod)] });
    await svc.ingestWithAdapter(adapter, { body: '{}', headers: {} });
  };

  // 30 distinct cases → both holdout buckets are present (assignment is deterministic).
  const cases: Invoice[] = Array.from({ length: 30 }, (_, i) => ({
    ...invoice,
    id: `ax10m_inv_disp_${i}`,
    customerId: `ax10m_cus_disp_${i}`,
    processorRef: `in_disp_${i}`,
  }));

  it('dispatches a durable workflow only for TREATMENT cases, keyed by invoice id, in shadow when not live', async () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    const dispatcher = new RecordingDispatcher();
    svc.enableDurableDispatch(dispatcher, { liveCharging: false });
    for (const c of cases) await feed(svc, c, /*withMethod*/ true);

    // Some (not all) cases are treatment → a proper subset dispatched.
    expect(dispatcher.dispatched.length).toBeGreaterThan(0);
    expect(dispatcher.dispatched.length).toBeLessThan(cases.length);
    // Every dispatch is idempotency-keyed to the invoice id, carries the method, and (not
    // live) runs the durable saga in shadow.
    for (const d of dispatcher.dispatched) {
      expect(d.input.saga.attempt.invoice.id).toBe(d.workflowId);
      expect(d.input.saga.attempt.method).toBeDefined();
      expect(d.input.saga.shadow).toBe(true);
    }
  });

  it('passes shadow=false to the durable saga when liveCharging is on', async () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    const dispatcher = new RecordingDispatcher();
    svc.enableDurableDispatch(dispatcher, { liveCharging: true });
    for (const c of cases) await feed(svc, c, true);
    expect(dispatcher.dispatched.length).toBeGreaterThan(0);
    for (const d of dispatcher.dispatched) expect(d.input.saga.shadow).toBe(false);
  });

  it('does NOT dispatch when the normalized event carries no payment method', async () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    const dispatcher = new RecordingDispatcher();
    svc.enableDurableDispatch(dispatcher, { liveCharging: false });
    for (const c of cases) await feed(svc, c, /*withMethod*/ false);
    expect(dispatcher.dispatched).toHaveLength(0);
  });

  it('does NOT dispatch by default (no dispatcher configured → inline shadow-plan only)', async () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    const dispatcher = new RecordingDispatcher();
    for (const c of cases) await feed(svc, c, true); // durable NOT enabled
    expect(dispatcher.dispatched).toHaveLength(0);
  });
});

describe('ARSE sequence planning', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('plans a network-aware NSF sequence that reaches into the pay-cycle window (day 1, 4, 14, ...)', () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    const steps = svc.planSequence({ invoice, method, decline: softDecline, attemptNumber: 1 });
    expect(steps.length).toBeGreaterThanOrEqual(3); // reaches at least ~day 14, not stopping at ~day 11
    expect(steps.every((s) => s.action === 'retry')).toBe(true);
    const t = steps.map((s) => Date.parse(s.at));
    expect(t[1]! - t[0]!).toBe(3 * DAY); // day 1 → day 4
    expect(t[2]! - t[1]!).toBe(10 * DAY); // day 4 → day 14 (the rework: reach the second/third week)
  });

  it('plans a single terminal card_update step for an expired card', () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    const expired = { code: DeclineCode.ExpiredCard, family: DeclineFamily.Gray };
    const steps = svc.planSequence({ invoice, method, decline: expired, attemptNumber: 1 });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.action).toBe('card_update');
  });
});

describe('feature enrichment flywheel', () => {
  it('a recurring customer\'s learned priorRecoveryRate rises across cases and lands in the ledger', async () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    const adapter = new FakeAdapter('succeeded'); // every recovery succeeds → rate should climb
    const bin = '424242';

    for (let i = 0; i < 12; i++) {
      const inv: Invoice = { ...invoice, id: `ax10m_inv_${i}`, processorRef: `in_${i}` };
      const pm: PaymentMethod = { ...method, id: `ax10m_pm_${i}`, bin };
      await svc.executeRecovery({ adapter, invoice: inv, method: pm, decline: softDecline, attemptNumber: 1, shadow: false });
    }

    // Pull the priorRecoveryRate the engine saw at each successive decision from the ledger.
    const rates = svc
      .ledgerEntries()
      .filter((e) => e.type === 'recovery.planned')
      .map((e) => (e.detail.features as { priorRecoveryRate: number }).priorRecoveryRate);

    expect(rates.length).toBe(12);
    expect(rates[0]).toBeCloseTo(0.35, 2); // first case: pure cold-start prior
    expect(rates[rates.length - 1]!).toBeGreaterThan(rates[0]!); // flywheel learned the customer recovers
    expect(rates[rates.length - 1]!).toBeGreaterThan(0.55);
    // The issuer/BIN approval prior also learned from the same wins.
    expect(svc.ledgerEntries().length).toBeGreaterThan(12);
  });
});
