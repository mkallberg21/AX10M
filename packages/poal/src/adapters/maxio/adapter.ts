/**
 * Maxio / Chargify (Advanced Billing) processor adapter — DRIVE
 * (PROCESSORS.md §3, ARCHITECTURE.md §4.1).
 *
 * NOTE: the endpoint paths and JSON field names below are modeled on Chargify's
 * documented API and MUST be re-confirmed against the live API version — treat them as
 * the plausible shape, not gospel. The load-bearing MECHANISM is real and is the
 * deliverable: a deterministic `Idempotency-Key`, fail-closed HMAC webhook
 * verification, token-only (never a PAN → SAQ-A), and the decline-vs-error split — a
 * 422 payment rejection is an expected OUTCOME, an infra/auth failure THROWS.
 *
 * DRIVE: on Maxio we re-attempt the subscription's outstanding balance ourselves via
 * the `retry` endpoint against the stored payment profile.
 *
 * End-to-end against Chargify:
 *  - ingestWebhook   — verify X-Chargify-Webhook-Signature-Hmac-Sha256 (FAIL CLOSED),
 *                      normalize payment_failure/payment_success + subscription-state
 *                      webhooks (urlencoded OR JSON bodies).
 *  - listOpenFailures— reconciliation poll over subscriptions in `past_due`.
 *  - attemptCharge   — POST /subscriptions/{id}/retry.json (retries the current dunning
 *                      balance through the stored payment method — token, not a PAN).
 *  - fetchUpdatedCard— null (Chargify auto-updates stored cards server-side).
 *  - listPaymentMethods — not enumerated here (capability false).
 *  - pauseNativeDunning — no-op (Maxio dunning is config-level).
 *
 * Hard rule: we hold only Chargify tokens / ids, never a PAN.
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
import { MaxioClient, MaxioError, type FetchLike } from './client.js';
import { mapMaxioDeclineCode, parseMaxioWebhook, verifyMaxioSignature } from './decline-map.js';

export interface MaxioAdapterConfig {
  /** Chargify API key (Basic-auth username, password `x`). Injected, never hardcoded. */
  apiKey: string;
  /** Chargify subdomain: <subdomain>.chargify.com. */
  subdomain: string;
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Shared webhook key Chargify signs webhooks with (HMAC-SHA256). */
  webhookSecret?: string;
  /** Injectable transport for testing. */
  fetch?: FetchLike;
  /** Override base URL (tests / regions). Defaults to https://{subdomain}.chargify.com. */
  baseUrl?: string;
}

const PER_PAGE = 100;

const CENTS = (n: unknown): number => (typeof n === 'number' ? n : typeof n === 'string' && n !== '' ? Number(n) || 0 : 0);
const asString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

