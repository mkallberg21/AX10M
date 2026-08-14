/**
 * Adyen processor adapter — DRIVE (PROCESSORS.md §3, ARCHITECTURE.md §4.1).
 *
 * End-to-end against the Adyen Checkout API + notification webhooks:
 *  - ingestWebhook   — HMAC-verify each notification item, normalize AUTHORISATION
 *                      success=true/false into canonical invoice.paid/failed.
 *  - attemptCharge   — POST /payments with a stored token (never a PAN → SAQ-A),
 *                      ContAuth + Subscription, deterministic Idempotency-Key. A
 *                      `Refused` resultCode is a decline (not an HTTP error).
 *  - listPaymentMethods — GET /storedPaymentMethods for a shopper.
 *  - fetchUpdatedCard — Adyen auto-updates network tokens server-side, so the next
 *                      attemptCharge already uses the freshest credential (returns
 *                      null: nothing to explicitly apply).
 *  - listOpenFailures — Adyen is a gateway, not a biller: it has no invoice ledger,
 *                      so failures arrive via notifications and $-reconciliation is
 *                      against the Settlement Details report (returns empty here).
 *  - pauseNativeDunning — no-op: Adyen runs no merchant dunning to disable (which
 *                      is exactly why it's a clean DRIVE integration).
 *
 * Cleanest DRIVE target: no competing merchant-facing dunning engine.
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
} from '@lift/canonical';
import type {
  CapabilityMatrix,
  ChargeResult,
  Cursor,
  OpenFailuresPage,
  ProcessorAdapter,
  RawWebhook,
} from '../../adapter.js';
import { AdyenClient, type FetchLike } from './client.js';
import {
  mapAdyenRefusalReason,
  verifyAdyenHmac,
  type AdyenNotificationItem,
} from './notification-map.js';

export interface AdyenAdapterConfig {
  apiKey: string;
  merchantAccount: string;
  /** Lift-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Hex HMAC key for webhook signature verification (from the Adyen Customer Area). */
  hmacKey?: string;
  /** Checkout API base URL (test/live prefix). */
  baseUrl?: string;
  fetch?: FetchLike;
}

const CENTS = (n: number | undefined): number => (typeof n === 'number' ? n : 0);

