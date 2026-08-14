/**
 * GoCardless processor adapter — CO-DRIVE (bank debit: ACH / SEPA / BACS / …).
 *
 * The credential is a MANDATE, not a card — so there is no PAN, no Account Updater,
 * and no network tokens (near-zero card PCI scope). End-to-end against the
 * GoCardless API + signed webhooks:
 *  - ingestWebhook   — verify the Webhook-Signature (HMAC-SHA256), then, for each
 *                      payment event, fetch the payment and normalize
 *                      failed → invoice.failed / confirmed → invoice.paid. The
 *                      failed payload carries `willAutoRetry` (payment.retry_if_possible)
 *                      so the engine can DECONFLICT with GoCardless's own Success+
 *                      (NSF-only) retries and never double-collect.
 *  - listOpenFailures— a real reconciliation poll: GET /payments?status=failed
 *                      (GoCardless IS a payment ledger, unlike a card gateway).
 *  - attemptCharge   — POST /payments/:id/actions/retry (mandate must be active),
 *                      Idempotency-Key. Bank debit is asynchronous, so a successful
 *                      retry submission resolves to `pending` — the real outcome
 *                      arrives later via webhook.
 *  - listPaymentMethods — a customer's mandates (the reusable credentials).
 *  - fetchUpdatedCard — null: N/A for bank debit (no card to refresh).
 *  - pauseNativeDunning — no-op: Success+ is controlled per-payment via
 *                      retry_if_possible, set at payment creation.
 */

import {
  familyOf,
  type CanonicalEvent,
  type ChargeAttempt,
  type Customer,
  type DeclineCode,
  type DeclineEvent,
  type Invoice,
  type Money,
  type PaymentMethod,
  type Subscription,
} from '@ax10m/canonical';
import type {
  CapabilityMatrix,
  ChargeResult,
  Cursor,
  OpenFailuresPage,
  ProcessorAdapter,
  RawWebhook,
} from '../../adapter.js';
import { GoCardlessClient, GoCardlessError, type FetchLike } from './client.js';
import { mapGoCardlessCause, verifyGoCardlessSignature } from './cause-map.js';

export interface GoCardlessAdapterConfig {
  accessToken: string;
  webhookSecret: string;
  /** AX10M-internal merchant id this adapter instance serves. */
  merchantId: string;
  environment?: 'sandbox' | 'live';
  /** Leave Success+ on (co-drive NSF failures) or take full control (drive). */
  disableSuccessPlus?: boolean;
  baseUrl?: string;
  fetch?: FetchLike;
}

interface GcPayment {
  id: string;
  amount?: number;
  currency?: string;
  status?: string;
  created_at?: string;
  retry_if_possible?: boolean;
  links?: { mandate?: string; subscription?: string; customer?: string };
}
interface GcEvent {
  id?: string;
  created_at?: string;
  resource_type?: string;
  action?: string;
  links?: { payment?: string; mandate?: string };
  details?: { cause?: string; description?: string; scheme?: string; reason_code?: string };
}

const CENTS = (n: number | undefined): number => (typeof n === 'number' ? n : 0);

/** Case-insensitive header lookup (proxies vary the casing of Webhook-Signature). */
function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function statusToOutcome(status: string | undefined): ChargeResult['outcome'] {
  switch (status) {
    case 'confirmed':
    case 'paid_out':
      return 'succeeded';
    case 'failed':
    case 'cancelled':
    case 'customer_approval_denied':
    case 'charged_back':
      return 'failed';
    default:
      return 'pending'; // pending_submission | submitted | pending_customer_approval — bank debit is async
  }
}

export class GoCardlessAdapter implements ProcessorAdapter {
  readonly id = 'gocardless';
  private readonly client: GoCardlessClient;

