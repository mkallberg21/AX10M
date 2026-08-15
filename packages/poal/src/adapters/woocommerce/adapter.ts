/**
 * WooCommerce processor adapter — CO-DRIVE (WooCommerce Subscriptions, ecommerce platform).
 *
 * NOTE (co-drive): AX10M does NOT hold the card. `attemptCharge` TRIGGERS a renewal /
 * payment retry against the store; the store's configured gateway plugin (WooCommerce
 * Payments / Stripe / etc.) performs the ACTUAL charge. Endpoint paths and field names
 * are modeled on the documented WC REST v3 API + the WooCommerce Subscriptions
 * extension, and MUST be confirmed against the store's installed versions — the
 * MECHANISM (fail-closed HMAC verify, idempotency-key pass-through, pending-vs-failed,
 * token-only) is the deliverable.
 *
 * End-to-end against the WC REST API + signed webhooks:
 *  - ingestWebhook   — verify the X-WC-Webhook-Signature header (fail closed),
 *                      normalize order/subscription topics into canonical events.
 *  - listOpenFailures— reconciliation poll: GET /orders?status=failed, page cursor.
 *  - attemptCharge   — POST /orders/{ref}/retry-payment with X-Idempotency-Key. Core
 *                      WC REST has no clean "charge now", so this models the
 *                      Subscriptions renewal-retry action; the gateway charges through
 *                      the store, so a submitted retry with no terminal status resolves
 *                      to `pending` — the real outcome arrives later via webhook.
 *  - fetchUpdatedCard— null: the store owns the payment method vault.
 *  - listPaymentMethods — []: the store holds the stored methods; we never see them.
 *  - pauseNativeDunning — no-op: WooCommerce Subscriptions owns its retry schedule.
 *
 * Hard rules: we hold only WooCommerce ids / tokens, never a PAN (SAQ-A).
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
import { customerFromInvoice, contactOverrides } from '../../customer.js';
import type {
  CapabilityMatrix,
  ChargeResult,
  Cursor,
  OpenFailuresPage,
  ProcessorAdapter,
  RawWebhook,
} from '../../adapter.js';
import { WooClient, type FetchLike } from './client.js';
import { mapWooDeclineCode, verifyWooSignature } from './decline-map.js';

export interface WooCommerceAdapterConfig {
  /** Store base, e.g. https://shop.example.com. */
  storeUrl: string;
  /** REST API consumer key (Basic-auth username). Injected, never hardcoded. */
  consumerKey: string;
  /** REST API consumer secret (Basic-auth password). Injected, never hardcoded. */
  consumerSecret: string;
  /** Store webhook secret — the key WooCommerce signs its webhook HMAC with. */
  webhookSecret: string;
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Injectable transport for testing. */
  fetch?: FetchLike;
  /** Override base URL (tests / regions). */
  baseUrl?: string;
}

/** Shapes of the WooCommerce order/subscription JSON we read (only the fields we use). */
interface WooOrder {
  id?: number | string;
  status?: string; // pending | processing | completed | failed | ...
  currency?: string;
  total?: string; // MAJOR-unit decimal string, e.g. "149.00"
  customer_id?: number | string;
  subscription_id?: number | string;
  date_created_gmt?: string;
  date_modified_gmt?: string;
  /** Gateway failure signal on a failed renewal (plugin-dependent). */
  failure_code?: string;
  failure_message?: string;
  customer_note?: string;
  /** Billing contact block — feeds the dunning channels. modeled on WooCommerce order.billing — CONFIRM */
  billing?: {
    email?: string; // modeled on WooCommerce order.billing.email — CONFIRM
    phone?: string; // modeled on WooCommerce order.billing.phone — CONFIRM (often national, no country code)
  };
}

/** Response of the retry-payment action (fields plugin-dependent — confirm on install). */
interface WooRetryResult {
  status?: string; // processing | completed | failed | pending
  failure_code?: string;
  failure_message?: string;
  gateway_note?: string;
}

/**
 * Convert a WooCommerce MAJOR-unit decimal string (e.g. "149.00") to integer minor
 * units (14900). Rounds to the nearest cent to avoid float drift (assumes
 * 2-minor-digit currencies — the common case; zero/three-decimal currencies would
 * need a per-currency exponent).
 */
