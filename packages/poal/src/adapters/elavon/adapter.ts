/**
 * Elavon Converge processor adapter — DRIVE (PROCESSORS.md §3, ARCHITECTURE.md §4.1).
 *
 * NOTE: Converge is a LEGACY US card gateway. The endpoint (`process.do`),
 * transaction type (`ccsale`), and field names (`ssl_*`) below are modeled on
 * Elavon's published Converge Developer Guide and MUST be confirmed against the
 * live integration / account configuration (and API version) before production.
 * What is load-bearing here — and what this adapter really delivers — is the
 * ENFORCEMENT MECHANISM: deterministic idempotency, decline-vs-error separation,
 * token-only handling (SAQ-A: we send only `ssl_token`, never a PAN), and
 * fail-closed ingress. Endpoint/field details are pluggable; the mechanism is not.
 *
 * Converge is DRIVE-capable for the charge itself (we re-run `ccsale` against a
 * stored multi-use token on our own schedule) but is poll/response-oriented and
 * has no signed webhooks and no invoice-ledger API — so `ingestWebhook` fails
 * closed and `listOpenFailures` is empty (reconciliation is out-of-band; see below).
 */

import {
  DeclineCode,
  type CanonicalEvent,
  type ChargeAttempt,
  type Customer,
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
import { ElavonClient, ElavonError, type FetchLike } from './client.js';
import { mapElavonDeclineCode } from './decline-map.js';

export interface ElavonAdapterConfig {
  /** Converge `ssl_merchant_id` (processor account id). Injected, never hardcoded. */
  sslMerchantId: string;
  /** Converge `ssl_user_id`. */
  sslUserId: string;
  /** Converge `ssl_pin` (API secret). Injected, never hardcoded. */
  sslPin: string;
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical ids). */
  merchantId: string;
  /** Injectable transport for testing. */
  fetch?: FetchLike;
  /** Override endpoint (tests / sandbox / regions). Defaults to the production process.do. */
  baseUrl?: string;
}

/**
 * Convert integer minor units (canonical) to Converge's MAJOR-unit decimal string.
 * e.g. 14900 cents → "149.00". Integer math (no float) to avoid money drift.
 * Assumes a 2-decimal currency (true for USD/CAD, Converge's domain); confirm for
 * any exotic currency before enabling it on this processor.
 */
function minorToMajorString(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

export class ElavonAdapter implements ProcessorAdapter {
  readonly id = 'elavon';
  private readonly client: ElavonClient;

  constructor(private readonly config: ElavonAdapterConfig) {
    this.client = new ElavonClient({
      sslMerchantId: config.sslMerchantId,
      sslUserId: config.sslUserId,
      sslPin: config.sslPin,
      fetch: config.fetch,
      baseUrl: config.baseUrl,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive',
      externalRetryControl: true,
      accountUpdater: false, // Converge has no first-class Account Updater feed in this integration
      networkTokens: false,
      partialCapture: true, // ccsale can charge any amount ≤ the stored authorization / on file
      pauseNativeDunning: false, // Converge does not run subscription dunning we could pause
      webhooks: false, // no signed webhooks — reconciliation is poll/response oriented
      listPaymentMethods: false, // tokens are not enumerable via the gateway
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(_raw: RawWebhook): Promise<CanonicalEvent[]> {
    // FAIL CLOSED. Converge has no modern signed-webhook mechanism we can verify,
    // so we refuse to synthesize trusted events from an unauthenticated payload.
    // Recovery outcomes for Converge are learned from the charge RESPONSE to
    // attemptCharge (and the merchant's own settlement/batch records), not webhooks.
    throw new Error('elavon: no signed webhook; use reconciliation poll');
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(_cursor: Cursor): Promise<OpenFailuresPage> {
    // Converge is a payment GATEWAY, not a billing ledger: it has no "open/failed
    // invoice" list API to reconcile against. The truth source for Converge
    // failures is the merchant's own billing system (or Converge batch/settlement
    // reports) fed in upstream. We therefore return an empty page rather than
    // fabricate one.
    return { invoices: [], nextCursor: null };
  }

  // ── drive: charge ────────────────────────────────────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    try {
      // SAQ-A: we send only the multi-use token (ssl_token), never a PAN.
      // NOTE: Converge has no native idempotency-key facility, so we cannot ask the
      // gateway to de-dupe a retry. The deterministic key is still carried on the
      // attempt record (and logged), but exactly-once MUST be enforced upstream by
      // the charge scheduler; idempotentReplay is therefore always false here.
      const body = await this.client.post({
        ssl_transaction_type: 'ccsale',
        ssl_token: method.token,
        // Converge uses MAJOR units as a decimal string (see minorToMajorString).
        ssl_amount: minorToMajorString(invoice.amount.amount),
        ssl_invoice_number: invoice.processorRef,
        ssl_merchant_txn_id: idempotencyKey, // echo the deterministic key for audit/grep
      });

      // Converge signals decline IN-BAND: ssl_result === '0' is an approval.
      if (body.ssl_result === '0') {
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: method.id,
          idempotencyKey,
          amount: invoice.amount,
          status: 'succeeded',
          txnId: body.ssl_txn_id,
          attemptedAt: new Date().toISOString(),
        });
        return { attempt, outcome: 'succeeded', idempotentReplay: false };
      }

      // Any non-zero ssl_result is an issuer decline (an expected OUTCOME).
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: 'failed',
        declineCode: mapElavonDeclineCode(body.ssl_result_message, body.ssl_result),
        txnId: body.ssl_txn_id,
        attemptedAt: new Date().toISOString(),
      });
      return { attempt, outcome: 'failed', idempotentReplay: false };
    } catch (err) {
      // Kept for symmetry with the shared adapter idiom: Converge never routes a
      // card decline through the error path (isPaymentFailure() is always false),
      // so any ElavonError is infra/validation and is rethrown for the saga to retry.
      if (err instanceof ElavonError && err.isPaymentFailure()) {
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: method.id,
          idempotencyKey,
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapElavonDeclineCode(err.body.ssl_result_message, err.body.ssl_result),
          attemptedAt: new Date().toISOString(),
        });
        return { attempt, outcome: 'failed', idempotentReplay: false };
      }
      throw err; // infra / auth / validation error — let the saga retry
    }
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    // No Account Updater / card-refresh feed in this Converge integration.
    return null;
  }

  async listPaymentMethods(_customer: Customer): Promise<PaymentMethod[]> {
    // Converge tokens are not enumerable via the gateway API.
    return [];
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: Converge runs no native subscription dunning for us to pause.
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

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
}
