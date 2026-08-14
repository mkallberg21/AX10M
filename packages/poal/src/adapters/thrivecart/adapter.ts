/**
 * ThriveCart adapter (skeleton) — ADVISORY (measurement + attribution only).
 *
 * NOTE: ThriveCart owns the cart, the stored payment token, and the retry/dunning loop;
 * it settles via Stripe / PayPal / Authorize.Net UNDER THE HOOD. AX10M CANNOT drive a
 * charge here. This adapter is a MEASUREMENT + advisory layer: verify + normalize
 * ThriveCart order webhooks into canonical events so AX10M can run the holdout on the
 * *comms it controls* and quantify involuntary churn. `attemptCharge` and
 * `pauseNativeDunning` intentionally throw (inherited from BaseAdapter).
 *
 * ThriveCart authenticates webhooks with a SHARED SECRET carried in the body field
 * `thrivecart_secret` (it also posts `application/x-www-form-urlencoded`, not just JSON).
 * We fail CLOSED: the provided secret (from the body field or a header) must equal the
 * configured secret via a constant-time compare. The webhook field/event names below are
 * modeled on ThriveCart's documented payloads and MUST be confirmed against a live payload.
 * The MECHANISM (fail-closed verification + canonical normalization for the holdout) is
 * the deliverable.
 *
 * Strategic note: because ThriveCart settles on Stripe/PayPal/Authorize.Net, AX10M's real
 * *drive* path is that underlying processor's adapter; this adapter wins on
 * attribution/measurement of involuntary churn. PROCESSORS.md §3.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  DeclineCode,
  familyOf,
  type CanonicalEvent,
  type DeclineEvent,
  type Invoice,
} from '@ax10m/canonical';
import type { CapabilityMatrix, RawWebhook } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface ThriveCartAdapterConfig {
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Shared secret configured in ThriveCart; sent back on each webhook. Injected, never hardcoded. */
  webhookSecret: string;
  /** Optional header that may also carry the shared secret. Defaults to `x-thrivecart-secret`. */
  secretHeader?: string;
}

