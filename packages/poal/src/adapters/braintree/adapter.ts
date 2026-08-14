/**
 * Braintree (PayPal) processor adapter — DRIVE (PROCESSORS.md §3).
 *
 * End-to-end against Braintree's classic gateway (XML) + signed webhooks:
 *  - ingestWebhook   — verify the bt_signature (HMAC-SHA1), base64-decode the
 *                      bt_payload, and normalize subscription_charged_(un)successfully
 *                      into canonical invoice.paid/failed.
 *  - attemptCharge   — a `sale` against a vaulted payment-method token (never a PAN
 *                      → SAQ-A). A processor decline is an HTTP 422 whose body still
 *                      carries the declined <transaction>; only 422-without /
 *                      401 / 5xx are real errors.
 *  - listPaymentMethods — read the customer's vaulted credit cards.
 *  - fetchUpdatedCard — null: Braintree auto-provisions/updates network tokens and
 *                      emits an ACCOUNT_UPDATER_DAILY_REPORT; a retry uses the
 *                      freshest token, nothing to explicitly apply.
 *  - listOpenFailures — empty: reconciliation is via transaction search / settlement
 *                      batch, not an invoice ledger.
 *  - pauseNativeDunning — no-op for raw-vault usage; co-drive if the merchant relies
 *                      on Braintree Subscriptions (its engine retries + triggers the
 *                      Account Updater on the 2nd decline).
 *
 * Braintree has no first-class idempotency key; we set the transaction order-id to
 * the invoice reference and rely on the deterministic key at our layer + Braintree
 * duplicate-transaction checking, so a replay does not double-charge.
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
import { BraintreeClient, BraintreeError, type FetchLike } from './client.js';
import { mapBraintreeDeclineCode, verifyBraintreeSignature } from './response-map.js';
import { xmlBlocks, xmlInner, xmlLeaf } from './xml.js';

export interface BraintreeAdapterConfig {
  /** AX10M-internal merchant id this adapter instance serves. */
  merchantId: string;
  /** Braintree gateway merchant id (used in the URL path). */
  braintreeMerchantId: string;
  publicKey: string;
  privateKey: string;
  environment?: 'sandbox' | 'production';
  /** True when the merchant relies on Braintree-managed Subscriptions (→ co-drive). */
  usesBraintreeSubscriptions?: boolean;
  baseUrl?: string;
  fetch?: FetchLike;
}

const SUCCESS_STATUSES = new Set(['authorized', 'submitted_for_settlement', 'settling', 'settlement_pending', 'settlement_confirmed', 'settled']);
const FAILED_STATUSES = new Set(['processor_declined', 'gateway_rejected', 'settlement_declined', 'failed', 'authorization_expired', 'voided']);

