/**
 * Worldpay (Access Worldpay) processor adapter — DRIVE (PROCESSORS.md §3,
 * ARCHITECTURE.md §4.1).
 *
 * NOTE: the endpoint path (`POST /api/payments`), request/response field names
 * (`instruction.paymentInstrument.tokenId`, `outcome`, `refusalCode`,
 * `refusalDescription`), the idempotency header (`Idempotency-Key`) and the webhook
 * signature header (`X-WP-Signature`, config-overridable) are modeled on the
 * documented Access Worldpay API and MUST be confirmed against the current API
 * version before production. The enforcement MECHANISM this adapter delivers is the
 * real deliverable and is version-stable: deterministic idempotency, fail-closed
 * HMAC webhook verification, token-only (SAQ-A — we never see a PAN), and
 * decline-vs-error separation.
 *
 * End-to-end against Access Worldpay Payments + event notifications:
 *  - ingestWebhook   — HMAC-verify the signature header, normalize payment.refused →
 *                      invoice.failed and payment.settled/payment.authorized →
 *                      invoice.paid.
 *  - attemptCharge   — POST /api/payments against a stored card token (never a PAN →
 *                      SAQ-A), auto-settle, deterministic idempotency key. An
 *                      `outcome: "refused"` (HTTP 200 OR a 4xx refusal body) is a
 *                      decline, not an infra error.
 *  - listOpenFailures— Worldpay is a gateway, not a biller: no invoice ledger, so
 *                      failures arrive via notifications (returns empty here).
 *  - fetchUpdatedCard— network tokens auto-updated server-side (returns null).
 *  - listPaymentMethods — Worldpay tokens are not enumerable per customer (returns empty).
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
  type ReversalPayload,
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
import { WorldpayClient, WorldpayError, type FetchLike } from './client.js';
import { mapWorldpayRefusal } from './decline-map.js';

export interface WorldpayAdapterConfig {
  /** Basic-auth username. Injected, never hardcoded. */
  username: string;
  /** Basic-auth password. Injected, never hardcoded. */
  password: string;
  /** Worldpay merchant entity reference used on the payment instruction. */
  entity: string;
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Webhook signing secret — the secret Worldpay signs the notification HMAC with. */
  webhookSecret?: string;
  /** Header name carrying the notification signature. Defaults to `X-WP-Signature`. */
  signatureHeader?: string;
  /** Override base URL (test / regions). Defaults to https://access.worldpay.com. */
  baseUrl?: string;
  /** Injectable transport for testing. */
  fetch?: FetchLike;
}

/** Shape of the Worldpay payment response we read (only the fields we use). */
interface WpPaymentResponse {
  outcome?: string; // authorized | refused | ...
  refusalCode?: string;
  refusalDescription?: string;
  transactionReference?: string;
  paymentId?: string;
}

/** Shape of a Worldpay event notification (only the fields we use). */
interface WpEventNotification {
  eventId?: string;
  eventTimestamp?: string;
  eventDetails?: {
    type?: string; // payment.refused | payment.settled | payment.authorized | payment.refunded | ...
    transactionReference?: string;
    // Access Worldpay stamps the currency on refund/chargeback events as `currencyCode`; the
    // charge-flow modeling above uses `currency`. We read either so the reversal path is robust.
    amount?: { value?: number; currency?: string; currencyCode?: string };
    refusalCode?: string;
    refusalDescription?: string;
    paymentId?: string;
  };
}

const CENTS = (n: number | undefined): number => (typeof n === 'number' ? n : 0);
const DEFAULT_SIGNATURE_HEADER = 'x-wp-signature';

