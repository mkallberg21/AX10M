/**
 * Checkout.com processor adapter — DRIVE (PROCESSORS.md §3, ARCHITECTURE.md §4.1).
 *
 * NOTE: the endpoint paths (`POST /payments`), request/response field names
 * (`source.id`, `status`, `response_code`, `response_summary`), the idempotency
 * header (`Cko-Idempotency-Key`) and the webhook signature header (`Cko-Signature`)
 * are modeled on Checkout.com's documented Payments/Webhooks API and MUST be
 * confirmed against the current API version before production. The enforcement
 * MECHANISM this adapter delivers is the real deliverable and is version-stable:
 * deterministic idempotency, fail-closed HMAC webhook verification, token-only
 * (SAQ-A — we never see a PAN), and decline-vs-error separation.
 *
 * End-to-end against the Checkout.com Payments API + webhooks:
 *  - ingestWebhook   — HMAC-verify `Cko-Signature`, normalize payment_declined →
 *                      invoice.failed and payment_captured/payment_approved →
 *                      invoice.paid.
 *  - attemptCharge   — POST /payments against a stored source token (never a PAN →
 *                      SAQ-A), merchant-initiated Recurring, deterministic
 *                      idempotency key. A `Declined` status (or a 4xx decline body)
 *                      is a decline, not an infra error.
 *  - listOpenFailures— Checkout is a gateway, not a biller: no invoice ledger, so
 *                      failures arrive via webhooks (returns empty here).
 *  - fetchUpdatedCard— Checkout auto-updates network tokens server-side (returns null).
 *  - listPaymentMethods — Checkout instruments are per-id, not enumerable per
 *                      customer (returns empty).
 *  - pauseNativeDunning — no-op: a gateway runs no merchant dunning to disable.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
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
import { customerFromInvoice } from '../../customer.js';
import type {
  CapabilityMatrix,
  ChargeResult,
  Cursor,
  OpenFailuresPage,
  ProcessorAdapter,
  RawWebhook,
} from '../../adapter.js';
import { CheckoutClient, CheckoutError, type FetchLike } from './client.js';
import { mapCheckoutResponseCode } from './decline-map.js';

export interface CheckoutAdapterConfig {
  /** Secret key (sk_...) used as the Bearer credential. Injected, never hardcoded. */
  secretKey: string;
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Webhook signature key — the secret Checkout signs the `Cko-Signature` HMAC with. */
  webhookSecret?: string;
  /** Override base URL (sandbox / regions). Defaults to https://api.checkout.com. */
  baseUrl?: string;
  /** Injectable transport for testing. */
  fetch?: FetchLike;
}

/** Shape of the Checkout.com payment response we read (only the fields we use). */
interface CkoPaymentResponse {
  id?: string; // pay_...
  status?: string; // Authorized | Captured | Declined | Pending | ...
  response_code?: string;
  response_summary?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  processed_on?: string;
}

/** Shape of a Checkout.com webhook envelope (only the fields we use). */
interface CkoWebhookEnvelope {
  id?: string;
  type?: string; // payment_declined | payment_captured | payment_approved | ...
  created_on?: string;
  data?: {
    id?: string; // pay_...
    reference?: string;
    amount?: number;
    currency?: string;
    response_code?: string;
    response_summary?: string;
    source?: { id?: string };
  };
}

const CENTS = (n: number | undefined): number => (typeof n === 'number' ? n : 0);