function decimalToMinor(v: string | undefined): number {
  if (!v) return 0;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function minorToDecimal(minor: number): string {
  return (minor / 100).toFixed(2);
}
function mapTxnStatus(status: string | undefined): ChargeResult['outcome'] {
  const s = (status ?? '').toLowerCase();
  if (SUCCESS_STATUSES.has(s)) return 'succeeded';
  if (FAILED_STATUSES.has(s)) return 'failed';
  return 'pending';
}

export class BraintreeAdapter implements ProcessorAdapter {
  readonly id = 'braintree';
  private readonly client: BraintreeClient;

  constructor(private readonly config: BraintreeAdapterConfig) {
    this.client = new BraintreeClient({
      publicKey: config.publicKey,
      privateKey: config.privateKey,
      environment: config.environment,
      baseUrl: config.baseUrl,
      fetch: config.fetch,
    });
  }

  private mid(): string {
    return `/merchants/${encodeURIComponent(this.config.braintreeMerchantId)}`;
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: this.config.usesBraintreeSubscriptions ? 'co-drive' : 'drive',
      externalRetryControl: true,
      accountUpdater: true,
      networkTokens: true,
      partialCapture: true, // submitForPartialSettlement
      pauseNativeDunning: Boolean(this.config.usesBraintreeSubscriptions),
      webhooks: true,
      listPaymentMethods: true,
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    const form = new URLSearchParams(raw.body);
    const signature = form.get('bt_signature') ?? '';
    const payload = form.get('bt_payload') ?? '';
    if (!verifyBraintreeSignature(signature, payload, this.config.publicKey, this.config.privateKey)) {
      throw new Error('BraintreeAdapter.ingestWebhook: bt_signature verification failed');
    }
    const xml = Buffer.from(payload, 'base64').toString('utf8');
    const kind = xmlLeaf(xml, 'kind');
    const subject = xmlInner(xml, 'subject') ?? '';
    const occurredAt = normalizeTs(xmlLeaf(xml, 'timestamp'));

    if (kind === 'subscription_charged_unsuccessfully' || kind === 'subscription_charged_successfully') {
      const failed = kind === 'subscription_charged_unsuccessfully';
      const sub = xmlInner(subject, 'subscription') ?? '';
      const subId = xmlLeaf(sub, 'id') ?? '';
      const txn = xmlInner(sub, 'transaction') ?? '';
      const invoice = this.buildInvoice({
        ref: subId,
        subscriptionId: subId,
        amount: decimalToMinor(xmlLeaf(txn, 'amount')),
        currency: xmlLeaf(txn, 'currency-iso-code') ?? 'USD',
        occurredAt,
        failed,
      });
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: '',
        idempotencyKey: '',
        amount: invoice.amount,
        status: failed ? 'failed' : 'succeeded',
        declineCode: failed ? mapBraintreeDeclineCode(xmlLeaf(txn, 'processor-response-code')) : undefined,
        txnId: xmlLeaf(txn, 'id'),
        attemptedAt: occurredAt,
      });
      const base = {
        id: `ax10m_evt_${subId}_${occurredAt}`,
        merchantId: this.config.merchantId,
        processorEventId: `${kind}:${subId}:${occurredAt}`,
        occurredAt,
      };
      if (failed) {
        const decline = this.buildDecline(txn, invoice.id, attempt.id, occurredAt);
        return [{ ...base, type: 'invoice.failed', payload: { invoice, attempt, decline } }];
      }
      return [{ ...base, type: 'invoice.paid', payload: { invoice, attempt } }];
    }
    return []; // account_updater_daily_report, disbursement, etc. not acted on here
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(_cursor: Cursor): Promise<OpenFailuresPage> {
    // Braintree is a gateway — no invoice ledger. Failures arrive via webhooks and
    // $-reconciliation is via transaction search / settlement batch reports.
    return { invoices: [], nextCursor: null };
  }

  // ── drive: charge ────────────────────────────────────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    const body =
      `<transaction>` +
      `<type>sale</type>` +
      `<amount>${minorToDecimal(invoice.amount.amount)}</amount>` +
      `<payment-method-token>${escapeXml(method.processorRef)}</payment-method-token>` +
      `<order-id>${escapeXml(invoice.processorRef)}</order-id>` +
      `<options><submit-for-settlement>true</submit-for-settlement></options>` +
      `</transaction>`;
    const res = await this.client.request('POST', `${this.mid()}/transactions`, body);
    const txn = xmlInner(res.xml, 'transaction');
    if (txn) {
      const outcome = mapTxnStatus(xmlLeaf(txn, 'status'));
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: outcome,
        declineCode: outcome === 'failed' ? mapBraintreeDeclineCode(xmlLeaf(txn, 'processor-response-code')) : undefined,
        txnId: xmlLeaf(txn, 'id'),
        attemptedAt: new Date().toISOString(),
      });
      return { attempt, outcome, idempotentReplay: false };
    }
    // No transaction in the body → auth/validation/infra error, not a decline.
    throw new BraintreeError(res.status, xmlLeaf(res.xml, 'message') ?? `Braintree error ${res.status}`);
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    // Braintree auto-updates vaulted cards/network tokens and reports via the
    // ACCOUNT_UPDATER_DAILY_REPORT webhook; a retry uses the freshest token.
    return null;
  }

  async listPaymentMethods(customer: Customer): Promise<PaymentMethod[]> {
    const res = await this.client.request('GET', `${this.mid()}/customers/${encodeURIComponent(customer.processorRef)}`);
    if (!res.ok) {
      throw new BraintreeError(res.status, xmlLeaf(res.xml, 'message') ?? `Braintree error ${res.status}`);
    }
    return xmlBlocks(res.xml, 'credit-card').map((cc) => this.mapCreditCard(cc, customer));
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op for raw-vault usage. If the merchant uses Braintree Subscriptions,
    // taking control means canceling/adjusting that subscription's retry schedule
    // (TODO(ax10m): update_subscription), which is why that config is co-drive.
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  private buildInvoice(p: {
    ref: string;
    subscriptionId?: string;
    amount: number;
    currency: string;
    occurredAt: string;
    failed: boolean;
  }): Invoice {
    return {
      id: `ax10m_inv_${p.ref}`,
      subscriptionId: p.subscriptionId ? `ax10m_sub_${p.subscriptionId}` : undefined,
      customerId: '',
      merchantId: this.config.merchantId,
      processorRef: p.ref,
      amount: { amount: p.amount, currency: p.currency },
      status: p.failed ? 'open' : 'paid',
      firstFailedAt: p.failed ? p.occurredAt : undefined,
      createdAt: p.occurredAt,
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

  private buildDecline(txn: string, invoiceId: string, chargeAttemptId: string, occurredAt: string): DeclineEvent {
    const code = mapBraintreeDeclineCode(xmlLeaf(txn, 'processor-response-code'));
    return {
      id: `ax10m_dec_${xmlLeaf(txn, 'id') ?? invoiceId}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason: xmlLeaf(txn, 'processor-response-text') ?? xmlLeaf(txn, 'processor-response-code'),
      occurredAt,
    };
  }

  private mapCreditCard(cc: string, customer: Customer): PaymentMethod {
    const token = xmlLeaf(cc, 'token') ?? '';
    return {
      id: `ax10m_pm_${token}`,
      customerId: customer.id,
      processorRef: token,
      token,
      brand: xmlLeaf(cc, 'card-type'),
      last4: xmlLeaf(cc, 'last-4'),
      bin: xmlLeaf(cc, 'bin'),
      expMonth: cc.includes('expiration-month') ? Number(xmlLeaf(cc, 'expiration-month')) : undefined,
      expYear: cc.includes('expiration-year') ? Number(xmlLeaf(cc, 'expiration-year')) : undefined,
    };
  }
}

function escapeXml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeTs(ts: string | undefined): string {
  if (!ts) return new Date(0).toISOString();
  const t = Date.parse(ts);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}