function toIso(value: unknown): string {
  const s = asString(value);
  if (!s) return new Date(0).toISOString();
  const t = Date.parse(s);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Case-insensitive header lookup (proxies vary the casing of the signature header). */
function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Shape of the Chargify subscription JSON we read (only the fields we use). */
interface ChSubscription {
  id?: number | string;
  state?: string;
  currency?: string;
  balance_in_cents?: number;
  total_amount_in_cents?: number;
  current_period_ends_at?: string;
  created_at?: string;
  updated_at?: string;
  customer?: { id?: number | string; email?: string };
}

export class MaxioAdapter implements ProcessorAdapter {
  readonly id = 'maxio';
  private readonly client: MaxioClient;

  constructor(private readonly config: MaxioAdapterConfig) {
    this.client = new MaxioClient({
      apiKey: config.apiKey,
      subdomain: config.subdomain,
      fetch: config.fetch,
      baseUrl: config.baseUrl,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive',
      externalRetryControl: true,
      accountUpdater: true, // Chargify auto-updates stored cards server-side
      networkTokens: false,
      partialCapture: true, // a one-off charge can apply a partial/negotiated amount
      pauseNativeDunning: false, // Maxio dunning is config-level, not an API toggle
      webhooks: true,
      listPaymentMethods: false,
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    // Fail CLOSED: without a configured shared key we cannot verify the signature, so
    // we refuse rather than trust an unverified payload.
    if (!this.config.webhookSecret) {
      throw new Error('MaxioAdapter.ingestWebhook: webhookSecret not configured — refusing unverified webhook');
    }
    const signature = headerLookup(raw.headers, 'x-chargify-webhook-signature-hmac-sha256');
    if (!verifyMaxioSignature(raw.body, signature, this.config.webhookSecret)) {
      throw new Error('MaxioAdapter.ingestWebhook: X-Chargify-Webhook-Signature-Hmac-Sha256 verification failed');
    }
    const parsed = parseMaxioWebhook(raw.body);
    if (!parsed) return [];

    const payload = parsed.payload;
    const subscription = (payload.subscription ?? {}) as ChSubscription;
    const transaction = (payload.transaction ?? {}) as Record<string, unknown>;
    const eventId = headerLookup(raw.headers, 'x-chargify-webhook-id') ?? asString(transaction.id) ?? asString(subscription.id) ?? parsed.event;
    const occurredAt = toIso(transaction.created_at ?? subscription.updated_at);

    const envelope = <T>(type: CanonicalEvent['type'], p: T): CanonicalEvent<T> => ({
      id: `ax10m_evt_${eventId}`,
      type,
      merchantId: this.config.merchantId,
      processorEventId: eventId,
      occurredAt,
      payload: p,
    });

    switch (parsed.event) {
      case 'payment_failure': {
        const invoice = this.mapSubscriptionInvoice(subscription, occurredAt, /*failed*/ true, CENTS(transaction.amount_in_cents));
        const rawReason = asString(transaction.memo) ?? asString(payload.message);
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: '',
          idempotencyKey: '',
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapMaxioDeclineCode(rawReason),
          txnId: asString(transaction.id),
          attemptedAt: occurredAt,
        });
        const decline = this.buildDecline(rawReason, asString(transaction.id) ?? invoice.processorRef, invoice.id, attempt.id, occurredAt);
        return [envelope('invoice.failed', { invoice, attempt, decline })];
      }
      case 'payment_success':
      case 'renewal_success': {
        const invoice = this.mapSubscriptionInvoice(subscription, occurredAt, false, CENTS(transaction.amount_in_cents));
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: '',
          idempotencyKey: '',
          amount: invoice.amount,
          status: 'succeeded',
          txnId: asString(transaction.id),
          attemptedAt: occurredAt,
        });
        return [envelope('invoice.paid', { invoice, attempt })];
      }
      case 'subscription_state_change':
      case 'subscription_canceled': {
        const subId = asString(subscription.id);
        if (!subId) return [];
        return [envelope('subscription.updated', { processorRef: subId, status: asString(subscription.state) ?? 'unknown' })];
      }
      default:
        return []; // webhook we don't act on
    }
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(cursor: Cursor): Promise<OpenFailuresPage> {
    const page = cursor ? Number(cursor) || 1 : 1;
    const res = await this.client.get('/subscriptions.json', { state: 'past_due', page, per_page: PER_PAGE });
    // Chargify returns a top-level ARRAY of `{ subscription }` rows; some proxies wrap
    // it as `{ subscriptions: [...] }`. Accept both.
    const rows: Array<{ subscription?: ChSubscription }> = Array.isArray(res)
      ? (res as unknown as Array<{ subscription?: ChSubscription }>)
      : Array.isArray((res as { subscriptions?: unknown }).subscriptions)
        ? ((res as { subscriptions: Array<{ subscription?: ChSubscription }> }).subscriptions)
        : [];
    const subs = rows
      .map((row) => row.subscription)
      .filter((s): s is ChSubscription => Boolean(s));
    const invoices = subs.map((s) => this.mapSubscriptionInvoice(s, toIso(s.updated_at ?? s.created_at), true, s.balance_in_cents ?? s.total_amount_in_cents ?? 0));
    // Cursor: advance to the next page only while a full page comes back.
    const nextCursor: Cursor = subs.length === PER_PAGE ? String(page + 1) : null;
    return { invoices, nextCursor };
  }

  // ── drive: charge ────────────────────────────────────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    // retry.json retries the subscription's current dunning balance through the stored
    // payment profile. The retry target is a SUBSCRIPTION id — prefer the canonical
    // subscriptionId, falling back to the invoice processorRef.
    const subRef = invoice.subscriptionId ? stripPrefix(invoice.subscriptionId, 'ax10m_sub_') : invoice.processorRef;
    try {
      const { body } = await this.client.post(`/subscriptions/${encodeURIComponent(subRef)}/retry.json`, {}, idempotencyKey);
      const sub = (body.subscription as ChSubscription | undefined) ?? {};
      const outcome: ChargeResult['outcome'] = sub.state === 'active' ? 'succeeded' : 'pending';
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: outcome,
        txnId: asString(sub.id) ?? subRef,
        attemptedAt: new Date().toISOString(),
      });
      return { attempt, outcome, idempotentReplay: false };
    } catch (err) {
      // A 422 payment error is a DECLINE (an expected outcome), not an error.
      if (err instanceof MaxioError && err.isPaymentFailure()) {
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: method.id,
          idempotencyKey,
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapMaxioDeclineCode(err.declineReason()),
          txnId: subRef,
          attemptedAt: new Date().toISOString(),
        });
        return { attempt, outcome: 'failed', idempotentReplay: false };
      }
      throw err; // infra / auth / validation error — let the saga retry
    }
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    // Chargify updates the stored card server-side (gateway Account Updater), so a
    // retry through the stored profile already uses the freshest card — nothing to
    // fetch and apply here.
    return null;
  }

  async listPaymentMethods(_customer: Customer): Promise<PaymentMethod[]> {
    // Not enumerated on this integration (capability listPaymentMethods=false). Chargify
    // exposes payment profiles per subscription; wire GET /subscriptions/{id}/
    // payment_profiles if the capability is promoted. [] keeps the contract honest.
    return [];
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: Maxio dunning is CONFIG-level (Dunning strategies configured per site /
    // product), not a per-subscription API toggle. In Phase 0 shadow mode we leave it
    // ON as the measured baseline (capability pauseNativeDunning=false).
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  /**
   * Model a Chargify subscription (past_due or a webhook payload) as a canonical
   * Invoice. Maxio dunning operates at the SUBSCRIPTION level, so the retry target is
   * the subscription id — we set `processorRef` to it so attemptCharge can round-trip.
   * ASSUMPTION: the outstanding amount comes from balance_in_cents / total_amount_in_cents
   * (or the failing transaction's amount) — confirm the field against the live API.
   */
  private mapSubscriptionInvoice(sub: ChSubscription, occurredAt: string, failed: boolean, amountInCents: number): Invoice {
    const subId = asString(sub.id) ?? '';
    const customerId = asString(sub.customer?.id);
    return {
      id: `ax10m_inv_${subId}`,
      subscriptionId: subId ? `ax10m_sub_${subId}` : undefined,
      customerId: customerId ? `ax10m_cus_${customerId}` : '',
      merchantId: this.config.merchantId,
      processorRef: subId,
      amount: { amount: amountInCents, currency: sub.currency ?? 'USD' },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: toIso(sub.created_at),
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

  private buildDecline(rawReason: string | undefined, txnId: string, invoiceId: string, chargeAttemptId: string, occurredAt: string): DeclineEvent {
    const code = mapMaxioDeclineCode(rawReason);
    return {
      id: `ax10m_dec_${txnId}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason,
      occurredAt,
    };
  }
}