  constructor(private readonly config: GoCardlessAdapterConfig) {
    this.client = new GoCardlessClient({
      accessToken: config.accessToken,
      environment: config.environment,
      baseUrl: config.baseUrl,
      fetch: config.fetch,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: this.config.disableSuccessPlus ? 'drive' : 'co-drive',
      externalRetryControl: true,
      accountUpdater: false, // N/A for bank debit
      networkTokens: false, // N/A for bank debit
      partialCapture: false, // model a partial as a new, smaller payment on the mandate
      pauseNativeDunning: true, // via retry_if_possible=false at creation
      webhooks: true,
      listPaymentMethods: true, // mandates
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    const signature = headerLookup(raw.headers, 'webhook-signature');
    if (!verifyGoCardlessSignature(raw.body, signature, this.config.webhookSecret)) {
      throw new Error('GoCardlessAdapter.ingestWebhook: Webhook-Signature verification failed');
    }
    let parsed: { events?: GcEvent[] };
    try {
      parsed = JSON.parse(raw.body);
    } catch {
      throw new Error('GoCardlessAdapter.ingestWebhook: body is not valid JSON');
    }

    const out: CanonicalEvent[] = [];
    for (const event of parsed.events ?? []) {
      if (event.resource_type !== 'payments') continue; // mandate events: TODO(ax10m) re-auth flow
      if (event.action !== 'failed' && event.action !== 'confirmed') continue;
      const paymentId = event.links?.payment;
      if (!paymentId) continue;
      // Isolate per-event fetch failures: a transient error on one payment must not
      // discard every already-mapped event in the (batched) webhook. GoCardless
      // re-delivers, so a skipped event is retried; aborting the batch loses all.
      try {
        const payment = await this.getPayment(paymentId);
        if (payment) out.push(this.mapPaymentEvent(event, payment));
      } catch {
        // swallow; the event will be re-delivered and reprocessed
      }
    }
    return out;
  }

  private async getPayment(id: string): Promise<GcPayment | null> {
    const res = await this.client.get(`/payments/${encodeURIComponent(id)}`);
    return (res.payments as GcPayment | undefined) ?? null;
  }

  private mapPaymentEvent(event: GcEvent, payment: GcPayment): CanonicalEvent {
    const failed = event.action === 'failed';
    const occurredAt = event.created_at ?? payment.created_at ?? new Date(0).toISOString();
    const invoice = this.mapInvoice(payment, occurredAt, failed);
    const attempt = this.buildAttempt({
      invoiceId: invoice.id,
      paymentMethodId: payment.links?.mandate ? `ax10m_pm_${payment.links.mandate}` : '',
      idempotencyKey: '',
      amount: invoice.amount,
      status: failed ? 'failed' : 'succeeded',
      declineCode: failed ? mapGoCardlessCause(event.details?.cause) : undefined,
      txnId: payment.id,
      attemptedAt: occurredAt,
    });
    const base = {
      id: `ax10m_evt_${event.id ?? payment.id}`,
      merchantId: this.config.merchantId,
      processorEventId: event.id ?? '',
      occurredAt,
    };
    if (failed) {
      const decline = this.buildDecline(event, invoice.id, attempt.id, occurredAt);
      // willAutoRetry: GoCardless Success+ auto-retries ONLY insufficient-funds
      // failures whose payment was created with retry_if_possible. It will NOT
      // retry other causes (dead mandate, closed account, …), so we must gate on
      // BOTH the flag and the cause — otherwise a non-NSF failure is wrongly
      // deferred to a retry that never happens, and the recovery is lost.
      const willAutoRetry =
        payment.retry_if_possible === true &&
        (event.details?.cause ?? '').trim().toLowerCase() === 'insufficient_funds';
      return {
        ...base,
        type: 'invoice.failed',
        payload: { invoice, attempt, decline, willAutoRetry },
      };
    }
    return { ...base, type: 'invoice.paid', payload: { invoice, attempt } };
  }

  // ── reconciliation poll (GoCardless is a payment ledger) ─────────────────────

  async listOpenFailures(cursor: Cursor): Promise<OpenFailuresPage> {
    const res = await this.client.get('/payments', { status: 'failed', limit: 100, after: cursor ?? undefined });
    const payments = Array.isArray(res.payments) ? (res.payments as GcPayment[]) : [];
    const invoices = payments.map((p) => this.mapInvoice(p, p.created_at ?? new Date(0).toISOString(), true));
    const meta = res.meta as { cursors?: { after?: string | null } } | undefined;
    const nextCursor = meta?.cursors?.after ?? null;
    return { invoices, nextCursor };
  }

  // ── co-drive: retry ──────────────────────────────────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    try {
      const res = await this.client.post(`/payments/${encodeURIComponent(invoice.processorRef)}/actions/retry`, undefined, idempotencyKey);
      const payment = (res.payments as GcPayment | undefined) ?? ({} as GcPayment);
      const outcome = statusToOutcome(payment.status);
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: outcome,
        txnId: payment.id ?? invoice.processorRef,
        attemptedAt: new Date().toISOString(),
      });
      return { attempt, outcome, idempotentReplay: false };
    } catch (err) {
      if (err instanceof GoCardlessError && err.isIdempotentConflict()) {
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: method.id,
          idempotencyKey,
          amount: invoice.amount,
          status: 'pending',
          txnId: invoice.processorRef,
          attemptedAt: new Date().toISOString(),
        });
        return { attempt, outcome: 'pending', idempotentReplay: true };
      }
      throw err;
    }
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    return null; // N/A for bank debit — the mandate, not a card, is the credential
  }

  async listPaymentMethods(customer: Customer): Promise<PaymentMethod[]> {
    const res = await this.client.get('/mandates', { customer: customer.processorRef, limit: 100 });
    const mandates = Array.isArray(res.mandates)
      ? (res.mandates as Array<{ id?: string; scheme?: string; status?: string }>)
      : [];
    return mandates
      .filter((m) => m.id)
      .map((m) => ({
        id: `ax10m_pm_${m.id}`,
        customerId: customer.id,
        processorRef: m.id!,
        token: m.id!, // the mandate id is the reusable credential — no card, no PAN
        brand: m.scheme ?? 'bank_debit',
      }));
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: GoCardless Success+ retries are controlled per-payment via
    // retry_if_possible (set at payment creation), not a subscription-level toggle.
    // Full DRIVE mode is achieved by creating payments with retry_if_possible=false.
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  private mapInvoice(p: GcPayment, occurredAt: string, failed: boolean): Invoice {
    return {
      id: `ax10m_inv_${p.id}`,
      subscriptionId: p.links?.subscription ? `ax10m_sub_${p.links.subscription}` : undefined,
      customerId: p.links?.customer ? `ax10m_cus_${p.links.customer}` : '',
      merchantId: this.config.merchantId,
      processorRef: p.id,
      amount: { amount: CENTS(p.amount), currency: p.currency ?? 'GBP' },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: p.created_at ?? occurredAt,
    };
  }

  private buildAttempt(p: {
    invoiceId: string;
    paymentMethodId: string;
    idempotencyKey: string;
    amount: Money;
    status: ChargeAttempt['status'];
    declineCode?: DeclineCode;
    txnId?: string;
    attemptedAt: string;
  }): ChargeAttempt {
    return {
      id: `ax10m_att_${p.txnId ?? (p.idempotencyKey || 'unknown')}`,
      invoiceId: p.invoiceId,
      paymentMethodId: p.paymentMethodId,
      idempotencyKey: p.idempotencyKey,
      amount: p.amount,
      status: p.status,
      declineCode: p.declineCode,
      attemptNumber: 1,
      attemptedAt: p.attemptedAt,
    };
  }

  private buildDecline(event: GcEvent, invoiceId: string, chargeAttemptId: string, occurredAt: string): DeclineEvent {
    const code = mapGoCardlessCause(event.details?.cause);
    return {
      id: `ax10m_dec_${event.id ?? invoiceId}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason: event.details?.description ?? event.details?.cause,
      occurredAt,
    };
  }
}
