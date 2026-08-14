/**
 * BigCommerce adapter (skeleton) — ADVISORY (measurement + attribution only).
 *
 * NOTE: BigCommerce owns the storefront, the checkout, and — where recurring billing
 * exists — the payment token and dunning loop (typically via a subscription app that
 * itself runs on Stripe / PayPal / Braintree under the hood). AX10M CANNOT drive a
 * charge here. This adapter exists as a MEASUREMENT + advisory layer: verify + normalize
 * BigCommerce order/subscription webhooks into canonical events so AX10M can run the
 * holdout on the *comms it controls* and quantify involuntary churn. `attemptCharge`
 * and `pauseNativeDunning` intentionally throw (inherited from BaseAdapter).
 *
 * The webhook field names below are modeled on BigCommerce's documented store webhook
 * envelope (`scope` / `store_id` / `data` / `hash`) and MUST be confirmed against a live
 * store payload — BigCommerce's `store/order/statusUpdated` webhook carries thin data
 * (order id + status ids), so amount/status *names* are enriched here from fields that a
 * real integration would resolve via the Orders API or a subscription app's payload. The
 * MECHANISM (fail-closed HMAC verification + canonical normalization for the holdout) is
 * the deliverable, not the exact field list.
 *
 * Strategic note: BigCommerce core is storefront/orders and does NOT natively own recurring
 * billing — most recovery signal arrives via a subscription app. Because that app settles on
 * an underlying processor (Stripe/PayPal/Braintree), AX10M's real *drive* path is that
 * processor's adapter; this adapter wins on attribution/measurement. PROCESSORS.md §3.
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import {
  DeclineCode,
  familyOf,
  type CanonicalEvent,
  type DeclineEvent,
  type Invoice,
} from '@ax10m/canonical';
import type { CapabilityMatrix, RawWebhook } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface BigCommerceAdapterConfig {
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Shared secret configured on the BigCommerce webhook; HMAC-SHA256 key. Injected, never hardcoded. */
  webhookSecret: string;
  /** BigCommerce store hash (`stores/<hash>`), for reference / future API reconciliation. */
  storeHash?: string;
  /** Store API access token, for future Orders-API enrichment (not used in advisory mode). */
  accessToken?: string;
  /** Header carrying the hex HMAC signature. Defaults to `x-bc-signature`. */
  signatureHeader?: string;
}

/** Shape of the BigCommerce webhook envelope we read (only the fields we use). */
interface BcWebhook {
  scope?: string;
  store_id?: string | number;
  producer?: string;
  hash?: string;
  created_at?: number | string;
  data?: {
    type?: string;
    id?: string | number;
    order_id?: string | number;
    /** Human status name (enriched; advisory — confirm against live payload). */
    status?: string;
    new_status?: string;
    customer_id?: string | number;
    email?: string;
    currency_code?: string;
    /** Major-unit decimal order total (advisory — confirm against live payload). */
    total?: string | number;
    total_inc_tax?: string | number;
    subscription_id?: string | number;
    /** Gateway decline reason, when a subscription app forwards one. */
    decline_reason?: string;
    payment_error?: string;
  };
}

export class BigCommerceAdapter extends BaseAdapter {
  readonly id = 'bigcommerce';
  constructor(private readonly config: BigCommerceAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'advisory',
      externalRetryControl: false, // subscription app / underlying processor owns the retry loop
      accountUpdater: false, // not exposed to AX10M
      networkTokens: false, // not exposed to AX10M
      partialCapture: false,
      pauseNativeDunning: false, // cannot disable the app's / processor's dunning
      webhooks: true, // measurement only
      listPaymentMethods: false,
    };
  }

  override async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    verifyBigCommerceSignature(
      this.config.webhookSecret,
      raw.body,
      headerLookup(raw.headers, this.config.signatureHeader ?? 'x-bc-signature'),
    );

    let event: BcWebhook;
    try {
      event = JSON.parse(raw.body) as BcWebhook;
    } catch {
      throw new Error('BigCommerceAdapter.ingestWebhook: body is not valid JSON');
    }

    const data = event.data ?? {};
    const scope = event.scope ?? '';
    const ref = String(data.order_id ?? data.id ?? '');
    const occurredAt = toIso(event.created_at);
    const eventId = event.hash ?? `${scope}:${ref}:${String(event.created_at ?? '')}`;

    const envelope = <T>(type: CanonicalEvent['type'], payload: T): CanonicalEvent<T> => ({
      id: `ax10m_evt_${eventId}`,
      type,
      merchantId: this.config.merchantId,
      processorEventId: eventId,
      occurredAt,
      payload,
    });

    // Subscription lifecycle (churn signal) — cancellation/refund.
    if (scope.startsWith('store/subscription')) {
      return [envelope('subscription.updated', {
        processorRef: String(data.subscription_id ?? data.id ?? ref),
        status: data.status ?? data.new_status ?? 'unknown',
      })];
    }

    // Order status transitions.
    if (scope === 'store/order/statusUpdated' || scope.startsWith('store/order')) {
      const status = (data.status ?? data.new_status ?? '').toLowerCase();
      const kind = classifyOrderStatus(status);
      if (kind === 'failed') {
        const invoice = this.buildInvoice(ref, data, occurredAt, /*failed*/ true);
        const reason = data.decline_reason ?? data.payment_error;
        const decline = reason ? buildDecline(invoice.id, ref, reason, occurredAt) : undefined;
        return [envelope('invoice.failed', decline ? { invoice, decline } : { invoice })];
      }
      if (kind === 'paid') {
        const invoice = this.buildInvoice(ref, data, occurredAt, /*failed*/ false);
        return [envelope('invoice.paid', { invoice })];
      }
      if (kind === 'churn') {
        return [envelope('subscription.updated', {
          processorRef: String(data.subscription_id ?? ref),
          status: status || 'canceled',
        })];
      }
    }

    return []; // event we don't act on
  }

  private buildInvoice(
    ref: string,
    data: NonNullable<BcWebhook['data']>,
    occurredAt: string,
    failed: boolean,
  ): Invoice {
    const currency = data.currency_code ?? 'USD';
    // BigCommerce reports order totals as major-unit decimals ("149.00"); convert to
    // integer minor units, rounding to the nearest cent.
    const amount = toMinorUnits(data.total_inc_tax ?? data.total);
    const custKey = customerKey(data.customer_id, data.email);
    return {
      id: `ax10m_inv_${ref}`,
      subscriptionId: data.subscription_id ? `ax10m_sub_${String(data.subscription_id)}` : undefined,
      customerId: custKey ? `ax10m_cus_${custKey}` : '',
      merchantId: this.config.merchantId,
      processorRef: ref,
      amount: { amount, currency },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: occurredAt,
    };
  }
}

