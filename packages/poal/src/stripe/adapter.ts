/**
 * Stripe processor adapter — DRIVE (ARCHITECTURE.md §7, PROCESSORS.md §3).
 *
 * The largest-share adapter, now implemented against the Stripe REST API:
 *  - ingestWebhook   — verify the Stripe-Signature (HMAC-SHA256, timestamped),
 *                      normalize invoice.payment_failed/succeeded and
 *                      charge.failed/succeeded into canonical events. Unlike a bare
 *                      gateway, Stripe invoices carry the customer id, so holdout
 *                      clustering is proper customer-level here.
 *  - attemptCharge   — POST /invoices/{id}/pay against a stored PaymentMethod token
 *                      (never a PAN → SAQ-A), deterministic Idempotency-Key. A card
 *                      decline is HTTP 402 error.type 'card_error' → a failed
 *                      ChargeResult, not an infra error.
 *  - listOpenFailures— poll open auto-collection invoices (reconciliation).
 *  - listPaymentMethods — a customer's stored cards.
 *  - fetchUpdatedCard — null: Stripe auto-updates cards / network tokens server-side.
 *  - pauseNativeDunning — Smart Retries is account-level; taking control means
 *      disabling it in Billing settings (documented no-op here). In shadow mode we
 *      deliberately DON'T pause — Smart Retries stays on as the measured baseline.
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
} from '../adapter.js';
import { customerFromInvoice } from '../customer.js';
import { StripeClient, StripeError, type FetchLike } from './client.js';
import { mapStripeDeclineCode } from './decline-map.js';
import { verifyStripeSignature } from './signature.js';

export interface StripeAdapterConfig {
  /** Restricted, least-privilege secret key. Injected, never hardcoded. */
  secretKey: string;
  /** Webhook signing secret for Stripe-Signature verification. */
  webhookSecret: string;
  /** AX10M-internal merchant id this adapter instance serves. */
  merchantId: string;
  apiVersion?: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

interface StripeInvoice {
  id: string;
  customer?: string;
  subscription?: string;
  amount_due?: number;
  amount_remaining?: number;
  total?: number;
  currency?: string;
  status?: string;
  created?: number;
  // Contact fields Stripe stamps on the invoice at finalization — the dunning channels'
  // destinations. Display/contact only; never a PAN.
  customer_email?: string;
  customer_phone?: string;
}
interface StripeCharge {
  id: string;
  invoice?: string;
  customer?: string;
  amount?: number;
  currency?: string;
  created?: number;
  decline_code?: string;
  failure_code?: string;
  outcome?: { reason?: string };
  // Per-charge contact info (charges carry billing_details, not customer_* fields).
  billing_details?: { email?: string; phone?: string };
  receipt_email?: string;
}
interface StripeEvent {
  id?: string;
  type?: string;
  created?: number;
  data?: { object?: Record<string, unknown> };
}

const CENTS = (n: number | undefined): number => (typeof n === 'number' ? n : 0);
const isoFromEpoch = (sec: number | undefined): string =>
  typeof sec === 'number' ? new Date(sec * 1000).toISOString() : new Date(0).toISOString();

/**
 * Build customer overrides from webhook contact fields, dropping empties so a blank string
 * never shadows an absent value. Feeds the dunning channels (email / SMS destinations).
 */
function contactOverrides(email: string | undefined, phone: string | undefined): { email?: string; phone?: string } {
  const o: { email?: string; phone?: string } = {};
  if (email) o.email = email;
  if (phone) o.phone = phone;
  return o;
}

export class StripeAdapter implements ProcessorAdapter {
  readonly id = 'stripe';
  private readonly client: StripeClient;