function toIso(value: string | undefined): string {
  if (!value) return new Date(0).toISOString();
  const t = Date.parse(value);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

// ── Webhook signature (Checkout.com `Cko-Signature`) ─────────────────────────────

/** Compute the hex HMAC-SHA256 signature Checkout sends in `Cko-Signature`. */
export function computeCheckoutSignature(body: string, webhookSecret: string): string {
  return createHmac('sha256', webhookSecret).update(body, 'utf8').digest('hex');
}

/** Constant-time verification of a `Cko-Signature` header against the recomputed HMAC. */
export function verifyCheckoutSignature(body: string, provided: string, webhookSecret: string): boolean {
  const expected = computeCheckoutSignature(body, webhookSecret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class CheckoutAdapter implements ProcessorAdapter {
  readonly id = 'checkout';
  private readonly client: CheckoutClient;

  constructor(private readonly config: CheckoutAdapterConfig) {
    this.client = new CheckoutClient({
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      fetch: config.fetch,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive',
      externalRetryControl: true,
      accountUpdater: true, // network tokens auto-refreshed server-side
      networkTokens: true,
      partialCapture: true,
      pauseNativeDunning: false, // a gateway has no merchant dunning to pause
      webhooks: true,
      listPaymentMethods: false, // instruments are per-id, not enumerable per customer
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    // Fail CLOSED: without a configured signing secret we cannot trust the body,
    // so we refuse rather than accept a forged (unauthenticated) webhook.
    if (!this.config.webhookSecret) {
      throw new Error('CheckoutAdapter.ingestWebhook: webhookSecret not configured — refusing unverified webhook');
    }
    const provided = headerLookup(raw.headers, 'cko-signature') ?? '';
    if (!verifyCheckoutSignature(raw.body, provided, this.config.webhookSecret)) {
      throw new Error('CheckoutAdapter.ingestWebhook: Cko-Signature verification failed');
    }

    let event: CkoWebhookEnvelope;
    try {
      event = JSON.parse(raw.body);
    } catch {
      throw new Error('CheckoutAdapter.ingestWebhook: body is not valid JSON');
    }
    const eventId = event.id ?? '';
    const occurredAt = toIso(event.created_on);
    const data = event.data ?? {};

    const base = {
      id: `ax10m_evt_${eventId}`,
      merchantId: this.config.merchantId,
      processorEventId: eventId,
      occurredAt,
    };

    switch (event.type) {
      case 'payment_declined': {
        const invoice = this.mapInvoice(data, occurredAt, /*failed*/ true);
        const attempt = this.mapAttempt(data, invoice.id, /*failed*/ true, occurredAt);
        const decline = this.mapDecline(data, invoice.id, attempt.id, occurredAt);
        return [{ ...base, type: 'invoice.failed', payload: { invoice, attempt, decline, customer: customerFromInvoice(invoice) } }];
      }
      case 'payment_captured':
      case 'payment_approved': {
        const invoice = this.mapInvoice(data, occurredAt, /*failed*/ false);
        const attempt = this.mapAttempt(data, invoice.id, /*failed*/ false, occurredAt);
        return [{ ...base, type: 'invoice.paid', payload: { invoice, attempt } }];
      }
      default:
        return []; // event we don't act on
    }
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(_cursor: Cursor): Promise<OpenFailuresPage> {
    // Checkout.com is a payment gateway, not a biller — there is no invoice ledger
    // to poll. Failures arrive via webhooks; $-reconciliation is against Checkout's
    // financial actions / payments-search report (TODO(ax10m): wire the report API).
    // Invoice state lives in the merchant's billing system, reconciled there.
    return { invoices: [], nextCursor: null };
  }

  // ── drive: charge ────────────────────────────────────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    try {
      const { body, idempotentReplay } = await this.client.post(
        '/payments',
        {
          source: { type: 'id', id: method.token },
          amount: invoice.amount.amount,
          currency: invoice.amount.currency,
          reference: invoice.processorRef,
          merchant_initiated: true,
          payment_type: 'Recurring',
        },
        idempotencyKey,
      );
      const payment = body as CkoPaymentResponse;
      const status = payment.status ?? '';
      const outcome: ChargeResult['outcome'] =
        status === 'Authorized' || status === 'Captured'
          ? 'succeeded'
          : status === 'Declined'
            ? 'failed'
            : 'pending';
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: outcome,
        declineCode: outcome === 'failed' ? mapCheckoutResponseCode(payment.response_code) : undefined,
        txnId: payment.id,
        attemptedAt: toIso(payment.processed_on),
      });
      return { attempt, outcome, idempotentReplay };
    } catch (err) {
      // A 4xx that carries a decline body is a DECLINE (an expected outcome), not an error.
      if (err instanceof CheckoutError && err.isPaymentFailure()) {
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: method.id,
          idempotencyKey,
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapCheckoutResponseCode(err.body.response_code),
          attemptedAt: new Date().toISOString(),
        });
        return { attempt, outcome: 'failed', idempotentReplay: false };
      }
      throw err; // infra / auth / validation error — let the saga retry
    }
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    // Checkout.com auto-updates network tokens server-side (Account Updater), so a
    // retry through the stored source id already uses the freshest credential — there
    // is no separate "updated card" to fetch and apply.
    return null;
  }

  async listPaymentMethods(_customer: Customer): Promise<PaymentMethod[]> {
    // Checkout.com instruments are addressed per-id (`src_...`), not enumerable per
    // customer through a list endpoint on this integration, so we cannot enumerate a
    // customer's stored methods here (capability advertised as listPaymentMethods:false).
    return [];
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: Checkout.com is a gateway with no merchant-facing dunning engine, so
    // there is nothing to disable — AX10M owns the retry loop entirely.
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  private mapInvoice(data: NonNullable<CkoWebhookEnvelope['data']>, occurredAt: string, failed: boolean): Invoice {
    const ref = data.reference ?? data.id ?? '';
    return {
      id: `ax10m_inv_${ref}`,
      customerId: '',
      merchantId: this.config.merchantId,
      processorRef: ref,
      amount: { amount: CENTS(data.amount), currency: data.currency ?? 'USD' },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: occurredAt,
    };
  }

  private mapAttempt(
    data: NonNullable<CkoWebhookEnvelope['data']>,
    invoiceId: string,
    failed: boolean,
    occurredAt: string,
  ): ChargeAttempt {
    return this.buildAttempt({
      invoiceId,
      paymentMethodId: data.source?.id ? `ax10m_pm_${data.source.id}` : '',
      idempotencyKey: '',
      amount: { amount: CENTS(data.amount), currency: data.currency ?? 'USD' },
      status: failed ? 'failed' : 'succeeded',
      declineCode: failed ? mapCheckoutResponseCode(data.response_code) : undefined,
      txnId: data.id,
      attemptedAt: occurredAt,
    });
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
      attemptNumber: 1, // tracked by the recovery-case service, not the adapter
      attemptedAt: p.attemptedAt,
    };
  }

  private mapDecline(
    data: NonNullable<CkoWebhookEnvelope['data']>,
    invoiceId: string,
    chargeAttemptId: string,
    occurredAt: string,
  ): DeclineEvent {
    const code = mapCheckoutResponseCode(data.response_code);
    return {
      id: `ax10m_dec_${data.id ?? invoiceId}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason: data.response_summary ?? data.response_code,
      occurredAt,
    };
  }
}

/** Case-insensitive header lookup (webhook header casing varies). */
function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