function toMinorUnits(major: string | undefined): number {
  if (!major) return 0;
  const n = Number(major);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Case-insensitive header lookup (proxies vary the casing of X-WC-* headers). */
function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function statusToOutcome(status: string | undefined): ChargeResult['outcome'] {
  switch (status) {
    case 'processing':
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      return 'pending'; // pending | on-hold | (unknown) — the store's gateway is still working
  }
}

export class WooCommerceAdapter implements ProcessorAdapter {
  readonly id = 'woocommerce';
  private readonly client: WooClient;

  constructor(private readonly config: WooCommerceAdapterConfig) {
    this.client = new WooClient({
      storeUrl: config.storeUrl,
      consumerKey: config.consumerKey,
      consumerSecret: config.consumerSecret,
      fetch: config.fetch,
      baseUrl: config.baseUrl,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      // co-drive: we trigger the renewal retry, the store's gateway performs the charge.
      integrationMode: 'co-drive',
      externalRetryControl: true, // we can trigger the renewal-retry action
      accountUpdater: false, // depends on the underlying gateway plugin; not exposed to us
      networkTokens: false, // held by the store's gateway; we never see the PAN
      partialCapture: false, // a renewal retry collects the order's due amount
      pauseNativeDunning: false, // WooCommerce Subscriptions owns its retry schedule
      webhooks: true,
      listPaymentMethods: false, // the store holds the stored methods
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    this.verifyWebhookSignature(raw);
    const topic = headerLookup(raw.headers, 'x-wc-webhook-topic') ?? '';
    let order: WooOrder;
    try {
      order = JSON.parse(raw.body);
    } catch {
      throw new Error('WooCommerceAdapter.ingestWebhook: body is not valid JSON');
    }

    const eventId = String(order.id ?? '');
    const occurredAt = order.date_modified_gmt ?? order.date_created_gmt ?? new Date(0).toISOString();
    const base = {
      id: `ax10m_evt_${topic}_${eventId}`,
      merchantId: this.config.merchantId,
      processorEventId: eventId,
      occurredAt,
    };

    switch (topic) {
      case 'order.updated':
      case 'order.created': {
        if (order.status === 'failed') {
          const invoice = this.mapOrder(order, occurredAt, /*failed*/ true);
          const rawReason = order.failure_message ?? order.failure_code ?? order.customer_note;
          const attempt = this.buildAttempt({
            invoiceId: invoice.id,
            paymentMethodId: '',
            idempotencyKey: '',
            amount: invoice.amount,
            status: 'failed',
            declineCode: mapWooDeclineCode(rawReason),
            txnId: eventId,
            attemptedAt: occurredAt,
          });
          const decline = this.buildDecline(rawReason, invoice.id, attempt.id, occurredAt, eventId);
          // Billing contact feeds the dunning channels. Woo phone is often national (no country
          // code) — pass as-is; contactOverrides/toE164 drops it if not E.164 (never fabricate a cc).
          const customer = customerFromInvoice(invoice, contactOverrides(order.billing?.email, order.billing?.phone));
          return [{ ...base, type: 'invoice.failed', payload: { invoice, attempt, decline, customer } }];
        }
        if (order.status === 'completed' || order.status === 'processing') {
          const invoice = this.mapOrder(order, occurredAt, false);
          const attempt = this.buildAttempt({
            invoiceId: invoice.id,
            paymentMethodId: '',
            idempotencyKey: '',
            amount: invoice.amount,
            status: 'succeeded',
            txnId: eventId,
            attemptedAt: occurredAt,
          });
          return [{ ...base, type: 'invoice.paid', payload: { invoice, attempt } }];
        }
        return []; // other order statuses (pending, on-hold, ...) — nothing to emit
      }
      case 'subscription.updated': {
        return [{
          ...base,
          type: 'subscription.updated',
          payload: {
            processorRef: String(order.subscription_id ?? order.id ?? ''),
            status: order.status ?? 'unknown',
          },
        }];
      }
      default:
        return []; // topic we don't act on
    }
  }

  /**
   * WooCommerce signs webhooks with `X-WC-Webhook-Signature` = base64 HMAC-SHA256 of
   * the RAW body keyed by the store's webhook secret. Fail CLOSED: refuse to process
   * when no secret is configured, rather than accepting a forged (unverified) payload.
   */
  private verifyWebhookSignature(raw: RawWebhook): void {
    if (!this.config.webhookSecret) {
      throw new Error('WooCommerceAdapter.ingestWebhook: webhookSecret not configured — refusing unverified webhook');
    }
    const signature = headerLookup(raw.headers, 'x-wc-webhook-signature');
    if (!verifyWooSignature(raw.body, signature, this.config.webhookSecret)) {
      throw new Error('WooCommerceAdapter.ingestWebhook: X-WC-Webhook-Signature verification failed');
    }
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(cursor: Cursor): Promise<OpenFailuresPage> {
    const page = cursor ? Number(cursor) : 1;
    const perPage = 100;
    const res = await this.client.get('/orders', { status: 'failed', per_page: perPage, page });
    const orders = Array.isArray(res) ? (res as WooOrder[]) : [];
    const invoices = orders.map((o) => this.mapOrder(o, o.date_modified_gmt ?? o.date_created_gmt ?? new Date(0).toISOString(), true));
    // A full page implies there may be another; WC pages by 1-based `page`. When the
    // page comes back short we've reached the end, so there is no next cursor.
    const nextCursor = orders.length === perPage ? String(page + 1) : null;
    return { invoices, nextCursor };
  }

  // ── co-drive: trigger a renewal retry ────────────────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    // Core WC REST has no "charge now"; we model the WooCommerce Subscriptions
    // renewal-retry action against the failed renewal order (invoice.processorRef).
    // The store's gateway plugin performs the ACTUAL charge — AX10M co-drives. The
    // idempotency key is passed as a header where the endpoint honors it.
    const res = (await this.client.post(
      `/orders/${encodeURIComponent(invoice.processorRef)}/retry-payment`,
      {},
      { 'X-Idempotency-Key': idempotencyKey },
    )) as WooRetryResult;

    const outcome = statusToOutcome(res.status);
    const rawReason = res.failure_message ?? res.gateway_note ?? res.failure_code;
    const attempt = this.buildAttempt({
      invoiceId: invoice.id,
      paymentMethodId: method.id,
      idempotencyKey,
      amount: invoice.amount,
      status: outcome,
      declineCode: outcome === 'failed' ? mapWooDeclineCode(rawReason) : undefined,
      txnId: invoice.processorRef,
      attemptedAt: new Date().toISOString(),
    });
    // A non-2xx from the store threw in the client (infra/auth/validation); reaching
    // here means the retry was accepted. 'pending' reflects the async gateway charge.
    return { attempt, outcome, idempotentReplay: false };
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    return null; // the store owns the payment method vault; no card is exposed to us
  }

  async listPaymentMethods(_customer: Customer): Promise<PaymentMethod[]> {
    return []; // the store holds the stored payment methods; we never see them (SAQ-A)
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: WooCommerce Subscriptions owns the automatic-retry schedule; there is no
    // AX10M-side toggle. We co-drive by triggering our own renewal retries.
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  private mapOrder(order: WooOrder, occurredAt: string, failed: boolean): Invoice {
    const currency = order.currency ?? 'USD';
    const amount = toMinorUnits(order.total);
    return {
      id: `ax10m_inv_${String(order.id ?? '')}`,
      subscriptionId: order.subscription_id ? `ax10m_sub_${order.subscription_id}` : undefined,
      customerId: order.customer_id ? `ax10m_cus_${order.customer_id}` : '',
      merchantId: this.config.merchantId,
      processorRef: String(order.id ?? ''),
      amount: { amount, currency },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: order.date_created_gmt ?? occurredAt,
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
      attemptNumber: 1, // attempt count is tracked by the recovery-case service, not the adapter
      attemptedAt: p.attemptedAt,
    };
  }

  private buildDecline(rawReason: string | undefined, invoiceId: string, chargeAttemptId: string, occurredAt: string, eventId: string): DeclineEvent {
    const code = mapWooDeclineCode(rawReason);
    return {
      id: `ax10m_dec_${eventId}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason,
      occurredAt,
    };
  }
}