  constructor(private readonly config: StripeAdapterConfig) {
    this.client = new StripeClient({
      secretKey: config.secretKey,
      apiVersion: config.apiVersion,
      baseUrl: config.baseUrl,
      fetch: config.fetch,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive', // co-drive when the merchant leaves Smart Retries on
      externalRetryControl: true,
      accountUpdater: true,
      networkTokens: true,
      partialCapture: true,
      pauseNativeDunning: true,
      webhooks: true,
      listPaymentMethods: true,
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    const signature = raw.headers['stripe-signature'] ?? raw.headers['Stripe-Signature'];
    if (!verifyStripeSignature(raw.body, signature, this.config.webhookSecret)) {
      throw new Error('StripeAdapter.ingestWebhook: Stripe-Signature verification failed');
    }
    let event: StripeEvent;
    try {
      event = JSON.parse(raw.body);
    } catch {
      throw new Error('StripeAdapter.ingestWebhook: body is not valid JSON');
    }
    const occurredAt = isoFromEpoch(event.created);
    const obj = event.data?.object ?? {};
    const envelope = <T>(type: CanonicalEvent['type'], payload: T): CanonicalEvent<T> => ({
      id: `ax10m_evt_${event.id ?? ''}`,
      type,
      merchantId: this.config.merchantId,
      processorEventId: event.id ?? '',
      occurredAt,
      payload,
    });

    switch (event.type) {
      case 'invoice.payment_failed': {
        const inv = obj as unknown as StripeInvoice;
        const invoice = this.mapInvoice(inv, occurredAt, true);
        const attempt = this.buildAttempt({ invoiceId: invoice.id, paymentMethodId: '', idempotencyKey: '', amount: invoice.amount, status: 'failed', declineCode: undefined, attemptedAt: occurredAt });
        const decline = this.buildDecline(undefined, invoice.id, attempt.id, occurredAt);
        const customer = customerFromInvoice(invoice, contactOverrides(inv.customer_email, inv.customer_phone));
        return [envelope('invoice.failed', { invoice, attempt, decline, customer })];
      }
      case 'invoice.payment_succeeded':
      case 'invoice.paid': {
        const inv = obj as unknown as StripeInvoice;
        const invoice = this.mapInvoice(inv, occurredAt, false);
        return [envelope('invoice.paid', { invoice })];
      }
      case 'charge.failed': {
        const ch = obj as unknown as StripeCharge;
        const invoice = this.mapChargeAsInvoice(ch, occurredAt, true);
        const rawCode = ch.decline_code ?? ch.failure_code ?? ch.outcome?.reason;
        const attempt = this.buildAttempt({ invoiceId: invoice.id, paymentMethodId: '', idempotencyKey: '', amount: invoice.amount, status: 'failed', declineCode: mapStripeDeclineCode(rawCode), txnId: ch.id, attemptedAt: occurredAt });
        const decline = this.buildDecline(rawCode, invoice.id, attempt.id, occurredAt);
        const customer = customerFromInvoice(invoice, contactOverrides(ch.billing_details?.email ?? ch.receipt_email, ch.billing_details?.phone));
        return [envelope('invoice.failed', { invoice, attempt, decline, customer })];
      }
      case 'charge.succeeded': {
        const ch = obj as unknown as StripeCharge;
        const invoice = this.mapChargeAsInvoice(ch, occurredAt, false);
        return [envelope('invoice.paid', { invoice })];
      }
      default:
        return [];
    }
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(cursor: Cursor): Promise<OpenFailuresPage> {
    const res = await this.client.get('/invoices', {
      status: 'open',
      collection_method: 'charge_automatically',
      limit: 100,
      starting_after: cursor ?? undefined,
    });
    const data = Array.isArray(res.data) ? (res.data as StripeInvoice[]) : [];
    const invoices = data.map((inv) => this.mapInvoice(inv, isoFromEpoch(inv.created), true));
    const hasMore = res.has_more === true;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
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
        `/invoices/${encodeURIComponent(invoice.processorRef)}/pay`,
        { payment_method: method.processorRef, off_session: true },
        idempotencyKey,
      );
      const inv = body as unknown as StripeInvoice & { paid?: boolean };
      const status = String(inv.status ?? '');
      const paid = inv.paid === true || status === 'paid';
      const outcome: ChargeResult['outcome'] = paid ? 'succeeded' : status === 'open' ? 'failed' : 'pending';
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: outcome,
        txnId: inv.id,
        attemptedAt: new Date().toISOString(),
      });
      return { attempt, outcome, idempotentReplay };
    } catch (err) {
      // A card decline is an HTTP 402 card_error — an outcome, not an error.
      if (err instanceof StripeError && err.isCardError()) {
        const raw = err.body.error?.decline_code ?? err.body.error?.code;
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: method.id,
          idempotencyKey,
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapStripeDeclineCode(raw),
          attemptedAt: new Date().toISOString(),
        });
        return { attempt, outcome: 'failed', idempotentReplay: false };
      }
      throw err; // auth/validation/infra — let the saga retry
    }
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    // Stripe auto-updates saved cards + network tokens server-side, so a retry uses
    // the freshest credential — nothing to explicitly fetch and apply.
    return null;
  }

  async listPaymentMethods(customer: Customer): Promise<PaymentMethod[]> {
    const res = await this.client.get('/payment_methods', { customer: customer.processorRef, type: 'card', limit: 100 });
    const data = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
    return data.map((pm) => this.mapPaymentMethod(pm, customer));
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: Stripe Smart Retries is account-level (Billing settings), not a
    // per-subscription API toggle. Taking control means disabling it there and
    // operating on raw PaymentIntents; in shadow mode we intentionally leave it on
    // so it is the measured baseline (ARCHITECTURE.md §1.2).
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  private mapInvoice(inv: StripeInvoice, occurredAt: string, failed: boolean): Invoice {
    return {
      id: `ax10m_inv_${inv.id}`,
      subscriptionId: inv.subscription ? `ax10m_sub_${inv.subscription}` : undefined,
      customerId: inv.customer ? `ax10m_cus_${inv.customer}` : '',
      merchantId: this.config.merchantId,
      processorRef: inv.id,
      amount: { amount: CENTS(inv.amount_due ?? inv.amount_remaining ?? inv.total), currency: (inv.currency ?? 'usd').toUpperCase() },
      status: mapInvoiceStatus(inv.status),
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: isoFromEpoch(inv.created),
    };
  }

  /** Non-invoice one-off charge modeled as a canonical Invoice for recovery. */
  private mapChargeAsInvoice(ch: StripeCharge, occurredAt: string, failed: boolean): Invoice {
    const ref = ch.invoice ?? ch.id;
    return {
      id: `ax10m_inv_${ref}`,
      customerId: ch.customer ? `ax10m_cus_${ch.customer}` : '',
      merchantId: this.config.merchantId,
      processorRef: ref,
      amount: { amount: CENTS(ch.amount), currency: (ch.currency ?? 'usd').toUpperCase() },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: isoFromEpoch(ch.created),
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
      attemptNumber: 1,
      attemptedAt: p.attemptedAt,
    };
  }

  private buildDecline(rawCode: string | undefined, invoiceId: string, chargeAttemptId: string, occurredAt: string): DeclineEvent {
    const code = mapStripeDeclineCode(rawCode);
    return {
      id: `ax10m_dec_${invoiceId}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason: rawCode,
      occurredAt,
    };
  }

  private mapPaymentMethod(pm: Record<string, unknown>, customer: Customer): PaymentMethod {
    const id = String(pm.id ?? '');
    const card = (pm.card as Record<string, unknown> | undefined) ?? {};
    return {
      id: `ax10m_pm_${id}`,
      customerId: customer.id,
      processorRef: id,
      token: id, // Stripe PaymentMethod id — a token, never a PAN
      brand: typeof card.brand === 'string' ? card.brand : undefined,
      last4: typeof card.last4 === 'string' ? card.last4 : undefined,
      expMonth: typeof card.exp_month === 'number' ? card.exp_month : undefined,
      expYear: typeof card.exp_year === 'number' ? card.exp_year : undefined,
    };
  }
}

function mapInvoiceStatus(status: string | undefined): Invoice['status'] {
  switch (status) {
    case 'paid':
      return 'paid';
    case 'void':
      return 'void';
    case 'uncollectible':
      return 'uncollectible';
    default:
      return 'open';
  }
}