/** BigCommerce order-status name → the canonical event kind it implies. */
function classifyOrderStatus(status: string): 'failed' | 'paid' | 'churn' | 'ignore' {
  if (!status) return 'ignore';
  if (status.includes('declined') || status.includes('payment review') || status.includes('failed')) return 'failed';
  if (status.includes('refunded') || status.includes('cancel')) return 'churn';
  if (
    status.includes('completed') ||
    status.includes('paid') ||
    status.includes('awaiting fulfillment') ||
    status.includes('shipped')
  ) {
    return 'paid';
  }
  return 'ignore';
}

/**
 * Verify a BigCommerce webhook's HMAC-SHA256 signature. FAILS CLOSED: throws when the
 * shared secret is not configured (refuse unverified) or the signature does not match.
 */
export function verifyBigCommerceSignature(
  secret: string | undefined,
  rawBody: string,
  provided: string | undefined,
): void {
  if (!secret) {
    throw new Error('BigCommerceAdapter.ingestWebhook: webhookSecret not configured — refusing unverified webhook');
  }
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(provided ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('BigCommerceAdapter.ingestWebhook: webhook signature verification failed');
  }
}

/** Map a raw gateway/decline reason string onto a canonical decline code (keyword-based). */
export function mapBigCommerceDeclineReason(raw: string | null | undefined): DeclineCode {
  return mapDeclineReason(raw);
}

// ── shared local helpers (advisory adapters keep these file-local; no shared edits) ──

function buildDecline(invoiceId: string, ref: string, rawReason: string, occurredAt: string): DeclineEvent {
  const code = mapDeclineReason(rawReason);
  return {
    id: `ax10m_dec_${ref}`,
    invoiceId,
    chargeAttemptId: '', // advisory: AX10M did not drive this attempt
    code,
    family: familyOf(code),
    rawReason,
    occurredAt,
  };
}

function mapDeclineReason(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  const s = raw.toLowerCase();
  if (s.includes('insufficient')) return DeclineCode.InsufficientFunds;
  if (s.includes('expired')) return DeclineCode.ExpiredCard;
  if (s.includes('lost')) return DeclineCode.LostCard;
  if (s.includes('stolen')) return DeclineCode.StolenCard;
  if (s.includes('closed')) return DeclineCode.ClosedAccount;
  if (s.includes('pickup') || s.includes('pick up')) return DeclineCode.PickupCard;
  if (s.includes('not support') || s.includes('unsupported')) return DeclineCode.CardNotSupported;
  if (s.includes('revok') || s.includes('revoc')) return DeclineCode.RevocationOfAuthorization;
  if (s.includes('fraud')) return DeclineCode.Fraudulent;
  if (s.includes('authentication') || s.includes('3d')) return DeclineCode.AuthenticationRequired;
  if (s.includes('velocity') || s.includes('limit')) return DeclineCode.VelocityLimitExceeded;
  if (s.includes('unavailable') || s.includes('unreachable') || s.includes('issuer')) return DeclineCode.IssuerUnavailable;
  if (s.includes('try again') || s.includes('retry')) return DeclineCode.TryAgainLater;
  if (s.includes('processing')) return DeclineCode.ProcessingError;
  if (s.includes('invalid')) return DeclineCode.InvalidCard;
  if (s.includes('do not honor') || s.includes('do_not_honor') || s.includes('declined') || s.includes('decline')) {
    return DeclineCode.DoNotHonor;
  }
  return DeclineCode.Unknown;
}

/** Convert a major-unit decimal amount to integer minor units, rounding to the nearest cent. */
function toMinorUnits(value: string | number | undefined): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

/**
 * Derive a stable customer key from the buyer id (preferred) or a SHA-256 hash of the
 * lowercased email (so we never place raw PII in a canonical id). Empty when neither exists.
 */
function customerKey(id: string | number | undefined, email: string | undefined): string {
  if (id !== undefined && id !== null && String(id) !== '') return String(id);
  if (email) return `email_${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
  return '';
}

/** Accept an ISO string or epoch (seconds or ms) and return an ISO-8601 timestamp. */
function toIso(v: string | number | undefined): string {
  if (typeof v === 'number') {
    const ms = v < 1e12 ? v * 1000 : v; // heuristic: <1e12 is seconds
    return new Date(ms).toISOString();
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/** Case-insensitive header lookup (webhook header casing varies). */
function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
