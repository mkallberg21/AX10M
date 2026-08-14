/**
 * SamCart adapter (skeleton) — ADVISORY (measurement + attribution only).
 *
 * NOTE: SamCart owns the checkout, the stored payment token, and the retry/dunning loop;
 * it charges via Stripe / PayPal UNDER THE HOOD. AX10M CANNOT drive a charge here. This
 * adapter is a MEASUREMENT + advisory layer: verify + normalize SamCart webhook events
 * into canonical events so AX10M can run the holdout on the *comms it controls* and
 * quantify involuntary churn. `attemptCharge` and `pauseNativeDunning` intentionally throw
 * (inherited from BaseAdapter).
 *
 * The webhook field/event names below are modeled on SamCart's documented payloads and
 * MUST be confirmed against a live payload (the signature may be delivered hex- OR
 * base64-encoded, so we accept either). The MECHANISM (fail-closed HMAC verification +
 * canonical normalization for the holdout) is the deliverable.
 *
 * Strategic note: because SamCart settles on Stripe/PayPal, AX10M's real *drive* path is
 * that underlying processor's adapter; this adapter wins on attribution/measurement of
 * involuntary churn. PROCESSORS.md §3.
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

export interface SamCartAdapterConfig {
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Shared secret configured on the SamCart webhook; HMAC-SHA256 key. Injected, never hardcoded. */
  webhookSecret: string;
  /** Header carrying the HMAC signature (hex or base64). Defaults to `x-samcart-signature`. */
  signatureHeader?: string;
}

/** Shape of the SamCart webhook payload we read (only the fields we use). */
interface SamCartWebhook {
  id?: string;
  type?: string;
  event?: string;
  created_at?: number | string;
  order?: {
    id?: string | number;
    /** Major-unit decimal amount (advisory — confirm against live payload). */
    total?: string | number;
    amount?: string | number;
    currency?: string;
    status?: string;
    decline_reason?: string;
    failure_reason?: string;
  };
  customer?: { id?: string | number; email?: string };
  subscription?: { id?: string | number; status?: string };
}

export class SamCartAdapter extends BaseAdapter {
  readonly id = 'samcart';
  constructor(private readonly config: SamCartAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'advisory',
      externalRetryControl: false, // SamCart (over Stripe/PayPal) owns the retry loop
      accountUpdater: false, // not exposed to AX10M
      networkTokens: false, // not exposed to AX10M
      partialCapture: false,
      pauseNativeDunning: false, // cannot disable SamCart's dunning
      webhooks: true, // measurement only
      listPaymentMethods: false,
    };
  }

  override async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    verifySamCartSignature(
      this.config.webhookSecret,
      raw.body,
      headerLookup(raw.headers, this.config.signatureHeader ?? 'x-samcart-signature'),
    );

    let event: SamCartWebhook;
    try {
      event = JSON.parse(raw.body) as SamCartWebhook;
    } catch {
      throw new Error('SamCartAdapter.ingestWebhook: body is not valid JSON');
    }

    const type = event.type ?? event.event ?? '';
    const order = event.order ?? {};
    const ref = String(order.id ?? '');
    const occurredAt = toIso(event.created_at);
    const eventId = event.id ?? `${type}:${ref}`;

    const envelope = <T>(canonType: CanonicalEvent['type'], payload: T): CanonicalEvent<T> => ({
      id: `ax10m_evt_${eventId}`,
      type: canonType,
      merchantId: this.config.merchantId,
      processorEventId: eventId,
      occurredAt,
      payload,
    });

    switch (type) {
      case 'Subscription_Payment_Failed': {
        const invoice = this.buildInvoice(event, ref, occurredAt, /*failed*/ true);
        const reason = order.decline_reason ?? order.failure_reason;
        const decline = reason ? buildDecline(invoice.id, ref, reason, occurredAt) : undefined;
        return [envelope('invoice.failed', decline ? { invoice, decline } : { invoice })];
      }
      case 'Order_Completed':
      case 'Subscription_Charge': {
        return [envelope('invoice.paid', { invoice: this.buildInvoice(event, ref, occurredAt, /*failed*/ false) })];
      }
      case 'Subscription_Cancelled':
      case 'Order_Refunded': {
        // Cancellation and refund are both involuntary/voluntary churn signals.
        return [envelope('subscription.updated', {
          processorRef: String(event.subscription?.id ?? ref),
          status: event.subscription?.status ?? (type === 'Order_Refunded' ? 'refunded' : 'canceled'),
        })];
      }
      default:
        return []; // event we don't act on
    }
  }

  private buildInvoice(event: SamCartWebhook, ref: string, occurredAt: string, failed: boolean): Invoice {
    const order = event.order ?? {};
    const currency = order.currency ?? 'USD';
    // SamCart reports amounts as major-unit decimals; convert to integer minor units,
    // rounding to the nearest cent.
    const amount = toMinorUnits(order.total ?? order.amount);
    const custKey = customerKey(event.customer?.id, event.customer?.email);
    return {
      id: `ax10m_inv_${ref}`,
      subscriptionId: event.subscription?.id ? `ax10m_sub_${String(event.subscription.id)}` : undefined,
      customerId: custKey ? `ax10m_cus_${custKey}` : '',
      merchantId: this.config.merchantId,
      processorRef: ref,
      amount: { amount, currency: currency.toUpperCase() },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: occurredAt,
    };
  }
}

/**
 * Verify a SamCart webhook's HMAC-SHA256 signature. FAILS CLOSED: throws when the shared
 * secret is not configured (refuse unverified) or the signature matches neither the hex
 * nor the base64 encoding of the expected HMAC.
 */
export function verifySamCartSignature(
  secret: string | undefined,
  rawBody: string,
  provided: string | undefined,
): void {
  if (!secret) {
    throw new Error('SamCartAdapter.ingestWebhook: webhookSecret not configured — refusing unverified webhook');
  }
  // Hmac.digest() is single-shot and Hmac has no copy(); compute each encoding separately.
  const expectedHex = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const expectedB64 = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  if (!constantTimeEquals(provided, expectedHex) && !constantTimeEquals(provided, expectedB64)) {
    throw new Error('SamCartAdapter.ingestWebhook: webhook signature verification failed');
  }
}

/** Map a raw gateway/decline reason string onto a canonical decline code (keyword-based). */
export function mapSamCartDeclineReason(raw: string | null | undefined): DeclineCode {
  return mapDeclineReason(raw);
}

// ── file-local helpers (advisory adapters keep these local; no shared edits) ──

function constantTimeEquals(provided: string | undefined, expected: string): boolean {
  const a = Buffer.from(provided ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

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

function toMinorUnits(value: string | number | undefined): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

function customerKey(id: string | number | undefined, email: string | undefined): string {
  if (id !== undefined && id !== null && String(id) !== '') return String(id);
  if (email) return `email_${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
  return '';
}

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

function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