function toIso(eventDate: string | undefined): string {
  if (!eventDate) return new Date(0).toISOString();
  const t = Date.parse(eventDate);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export class AdyenAdapter implements ProcessorAdapter {
  readonly id = 'adyen';
  private readonly client: AdyenClient;

  constructor(private readonly config: AdyenAdapterConfig) {
    this.client = new AdyenClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, fetch: config.fetch });
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive',
      externalRetryControl: true,
      accountUpdater: true,
      networkTokens: true,
      partialCapture: true,
      pauseNativeDunning: false, // Adyen has no merchant dunning to pause
      webhooks: true,
      listPaymentMethods: true,
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    let parsed: { notificationItems?: Array<{ NotificationRequestItem?: AdyenNotificationItem }> };
    try {
      parsed = JSON.parse(raw.body);
    } catch {
      throw new Error('AdyenAdapter.ingestWebhook: body is not valid JSON');
    }
    const items = parsed.notificationItems ?? [];
    const events: CanonicalEvent[] = [];
    for (const wrap of items) {
      const item = wrap.NotificationRequestItem;
      if (!item) continue;
      if (this.config.hmacKey && !verifyAdyenHmac(item, this.config.hmacKey)) {
        throw new Error(`AdyenAdapter.ingestWebhook: HMAC verification failed (psp=${item.pspReference ?? '?'})`);
      }
      const ev = this.mapItem(item);
      if (ev) events.push(ev);
    }
    return events;
  }

  private mapItem(item: AdyenNotificationItem): CanonicalEvent | null {
    if (item.eventCode !== 'AUTHORISATION') return null; // REFUND/CHARGEBACK/etc. handled elsewhere
    const occurredAt = toIso(item.eventDate);
    const failed = item.success !== 'true';
    const invoice = this.mapInvoice(item, occurredAt, failed);
    const attempt = this.mapAttempt(item, invoice.id, failed);
    const base = {
      id: `lift_evt_${item.pspReference ?? invoice.processorRef}`,
      merchantId: this.config.merchantId,
      processorEventId: item.pspReference ?? '',
      occurredAt,
    };
    if (failed) {
      const decline = this.mapDecline(item, invoice.id, attempt.id, occurredAt);
      return { ...base, type: 'invoice.failed', payload: { invoice, attempt, decline } };
    }
    return { ...base, type: 'invoice.paid', payload: { invoice, attempt } };
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(_cursor: Cursor): Promise<OpenFailuresPage> {
    // Adyen is a gateway, not a biller — there is no invoice ledger to poll. Failures
    // arrive via notifications; $-reconciliation is against the Settlement Details
    // report (TODO(lift): wire Adyen Report API). Invoice state lives in the
    // merchant's billing system, reconciled there.
    return { invoices: [], nextCursor: null };
  }

  // ── drive: charge ────────────────────────────────────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    const shopperReference =
      stripPrefix(method.customerId, 'lift_cus_') || stripPrefix(invoice.customerId, 'lift_cus_');
    const { body, idempotentReplay } = await this.client.post(
      '/payments',
      {
        merchantAccount: this.config.merchantAccount,
        amount: { value: invoice.amount.amount, currency: invoice.amount.currency },
        reference: invoice.processorRef,
        paymentMethod: { type: 'scheme', storedPaymentMethodId: method.processorRef },
        shopperReference,
        shopperInteraction: 'ContAuth',
        recurringProcessingModel: 'Subscription',
      },
      idempotencyKey,
    );

    const resultCode = String(body.resultCode ?? '');
    const outcome: ChargeResult['outcome'] =
      resultCode === 'Authorised'
        ? 'succeeded'
        : resultCode === 'Refused' || resultCode === 'Error' || resultCode === 'Cancelled'
          ? 'failed'
          : 'pending';
    const refusal =
      (body.refusalReason as string | undefined) ??
      (body.additionalData as Record<string, string> | undefined)?.refusalReasonRaw;

    const attempt = this.buildAttempt({
      invoiceId: invoice.id,
      paymentMethodId: method.id,
      idempotencyKey,
      amount: invoice.amount,
      status: outcome,
      declineCode: outcome === 'failed' ? mapAdyenRefusalReason(refusal) : undefined,
      txnId: body.pspReference as string | undefined,
      attemptedAt: new Date().toISOString(),
    });
    return { attempt, outcome, idempotentReplay };
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    // Adyen provisions + auto-updates network tokens server-side (Account Updater),
    // so a retry through the stored token already uses the freshest card — there is
    // no separate "updated card" to fetch and apply.
    return null;
  }

  async listPaymentMethods(customer: Customer): Promise<PaymentMethod[]> {
    const res = await this.client.get('/storedPaymentMethods', {
      shopperReference: customer.processorRef,
      merchantAccount: this.config.merchantAccount,
    });
    const list = Array.isArray(res.storedPaymentMethods)
      ? (res.storedPaymentMethods as Array<Record<string, unknown>>)
      : [];
    return list.map((sp) => this.mapStoredMethod(sp, customer));
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: Adyen runs no merchant-facing dunning engine, so there is nothing to
    // disable — Lift owns the retry loop entirely on Adyen.
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  private mapInvoice(item: AdyenNotificationItem, occurredAt: string, failed: boolean): Invoice {
    const ref = item.merchantReference ?? '';
    return {
      id: `lift_inv_${ref}`,
      customerId: '',
      merchantId: this.config.merchantId,
      processorRef: ref,
      amount: { amount: CENTS(item.amount?.value), currency: item.amount?.currency ?? 'USD' },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: occurredAt,
    };
  }

  private mapAttempt(item: AdyenNotificationItem, invoiceId: string, failed: boolean): ChargeAttempt {
    return this.buildAttempt({
      invoiceId,
      paymentMethodId: '',
      idempotencyKey: '',
      amount: { amount: CENTS(item.amount?.value), currency: item.amount?.currency ?? 'USD' },
      status: failed ? 'failed' : 'succeeded',
      declineCode: failed ? mapAdyenRefusalReason(item.reason ?? item.additionalData?.refusalReasonRaw) : undefined,
      txnId: item.pspReference,
      attemptedAt: toIso(item.eventDate),
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
      id: `lift_att_${p.txnId ?? (p.idempotencyKey || 'unknown')}`,
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
    item: AdyenNotificationItem,
    invoiceId: string,
    chargeAttemptId: string,
    occurredAt: string,
  ): DeclineEvent {
    const raw = item.reason ?? item.additionalData?.refusalReasonRaw;
    const code = mapAdyenRefusalReason(raw);
    return {
      id: `lift_dec_${item.pspReference ?? invoiceId}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason: raw,
      occurredAt,
    };
  }

  private mapStoredMethod(sp: Record<string, unknown>, customer: Customer): PaymentMethod {
    const id = String(sp.id ?? '');
    return {
      id: `lift_pm_${id}`,
      customerId: customer.id,
      processorRef: id,
      token: id, // Adyen stored-method / recurring-detail reference — no PAN
      brand: typeof sp.brand === 'string' ? sp.brand : undefined,
      last4: typeof sp.lastFour === 'string' ? sp.lastFour : undefined,
      expMonth: sp.expiryMonth ? Number(sp.expiryMonth) : undefined,
      expYear: sp.expiryYear ? Number(sp.expiryYear) : undefined,
    };
  }
}
