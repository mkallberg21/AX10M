/**
 * Kajabi adapter (skeleton) — ADVISORY (measurement + attribution only).
 *
 * NOTE: Kajabi owns the buyer relationship, the stored payment token, and the
 * retry/dunning loop; it charges via Stripe / PayPal UNDER THE HOOD. AX10M CANNOT
 * drive a charge here. This adapter is a MEASUREMENT + advisory layer: verify +
 * normalize Kajabi webhook events (payment.failed / payment.succeeded /
 * subscription.cancelled) into canonical events so AX10M can run the holdout on the
 * *comms it controls* and quantify involuntary churn. `attemptCharge` and
 * `pauseNativeDunning` intentionally throw (inherited from BaseAdapter).
 *
 * The webhook field names below are modeled on Kajabi's documented event payloads and
 * MUST be confirmed against a live payload. The MECHANISM (fail-closed HMAC verification
 * + canonical normalization for the holdout) is the deliverable.
 *
 * Strategic note: because Kajabi settles on Stripe/PayPal, AX10M's real *drive* path is
 * that underlying processor's adapter; this Kajabi adapter wins on attribution/measurement
 * of the involuntary churn Kajabi's own dunning leaves on the table. PROCESSORS.md §3.
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

export interface KajabiAdapterConfig {
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Shared secret configured on the Kajabi webhook; HMAC-SHA256 key. Injected, never hardcoded. */
  webhookSecret: string;
  /** Header carrying the hex HMAC signature. Defaults to `kajabi-signature`. */
  signatureHeader?: string;
}

/** Shape of the Kajabi event payload we read (only the fields we use). */
interface KajabiWebhook {
  id?: string;
  event?: string;
  created_at?: number | string;
  data?: {
    id?: string | number;
    /** Major-unit decimal amount (advisory — confirm against live payload). */
    amount?: string | number;
    currency?: string;
    offer_id?: string | number;
    subscription_id?: string | number;
    member?: { id?: string | number; email?: string };
    customer?: { id?: string | number; email?: string };
    failure_reason?: string;
    decline_code?: string;
    status?: string;
  };
}

export class KajabiAdapter extends BaseAdapter {
  readonly id = 'kajabi';
  constructor(private readonly config: KajabiAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'advisory',
      externalRetryControl: false, // Kajabi (over Stripe/PayPal) owns the retry loop
      accountUpdater: false, // not exposed to AX10M
      networkTokens: false, // not exposed to AX10M
      partialCapture: false,
      pauseNativeDunning: false, // cannot disable Kajabi's dunning
      webhooks: true, // measurement only
      listPaymentMethods: false,
    };
  }

  override async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    verifyKajabiSignature(
      this.config.webhookSecret,
      raw.body,
      headerLookup(raw.headers, this.config.signatureHeader ?? 'kajabi-signature'),
    );

    let event: KajabiWebhook;
    try {
      event = JSON.parse(raw.body) as KajabiWebhook;
    } catch {
      throw new Error('KajabiAdapter.ingestWebhook: body is not valid JSON');
    }

    const data = event.data ?? {};
    const ref = String(data.id ?? '');
    const occurredAt = toIso(event.created_at);
    const eventId = event.id ?? `${event.event ?? 'event'}:${ref}`;

    const envelope = <T>(type: CanonicalEvent['type'], payload: T): CanonicalEvent<T> => ({
      id: `ax10m_evt_${eventId}`,
      type,
      merchantId: this.config.merchantId,
      processorEventId: eventId,
      occurredAt,
      payload,
    });

    switch (event.event) {
      case 'payment.failed': {
        const invoice = this.buildInvoice(ref, data, occurredAt, /*failed*/ true);
        const reason = data.decline_code ?? data.failure_reason;
        const decline = reason ? buildDecline(invoice.id, ref, reason, occurredAt) : undefined;
        return [envelope('invoice.failed', decline ? { invoice, decline } : { invoice })];
      }
      case 'payment.succeeded': {
        const invoice = this.buildInvoice(ref, data, occurredAt, /*failed*/ false);
        return [envelope('invoice.paid', { invoice })];
      }
      case 'subscription.cancelled':
      case 'subscription.canceled': {
        return [envelope('subscription.updated', {
          processorRef: String(data.subscription_id ?? ref),
          status: data.status ?? 'canceled',
        })];
      }
      default:
        return []; // event we don't act on
    }
  }

  private buildInvoice(
    ref: string,
    data: NonNullable<KajabiWebhook['data']>,
    occurredAt: string,
    failed: boolean,
  ): Invoice {
    const currency = data.currency ?? 'USD';
    // Kajabi reports amounts as major-unit decimals; convert to integer minor units,
    // rounding to the nearest cent.
    const amount = toMinorUnits(data.amount);
    const buyer = data.member ?? data.customer ?? {};
    const custKey = customerKey(buyer.id, buyer.email);
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

/**
 * Verify a Kajabi webhook's HMAC-SHA256 signature. FAILS CLOSED: throws when the shared
 * secret is not configured (refuse unverified) or the signature does not match.
 */
export function verifyKajabiSignature(
  secret: string | undefined,
  rawBody: string,
  provided: string | undefined,
): void {
  if (!secret) {
    throw new Error('KajabiAdapter.ingestWebhook: webhookSecret not configured — refusing unverified webhook');
  }
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(provided ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('KajabiAdapter.ingestWebhook: webhook signature verification failed');
  }
}

/** Map a raw gateway/decline reason string onto a canonical decline code (keyword-based). */
export function mapKajabiDeclineReason(raw: string | null | undefined): DeclineCode {
  return mapDeclineReason(raw);
}

// ── file-local helpers (advisory adapters keep these local; no shared edits) ──

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
