/**
 * Chargebee processor adapter — DRIVE (PROCESSORS.md §3, ARCHITECTURE.md §4.1).
 *
 * End-to-end implementation against Chargebee REST v2:
 *  - ingestWebhook   — verify the webhook's HTTP Basic auth, normalize
 *                      payment_failed / payment_succeeded / card / subscription
 *                      events into canonical events.
 *  - listOpenFailures— reconciliation poll over invoices in payment_due/not_paid.
 *  - attemptCharge   — `collect_payment` against a stored payment_source (token,
 *                      never a PAN → SAQ-A), with a deterministic idempotency key.
 *  - fetchUpdatedCard— read the payment source to detect an Account-Updater refresh.
 *  - listPaymentMethods — enumerate a customer's tokenized payment sources.
 *  - pauseNativeDunning — set auto_collection=off so AX10M owns the retry loop.
 *
 * Hard rules: we hold only Chargebee tokens / ids, never a PAN. Every charge
 * carries a deterministic idempotency key so a retry after a crash de-dupes into
 * an idempotent replay rather than a second charge.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  DeclineCode,
  familyOf,
  type CanonicalEvent,
  type ChargeAttempt,
  type Customer,
  type DeclineEvent,
  type Invoice,
  type Money,
  type PaymentMethod,
  type ReversalPayload,
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
import { ChargebeeClient, ChargebeeError, type FetchLike } from './client.js';
import { mapChargebeeDeclineCode } from './decline-map.js';

export interface ChargebeeAdapterConfig {
  /** Chargebee site name: <site>.chargebee.com. */
  site: string;
  /** Full-access or restricted API key (Basic-auth username). Injected, never hardcoded. */
  apiKey: string;
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Basic-auth credentials Chargebee sends ON its webhooks (configured in Chargebee). */
  webhookUser?: string;
  webhookPassword?: string;
  /** Injectable transport for testing. */
  fetch?: FetchLike;
  /** Override base URL (tests / regions). */
  baseUrl?: string;
}

/** Shapes of the Chargebee JSON we read (only the fields we use). */
interface CbInvoice {
  id: string;
  customer_id?: string;
  subscription_id?: string;
  currency_code?: string;
  total?: number;
  amount_due?: number;
  amount_to_collect?: number;
  status?: string; // paid | payment_due | not_paid | voided | pending
  date?: number;
  updated_at?: number;
}
interface CbTransaction {
  id: string;
  status?: string; // success | failure | timeout | needs_attention
  type?: string; // payment | refund | authorization | payment_reversal (Transaction resource enum)
  amount?: number;
  currency_code?: string;
  error_code?: string;
  error_text?: string;
  gateway?: string;
  payment_source_id?: string;
  date?: number;
}
// Chargebee Customer resource carries `email` + `phone` (validated against apidocs.chargebee.com,
// 2026-08). The Customer resource + field names are confirmed; what's unverified is whether
// `content.customer` is ALWAYS populated on a payment_failed event — hence the null-guard at the
// call site (a missing customer node → no contact, never a crash).
interface CbCustomer {
  id: string;
  email?: string;
  phone?: string; // often national (no country code) — toE164 drops it if not E.164
}
interface CbPaymentSource {
  id: string;
  customer_id?: string;
  status?: string;
  card?: { last4?: string; brand?: string; iin?: string; expiry_month?: number; expiry_year?: number; masked_number?: string };
}

const CENTS = (n: number | undefined): number => (typeof n === 'number' ? n : 0);
const isoFromEpoch = (sec: number | undefined): string =>
  typeof sec === 'number' ? new Date(sec * 1000).toISOString() : new Date(0).toISOString();

export class ChargebeeAdapter implements ProcessorAdapter {
  readonly id = 'chargebee';
  private readonly client: ChargebeeClient;