function toIso(value: string | undefined): string {
  if (!value) return new Date(0).toISOString();
  const t = Date.parse(value);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

// ── Webhook signature (Access Worldpay event notifications) ──────────────────────

/** Compute the hex HMAC-SHA256 signature Worldpay sends on a notification. */
export function computeWorldpaySignature(body: string, webhookSecret: string): string {
  return createHmac('sha256', webhookSecret).update(body, 'utf8').digest('hex');
}

/** Constant-time verification of a notification signature against the recomputed HMAC. */
export function verifyWorldpaySignature(body: string, provided: string, webhookSecret: string): boolean {
  const expected = computeWorldpaySignature(body, webhookSecret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class WorldpayAdapter implements ProcessorAdapter {
  readonly id = 'worldpay';
  private readonly client: WorldpayClient;

  constructor(private readonly config: WorldpayAdapterConfig) {
    this.client = new WorldpayClient({
      username: config.username,
      password: config.password,
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
      listPaymentMethods: false, // tokens are not enumerable per customer
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    // Fail CLOSED: without a configured signing secret we cannot trust the body,
    // so we refuse rather than accept a forged (unauthenticated) notification.
    if (!this.config.webhookSecret) {
      throw new Error('WorldpayAdapter.ingestWebhook: webhookSecret not configured — refusing unverified webhook');
    }
    const headerName = (this.config.signatureHeader ?? DEFAULT_SIGNATURE_HEADER).toLowerCase();
    const provided = headerLookup(raw.headers, headerName) ?? '';
    if (!verifyWorldpaySignature(raw.body, provided, this.config.webhookSecret)) {
      throw new Error('WorldpayAdapter.ingestWebhook: notification signature verification failed');
    }

    let event: WpEventNotification;
    try {
      event = JSON.parse(raw.body);
    } catch {
      throw new Error('WorldpayAdapter.ingestWebhook: body is not valid JSON');
    }
    const eventId = event.eventId ?? '';
    const occurredAt = toIso(event.eventTimestamp);
    const details = event.eventDetails ?? {};

    const base = {
      id: `ax10m_evt_${eventId}`,
      merchantId: this.config.merchantId,
      processorEventId: eventId,
      occurredAt,
    };

    switch (details.type) {
      case 'payment.refused': {
        const invoice = this.mapInvoice(details, occurredAt, /*failed*/ true);
        const attempt = this.mapAttempt(details, invoice.id, /*failed*/ true, occurredAt);
        const decline = this.mapDecline(details, invoice.id, attempt.id, occurredAt);
        // No contact enrichment: Access Worldpay carries no shopper contact in the notification,
        // and its payment-retrieval API (GET /paymentQueries/payments/{id}) does NOT return the
        // shopper email either — `shopperEmailAddress` is a write-only auth-request input that is
        // never echoed back (validated against Access Worldpay docs, 2026-08). Recovering contact
        // would require persisting it at authorization time, which this recovery overlay doesn't do.
        return [{ ...base, type: 'invoice.failed', payload: { invoice, attempt, decline, customer: customerFromInvoice(invoice) } }];
      }
      case 'payment.settled':
      case 'payment.authorized': {
        const invoice = this.mapInvoice(details, occurredAt, /*failed*/ false);
        const attempt = this.mapAttempt(details, invoice.id, /*failed*/ false, occurredAt);
        return [{ ...base, type: 'invoice.paid', payload: { invoice, attempt } }];
      }
      case 'payment.refunded': {
        // A settled payment we may have recovered was later refunded → net-recovery clawback
        // (AX10M bills on NET uplift, so a refund must reverse the recovery we counted).
        //
        // Access Worldpay's `refunded` payment event (classification 'payment', type 'refunded' —
        // matched here under this adapter's existing `payment.*` type convention) carries the same
        // `transactionReference` we supplied at authorization. mapInvoice stamps the original
        // recovery's id as `ax10m_inv_${transactionReference}`, so the reversal's invoiceId is
        // that exact id — a reliable, direct mapping (no charge→invoice lookup needed, unlike
        // Stripe disputes). Amount is minor units in `amount.value`; currency in `currencyCode`.
        const ref = details.transactionReference ?? '';
        const amount = CENTS(details.amount?.value);
        if (!ref || amount <= 0) return []; // unmappable or zero → not an actionable reversal
        const reversal: ReversalPayload = {
          invoiceId: `ax10m_inv_${ref}`,
          amount,
          currency: details.amount?.currencyCode ?? details.amount?.currency ?? 'USD',
          kind: 'refund',
        };
        return [{ ...base, type: 'payment.reversed', payload: reversal }];
      }
      default:
        // NOTE: Access Worldpay DOES emit `chargeback` events (classification 'chargeback') that
        // carry `transactionReference`, so the invoice mapping would be reliable. We deliberately
        // do NOT emit a chargeback reversal here: the chargeback event is a multi-stage lifecycle
        // (informationRequested → chargeback → reversed/defended/secondChargeback …) and the
        // published schema does not let us reliably distinguish the single stage that represents a
        // net funds withdrawal from a retrieval request or a later re-credit. Firing on the wrong
        // stage would over- or under-count the clawback, so we leave chargebacks unwired rather
        // than guess the stage. Refunds (above) are a single unambiguous event.
        return []; // event we don't act on
    }
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(_cursor: Cursor): Promise<OpenFailuresPage> {
    // Worldpay is a payment gateway, not a biller — there is no invoice ledger to
    // poll. Failures arrive via event notifications; $-reconciliation is against
    // Worldpay's settlement/reporting feed (TODO(ax10m): wire the reporting API).
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
        '/api/payments',
        {
          transactionReference: invoice.processorRef,
          merchant: { entity: this.config.entity },
          instruction: {
            narrative: { line1: 'AX10M recovery' },
            value: { currency: invoice.amount.currency, amount: invoice.amount.amount },
            paymentInstrument: { type: 'card/tokenized', tokenId: method.token },
            requestAutoSettlement: { on: true },
          },
        },
        idempotencyKey,
      );
      const payment = body as WpPaymentResponse;
      const outcome = payment.outcome ?? '';
      const status: ChargeResult['outcome'] =
        outcome === 'authorized' ? 'succeeded' : outcome === 'refused' ? 'failed' : 'pending';
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status,
        declineCode:
          status === 'failed' ? mapWorldpayRefusal(payment.refusalCode, payment.refusalDescription) : undefined,
        txnId: payment.paymentId ?? payment.transactionReference,
        attemptedAt: new Date().toISOString(),
      });
      return { attempt, outcome: status, idempotentReplay };
    } catch (err) {
      // A refusal that arrives as a 4xx is a DECLINE (an expected outcome), not an error.
      if (err instanceof WorldpayError && err.isPaymentFailure()) {
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: method.id,
          idempotencyKey,
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapWorldpayRefusal(err.body.refusalCode, err.body.refusalDescription),
          attemptedAt: new Date().toISOString(),
        });
        return { attempt, outcome: 'failed', idempotentReplay: false };
      }
      throw err; // infra / auth / validation error — let the saga retry
    }
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    // Worldpay auto-updates network tokens server-side (Account Updater), so a retry
    // through the stored token already uses the freshest credential — there is no
    // separate "updated card" to fetch and apply.
    return null;
  }

  async listPaymentMethods(_customer: Customer): Promise<PaymentMethod[]> {
    // Worldpay stored-card tokens are addressed per-token, not enumerable per customer
    // through a list endpoint on this integration, so we cannot enumerate a customer's
    // stored methods here (capability advertised as listPaymentMethods:false).
    return [];
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: Worldpay is a gateway with no merchant-facing dunning engine, so there is
    // nothing to disable — AX10M owns the retry loop entirely.
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  private mapInvoice(
    details: NonNullable<WpEventNotification['eventDetails']>,
    occurredAt: string,
    failed: boolean,
  ): Invoice {
    const ref = details.transactionReference ?? '';
    return {
      id: `ax10m_inv_${ref}`,
      customerId: '',
      merchantId: this.config.merchantId,
      processorRef: ref,
      amount: { amount: CENTS(details.amount?.value), currency: details.amount?.currency ?? 'USD' },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: occurredAt,
    };
  }

  private mapAttempt(
    details: NonNullable<WpEventNotification['eventDetails']>,
    invoiceId: string,
    failed: boolean,
    occurredAt: string,
  ): ChargeAttempt {
    return this.buildAttempt({
      invoiceId,
      paymentMethodId: '',
      idempotencyKey: '',
      amount: { amount: CENTS(details.amount?.value), currency: details.amount?.currency ?? 'USD' },
      status: failed ? 'failed' : 'succeeded',
      declineCode: failed ? mapWorldpayRefusal(details.refusalCode, details.refusalDescription) : undefined,
      txnId: details.paymentId ?? details.transactionReference,
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
    details: NonNullable<WpEventNotification['eventDetails']>,
    invoiceId: string,
    chargeAttemptId: string,
    occurredAt: string,
  ): DeclineEvent {
    const code = mapWorldpayRefusal(details.refusalCode, details.refusalDescription);
    return {
      id: `ax10m_dec_${details.paymentId ?? details.transactionReference ?? invoiceId}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason: details.refusalDescription ?? details.refusalCode,
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