export class ThriveCartAdapter extends BaseAdapter {
  readonly id = 'thrivecart';
  constructor(private readonly config: ThriveCartAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'advisory',
      externalRetryControl: false, // ThriveCart (over Stripe/PayPal/Authorize.Net) owns the retry loop
      accountUpdater: false, // not exposed to AX10M
      networkTokens: false, // not exposed to AX10M
      partialCapture: false,
      pauseNativeDunning: false, // cannot disable ThriveCart's dunning
      webhooks: true, // measurement only
      listPaymentMethods: false,
    };
  }

  override async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    // Parsing is safe (no trust granted yet); we verify the secret carried IN the body.
    const flat = parseBody(raw);
    const provided = flat['thrivecart_secret'] ?? headerLookup(raw.headers, this.config.secretHeader ?? 'x-thrivecart-secret');
    verifyThriveCartSecret(this.config.webhookSecret, provided);

    const event = flat['event'] ?? '';
    const ref = pick(flat, 'order_id', 'order[id]', 'invoice_id', 'id') ?? '';
    const occurredAt = toIso(pick(flat, 'created_at', 'timestamp', 'order[date]'));
    const eventId = pick(flat, 'event_id', 'id') ?? `${event}:${ref}`;

    const envelope = <T>(type: CanonicalEvent['type'], payload: T): CanonicalEvent<T> => ({
      id: `ax10m_evt_${eventId}`,
      type,
      merchantId: this.config.merchantId,
      processorEventId: eventId,
      occurredAt,
      payload,
    });

    switch (event) {
      case 'order.rebill_failed': {
        return [this.failedEvent(envelope, flat, ref, occurredAt)];
      }
      case 'order.subscription_payment': {
        // A subscription payment webhook can be a success or a failure; a failed flag decides.
        if (isFailedFlag(flat)) {
          return [this.failedEvent(envelope, flat, ref, occurredAt)];
        }
        return [envelope('invoice.paid', { invoice: this.buildInvoice(ref, flat, occurredAt, /*failed*/ false) })];
      }
      case 'order.success':
      case 'order.rebill': {
        return [envelope('invoice.paid', { invoice: this.buildInvoice(ref, flat, occurredAt, /*failed*/ false) })];
      }
      case 'order.subscription_cancelled':
      case 'order.subscription_canceled': {
        return [envelope('subscription.updated', {
          processorRef: pick(flat, 'subscription_id', 'subscription[id]') ?? ref,
          status: 'canceled',
        })];
      }
      default:
        return []; // event we don't act on
    }
  }

  private failedEvent(
    envelope: <T>(type: CanonicalEvent['type'], payload: T) => CanonicalEvent<T>,
    flat: Record<string, string>,
    ref: string,
    occurredAt: string,
  ): CanonicalEvent {
    const invoice = this.buildInvoice(ref, flat, occurredAt, /*failed*/ true);
    const reason = pick(flat, 'decline_reason', 'failure_reason', 'order[decline_reason]', 'reason', 'error');
    const decline = reason ? buildDecline(invoice.id, ref, reason, occurredAt) : undefined;
    return envelope('invoice.failed', decline ? { invoice, decline } : { invoice });
  }

  private buildInvoice(ref: string, flat: Record<string, string>, occurredAt: string, failed: boolean): Invoice {
    const currency = pick(flat, 'currency', 'order[currency]', 'order_currency') ?? 'USD';
    // ThriveCart reports totals as major-unit decimals; convert to integer minor units,
    // rounding to the nearest cent.
    const amount = toMinorUnits(pick(flat, 'order[total]', 'total', 'amount', 'order[amount]'));
    const custId = pick(flat, 'customer_id', 'customer[id]');
    const email = pick(flat, 'customer[email]', 'email');
    const custKey = customerKey(custId, email);
    const subId = pick(flat, 'subscription_id', 'subscription[id]');
    return {
      id: `ax10m_inv_${ref}`,
      subscriptionId: subId ? `ax10m_sub_${subId}` : undefined,
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
 * Verify the ThriveCart shared secret in constant time. FAILS CLOSED: throws when the
 * configured secret is missing (refuse unverified) or the provided secret does not match.
 */
export function verifyThriveCartSecret(configSecret: string | undefined, provided: string | undefined): void {
  if (!configSecret) {
    throw new Error('ThriveCartAdapter.ingestWebhook: webhookSecret not configured — refusing unverified webhook');
  }
  const a = Buffer.from(provided ?? '', 'utf8');
  const b = Buffer.from(configSecret, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('ThriveCartAdapter.ingestWebhook: webhook secret verification failed');
  }
}

/** Map a raw gateway/decline reason string onto a canonical decline code (keyword-based). */
export function mapThriveCartDeclineReason(raw: string | null | undefined): DeclineCode {
  return mapDeclineReason(raw);
}

/**
 * Parse a ThriveCart webhook body into a flat map keyed by bracket-notation param names.
 * Handles both `application/x-www-form-urlencoded` and JSON (nested JSON is flattened to
 * the same bracket keys, e.g. `{customer:{email}}` → `customer[email]`).
 */
export function parseBody(raw: RawWebhook): Record<string, string> {
  const ct = (headerLookup(raw.headers, 'content-type') ?? '').toLowerCase();
  const body = raw.body ?? '';
  const looksJson = ct.includes('application/json') || body.trimStart().startsWith('{');
  if (looksJson) {
    try {
      return flatten(JSON.parse(body));
    } catch {
      throw new Error('ThriveCartAdapter.ingestWebhook: body is not valid JSON');
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

// ── file-local helpers (advisory adapters keep these local; no shared edits) ──

function isFailedFlag(flat: Record<string, string>): boolean {
  const raw = pick(flat, 'payment_failed', 'subscription_failed', 'failed', 'order[status]', 'status', 'order[payment_status]');
  if (!raw) return false;
  const s = raw.toLowerCase();
  return s === '1' || s === 'true' || s === 'failed' || s === 'declined' || s === 'decline';
}

function flatten(obj: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== 'object') {
    if (prefix) out[prefix] = String(obj);
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') Object.assign(out, flatten(v, key));
    else if (v !== undefined) out[key] = String(v);
  }
  return out;
}

function pick(flat: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = flat[k];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
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
  if (typeof v === 'string' && v !== '') {
    const asNum = Number(v);
    if (!Number.isNaN(asNum) && /^\d+$/.test(v.trim())) return toIso(asNum);
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
