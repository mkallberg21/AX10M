/**
 * TSYS / Global Payments "Transaction Express" processor adapter — DRIVE
 * (PROCESSORS.md §3, ARCHITECTURE.md §4.1).
 *
 * NOTE: TSYS gateways are LEGACY US acquiring APIs. The base host
 * (`gateway.transit-pass.com/portal`), the sale path (`/v1/credit/sale`), and the
 * field names (`deviceID`, `transactionKey`, `transactionAmount`, `token`, ...)
 * below are modeled on the documented Transaction Express JSON gateway and MUST be
 * confirmed against the live merchant boarding (host, API version, exact field
 * casing) before production. What is load-bearing — and what this adapter actually
 * delivers — is the ENFORCEMENT MECHANISM: deterministic idempotency (sent as both
 * a header and an echoed field), decline-vs-error separation, token-only handling
 * (SAQ-A: we send only a stored `token`, never a PAN), and fail-closed ingress.
 *
 * Transaction Express is DRIVE-capable for the charge (we re-run a sale against a
 * stored token on our own schedule) but is response/report oriented — no signed
 * webhooks and no failed-invoice ledger API — so `ingestWebhook` fails closed and
 * `listOpenFailures` is empty (reconciliation is via the merchant's own record of
 * failed sales / batch settlement reports, fed in upstream).
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
import { TsysClient, TsysError, type FetchLike } from './client.js';
import { mapTsysDeclineCode } from './decline-map.js';

export interface TsysAdapterConfig {
  /** Transaction Express `deviceID` (credential block). Injected, never hardcoded. */
  deviceID: string;
  /** Transaction Express `transactionKey` (secret). Injected, never hardcoded. */
  transactionKey: string;
  /** Optional partner/developer id some deployments require. */
  developerID?: string;
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical ids). */
  merchantId: string;
  /** Injectable transport for testing. */
  fetch?: FetchLike;
  /** Override base URL (tests / regions / version). Defaults to the documented host. */
  baseUrl?: string;
}

/**
 * Convert integer minor units (canonical) to a MAJOR-unit decimal string.
 * e.g. 14900 cents → "149.00". Integer math (no float) to avoid money drift.
 * Assumes a 2-decimal currency (true for USD/CAD, TSYS's domain); confirm for any
 * exotic currency before enabling it on this processor.
 */
function minorToMajorString(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

export class TsysAdapter implements ProcessorAdapter {
  readonly id = 'tsys';
  private readonly client: TsysClient;

  constructor(private readonly config: TsysAdapterConfig) {
    this.client = new TsysClient({
      deviceID: config.deviceID,
      transactionKey: config.transactionKey,
      developerID: config.developerID,
      fetch: config.fetch,
      baseUrl: config.baseUrl,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive',
      externalRetryControl: true,
      accountUpdater: false, // no first-class Account Updater feed in this integration
      networkTokens: false,
      partialCapture: true, // a sale can be for any amount ≤ the amount on file
      pauseNativeDunning: false, // TSYS runs no subscription dunning for us to pause
      webhooks: false, // response/report oriented — no signed webhooks
      listPaymentMethods: false, // stored tokens are not enumerable via the gateway
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(_raw: RawWebhook): Promise<CanonicalEvent[]> {
    // FAIL CLOSED. Transaction Express is response/report oriented and has no
    // modern signed-webhook mechanism we can verify, so we refuse to synthesize
    // trusted events from an unauthenticated payload. Recovery outcomes are learned
    // from the sale RESPONSE to attemptCharge (and the merchant's batch reports).
    throw new Error('tsys: no signed webhook; use reconciliation poll');
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(_cursor: Cursor): Promise<OpenFailuresPage> {
    // Transaction Express is an acquiring GATEWAY, not a billing ledger: it exposes
    // no "open/failed invoice" list to reconcile against. The truth source for TSYS
    // failures is the merchant's own record of failed sales / batch settlement
    // reports, fed in upstream. We therefore return an empty page rather than
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
      // SAQ-A: we send only the stored token, never a PAN. The deterministic
      // idempotency key is carried by the client as both an `Idempotency-Key`
      // header and an echoed body field.
      const body = await this.client.post(
        '/v1/credit/sale',
        {
          transactionAmount: minorToMajorString(invoice.amount.amount),
          currencyCode: invoice.amount.currency,
          token: method.token,
          orderNumber: invoice.processorRef,
          cardOnFile: 'Y', // stored-credential / merchant-initiated transaction
        },
        idempotencyKey,
      );

      // Only a PASS reaches here (the client throws on DECLINED/FAIL/HTTP error).
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: 'succeeded',
        txnId: body.transactionID,
        attemptedAt: new Date().toISOString(),
      });
      return { attempt, outcome: 'succeeded', idempotentReplay: false };
    } catch (err) {
      // A DECLINED status is a card decline (an expected OUTCOME), not an error.
      if (err instanceof TsysError && err.isPaymentFailure()) {
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: method.id,
          idempotencyKey,
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapTsysDeclineCode(err.body.responseCode, err.body.responseMessage),
          txnId: err.body.transactionID,
          attemptedAt: new Date().toISOString(),
        });
        return { attempt, outcome: 'failed', idempotentReplay: false };
      }
      throw err; // FAIL / infra / auth / validation error — let the saga retry
    }
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    // No Account Updater / card-refresh feed in this Transaction Express integration.
    return null;
  }

  async listPaymentMethods(_customer: Customer): Promise<PaymentMethod[]> {
    // Stored TSYS tokens are not enumerable via the gateway API.
    return [];
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: TSYS runs no native subscription dunning for us to pause.
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