  constructor(private readonly config: ChargebeeAdapterConfig) {
    this.client = new ChargebeeClient({
      site: config.site,
      apiKey: config.apiKey,
      fetch: config.fetch,
      baseUrl: config.baseUrl,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive',
      externalRetryControl: true,
      accountUpdater: true, // via the underlying gateway / Chargebee Payments
      networkTokens: true,
      partialCapture: true, // collect_payment accepts an amount ≤ amount_to_collect
      pauseNativeDunning: true, // auto_collection=off
      webhooks: true,
      listPaymentMethods: true,
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    this.verifyWebhookAuth(raw.headers);
    let event: {
      id?: string;
      occurred_at?: number;
      event_type?: string;
      content?: { invoice?: CbInvoice; transaction?: CbTransaction; customer?: CbCustomer; payment_source?: CbPaymentSource; subscription?: { id: string; status?: string } };
    };
    try {
      event = JSON.parse(raw.body);
    } catch {
      throw new Error('ChargebeeAdapter.ingestWebhook: body is not valid JSON');
    }
    const eventId = event.id ?? '';
    const occurredAt = isoFromEpoch(event.occurred_at);
    const content = event.content ?? {};

    const envelope = <T>(type: CanonicalEvent['type'], payload: T): CanonicalEvent<T> => ({
      id: `ax10m_evt_${eventId}`,
      type,
      merchantId: this.config.merchantId,
      processorEventId: eventId,
      occurredAt,
      payload,
    });

    switch (event.event_type) {
      case 'payment_failed': {
        if (!content.invoice) return [];
        const invoice = this.mapInvoice(content.invoice, occurredAt, /*failed*/ true);
        const attempt = content.transaction ? this.mapAttempt(content.transaction, invoice.id) : undefined;
        const decline = content.transaction ? this.mapDecline(content.transaction, invoice.id, attempt?.id ?? '') : undefined;
        // Contact info from content.customer feeds the dunning channels. Chargebee phone is
        // often national (no country code) — pass as-is; contactOverrides/toE164 drops it if
        // not E.164 rather than fabricating a country code.
        const customer = customerFromInvoice(invoice, contactOverrides(content.customer?.email, content.customer?.phone));
        return [envelope('invoice.failed', { invoice, attempt, decline, customer })];
      }
      case 'payment_succeeded': {
        if (!content.invoice) return [];
        const invoice = this.mapInvoice(content.invoice, occurredAt, false);
        const attempt = content.transaction ? this.mapAttempt(content.transaction, invoice.id) : undefined;
        return [envelope('invoice.paid', { invoice, attempt })];
      }
      case 'payment_refunded': {
        // A collected payment was refunded → net-recovery clawback (fee is billed on net
        // recovery, so a refund of a payment we drove must claw it back). Chargebee's
        // payment_refunded event nests the refund `transaction` (type=refund, amount in cents)
        // alongside the original `invoice`; the reversal's invoiceId MUST equal the id
        // mapInvoice stamps for that invoice (`ax10m_inv_<invoice.id>`) so it links to the
        // recovery. Refund transaction amounts have no invoice link of their own
        // (Chargebee's linked_invoices applies to `payment` txns only), so the invoice id
        // comes from content.invoice. modeled on Chargebee webhook — CONFIRM
        if (!content.invoice || !content.transaction) return [];
        const txn = content.transaction;
        // Only settled refunds — guard against a non-refund txn slipping through.
        if (txn.type && txn.type !== 'refund') return [];
        const amount = CENTS(txn.amount);
        if (amount <= 0) return [];
        const reversal: ReversalPayload = {
          invoiceId: `ax10m_inv_${content.invoice.id}`,
          amount,
          currency: content.invoice.currency_code ?? txn.currency_code ?? 'USD',
          kind: 'refund',
        };
        return [envelope('payment.reversed', reversal)];
      }
      // NOTE: Chargebee exposes no native dispute/chargeback webhook event (verified against
      // apidocs.chargebee.com event-types, 2026-08), so no `kind: 'chargeback'` path exists
      // here. `refund_initiated` is intentionally excluded — it fires for async direct_debit
      // refunds still in_progress, not a settled reversal.
      case 'card_updated':
      case 'payment_source_updated': {
        if (!content.payment_source) return [];
        return [envelope('payment_method.updated', { paymentMethod: this.mapPaymentSource(content.payment_source) })];
      }
      case 'subscription_changed':
      case 'subscription_cancelled':
      case 'subscription_reactivated': {
        if (!content.subscription) return [];
        return [envelope('subscription.updated', {
          processorRef: content.subscription.id,
          status: content.subscription.status ?? 'unknown',
        })];
      }
      default:
        return []; // event we don't act on
    }
  }

  /** Chargebee authenticates its webhooks with HTTP Basic auth (configured in Chargebee). */
  private verifyWebhookAuth(headers: Record<string, string>): void {
    // Fail CLOSED: refuse to process a webhook when no credentials are configured,
    // rather than accepting a forged (unauthenticated) payload.
    if (!this.config.webhookUser && !this.config.webhookPassword) {
      throw new Error('ChargebeeAdapter.ingestWebhook: webhook Basic-auth credentials not configured — refusing unverified webhook');
    }
    const provided = headerLookup(headers, 'authorization') ?? '';
    const expected = `Basic ${Buffer.from(`${this.config.webhookUser ?? ''}:${this.config.webhookPassword ?? ''}`).toString('base64')}`;
    // Constant-time comparison to avoid leaking the secret via response timing.
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error('ChargebeeAdapter.ingestWebhook: webhook Basic auth verification failed');
    }
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(cursor: Cursor): Promise<OpenFailuresPage> {
    const res = await this.client.get('/invoices', {
      'status[in]': '["payment_due","not_paid"]',
      'sort_by[asc]': 'date',
      limit: 100,
      offset: cursor ?? undefined,
    });
    const list = Array.isArray(res.list) ? (res.list as Array<{ invoice?: CbInvoice }>) : [];
    const invoices = list
      .map((row) => row.invoice)
      .filter((inv): inv is CbInvoice => Boolean(inv))
      .map((inv) => this.mapInvoice(inv, isoFromEpoch(inv.updated_at ?? inv.date), true));
    const nextCursor = typeof res.next_offset === 'string' ? res.next_offset : null;
    return { invoices, nextCursor };
  }

  // ── drive: charge ────────────────────────────────────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    try {
      const { body, idempotentReplay } = await this.client.post(
        `/invoices/${encodeURIComponent(invoice.processorRef)}/collect_payment`,
        { payment_source_id: method.processorRef, amount: invoice.amount.amount },
        idempotencyKey,
      );
      const txn = (body.transaction as CbTransaction | undefined) ?? undefined;
      const outcome: ChargeResult['outcome'] =
        txn?.status === 'success' ? 'succeeded' : txn?.status === 'failure' ? 'failed' : 'pending';
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: outcome,
        declineCode: txn?.status === 'failure' ? mapChargebeeDeclineCode(txn.error_code) : undefined,
        txnId: txn?.id,
        attemptedAt: isoFromEpoch(txn?.date),
      });
      return { attempt, outcome, idempotentReplay };
    } catch (err) {
      // A payment-layer rejection is a DECLINE (an expected outcome), not an error.
      if (err instanceof ChargebeeError && err.isPaymentFailure()) {
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: method.id,
          idempotencyKey,
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapChargebeeDeclineCode(err.body.error_code),
          attemptedAt: new Date().toISOString(),
        });
        return { attempt, outcome: 'failed', idempotentReplay: false };
      }
      throw err; // infra / auth / validation error — let the saga retry
    }
  }

  async fetchUpdatedCard(method: PaymentMethod): Promise<PaymentMethod | null> {
    const res = await this.client.get(`/payment_sources/${encodeURIComponent(method.processorRef)}`);
    const ps = res.payment_source as CbPaymentSource | undefined;
    if (!ps?.card) return null;
    const refreshed = this.mapPaymentSource(ps);
    const changed =
      (method.expMonth !== undefined && refreshed.expMonth !== method.expMonth) ||
      (method.expYear !== undefined && refreshed.expYear !== method.expYear) ||
      (method.last4 !== undefined && refreshed.last4 !== method.last4);
    if (!changed) return null;
    return { ...refreshed, autoUpdated: true };
  }

  async listPaymentMethods(customer: Customer): Promise<PaymentMethod[]> {
    const res = await this.client.get('/payment_sources', {
      'customer_id[is]': customer.processorRef,
      limit: 100,
    });
    const list = Array.isArray(res.list) ? (res.list as Array<{ payment_source?: CbPaymentSource }>) : [];
    return list
      .map((row) => row.payment_source)
      .filter((ps): ps is CbPaymentSource => Boolean(ps))
      .map((ps) => this.mapPaymentSource(ps));
  }

  async pauseNativeDunning(subscription: Subscription): Promise<void> {
    // Set auto_collection=off so Chargebee stops auto-charging/dunning and AX10M owns
    // the retry loop. NOTE: in Phase 0 shadow mode we do NOT call this — Chargebee
    // dunning stays on and becomes the measured baseline (ARCHITECTURE.md §1.2).
    // (Endpoint per catalog version; auto_collection is accepted on the subscription.)
    await this.client.post(`/subscriptions/${encodeURIComponent(subscription.processorRef)}`, {
      auto_collection: 'off',
    });
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  private mapInvoice(inv: CbInvoice, occurredAt: string, failed: boolean): Invoice {
    const currency = inv.currency_code ?? 'USD';
    const amount = CENTS(inv.amount_due ?? inv.amount_to_collect ?? inv.total);
    return {
      id: `ax10m_inv_${inv.id}`,
      subscriptionId: inv.subscription_id ? `ax10m_sub_${inv.subscription_id}` : undefined,
      customerId: inv.customer_id ? `ax10m_cus_${inv.customer_id}` : '',
      merchantId: this.config.merchantId,
      processorRef: inv.id,
      amount: { amount, currency },
      status: mapInvoiceStatus(inv.status),
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: isoFromEpoch(inv.date),
    };
  }

  private mapAttempt(txn: CbTransaction, invoiceId: string): ChargeAttempt {
    return this.buildAttempt({
      invoiceId,
      paymentMethodId: txn.payment_source_id ? `ax10m_pm_${txn.payment_source_id}` : '',
      idempotencyKey: '',
      amount: { amount: CENTS(txn.amount), currency: txn.currency_code ?? 'USD' },
      status: txn.status === 'success' ? 'succeeded' : txn.status === 'failure' ? 'failed' : 'pending',
      declineCode: txn.status === 'failure' ? mapChargebeeDeclineCode(txn.error_code) : undefined,
      txnId: txn.id,
      attemptedAt: isoFromEpoch(txn.date),
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
      attemptNumber: 1, // attempt count is tracked by the recovery-case service, not the adapter
      attemptedAt: p.attemptedAt,
    };
  }

  private mapDecline(txn: CbTransaction, invoiceId: string, chargeAttemptId: string): DeclineEvent {
    const code = mapChargebeeDeclineCode(txn.error_code);
    return {
      id: `ax10m_dec_${txn.id}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason: txn.error_text ?? txn.error_code,
      occurredAt: isoFromEpoch(txn.date),
    };
  }

  private mapPaymentSource(ps: CbPaymentSource): PaymentMethod {
    return {
      id: `ax10m_pm_${ps.id}`,
      customerId: ps.customer_id ? `ax10m_cus_${ps.customer_id}` : '',
      processorRef: ps.id,
      token: ps.id, // Chargebee payment_source id is the reusable token; no PAN
      brand: ps.card?.brand,
      last4: ps.card?.last4,
      bin: ps.card?.iin,
      expMonth: ps.card?.expiry_month,
      expYear: ps.card?.expiry_year,
    };
  }
}

function mapInvoiceStatus(status: string | undefined): Invoice['status'] {
  switch (status) {
    case 'paid':
      return 'paid';
    case 'voided':
      return 'void';
    case 'not_paid':
    case 'payment_due':
    case 'pending':
    case 'posted':
      return 'open';
    default:
      return 'open';
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
