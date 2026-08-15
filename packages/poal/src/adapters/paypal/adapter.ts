/**
 * PayPal processor adapter — DRIVE (PROCESSORS.md §3, ARCHITECTURE.md §4.1).
 *
 * NOTE: endpoint paths and JSON field names are modeled on PayPal's documented REST
 * API and MUST be re-confirmed against the live version. The load-bearing MECHANISM
 * is real and is the deliverable: idempotency via `PayPal-Request-Id`, a fail-closed
 * `verify-webhook-signature` API call, token-only (SAQ-A), and the decline-vs-error
 * split.
 *
 * STRATEGIC REALITY (PROCESSORS.md): PayPal Wallet + PayPal Subscriptions largely
 * AUTO-retry their own failed payments and expose no clean "force-charge now" API,
 * so this adapter DRIVES the card-on-file / reference-transaction path — a vaulted
 * payment-method token charged via an Orders-v2 create+capture we control — and
 * otherwise MEASURES (webhooks). We never pause PayPal's native subscription retries
 * because PayPal owns that loop; `pauseNativeDunning` is a no-op and the capability
 * matrix advertises `pauseNativeDunning: false`.
 *
 * End-to-end:
 *  - ingestWebhook   — verify via verify-webhook-signature (FAIL CLOSED), normalize
 *                      capture/sale DENIED/COMPLETED + subscription events.
 *  - attemptCharge   — POST /v2/checkout/orders (intent CAPTURE) against a vault
 *                      token, then capture if needed, same PayPal-Request-Id on both.
 *  - listOpenFailures— PayPal has no cross-merchant failed-invoice ledger via this
 *                      API → empty (reconcile via Transaction Search API; TODO).
 *  - fetchUpdatedCard/listPaymentMethods/pauseNativeDunning — not drivable here.
 *
 * Hard rule: we hold only PayPal vault tokens / billing-agreement ids, never a PAN.
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
import { customerFromInvoice, contactOverrides } from '../../customer.js';
import type {
  CapabilityMatrix,
  ChargeResult,
  Cursor,
  OpenFailuresPage,
  ProcessorAdapter,
  RawWebhook,
} from '../../adapter.js';
import { PayPalClient, PayPalError, verifyPaypalWebhookSignature, type FetchLike } from './client.js';
import { mapPaypalDeclineCode } from './decline-map.js';

export interface PayPalAdapterConfig {
  /** OAuth2 client-credentials app id. Injected, never hardcoded. */
  clientId: string;
  /** OAuth2 client secret. Injected, never hardcoded. */
  clientSecret: string;
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Webhook id registered in the PayPal dashboard — REQUIRED to verify webhooks (fail closed). */
  webhookId?: string;
  /** Injectable transport for testing. */
  fetch?: FetchLike;
  /** Override base URL. Live https://api-m.paypal.com; sandbox https://api-m.sandbox.paypal.com. */
  baseUrl?: string;
}

/** Shapes of the PayPal JSON we read (only the fields we use). */
interface PpAmount {
  value?: string; // MAJOR units as a decimal string, e.g. "149.00"
  currency_code?: string;
}
interface PpCapture {
  id?: string;
  status?: string; // COMPLETED | DECLINED | PENDING | ...
  amount?: PpAmount;
  status_details?: { reason?: string };
}
interface PpPurchaseUnit {
  reference_id?: string;
  amount?: PpAmount;
  custom_id?: string;
  invoice_id?: string;
  payments?: { captures?: PpCapture[] };
}
interface PpOrder {
  id?: string;
  status?: string; // CREATED | APPROVED | COMPLETED | ...
  purchase_units?: PpPurchaseUnit[];
}
/** A webhook `resource` (capture/sale/subscription — union of the fields we read). */
interface PpResource {
  id?: string;
  status?: string;
  amount?: PpAmount;
  custom_id?: string;
  invoice_id?: string;
  reason?: string;
  status_details?: { reason?: string };
  payer?: {
    payer_id?: string;
    email_address?: string;
    // PayPal splits the phone into an optional country code + national number. We build
    // `+<cc><national>` when the country code is present (→ valid E.164); a national-only
    // number is dropped downstream by toE164 as not safely dialable. Contact only, never a PAN.
    phone?: { phone_number?: { country_code?: string; national_number?: string } };
  };
}

/** Parse a PayPal MAJOR-unit decimal string ("149.00") into integer minor units (14900). */
function majorToMinor(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isNaN(n)) return 0;
  // ASSUMPTION: 2-decimal currencies. Zero-decimal currencies (JPY) would over-scale
  // here — a per-currency exponent table is the correct fix (TODO(ax10m)).
  return Math.round(n * 100);
}

/** Render integer minor units (14900) as a PayPal MAJOR-unit decimal string ("149.00"). */
function minorToMajor(amount: number): string {
  // ASSUMPTION: 2-decimal currencies (see majorToMinor).
  return (amount / 100).toFixed(2);
}

function toIso(value: string | undefined): string {
  if (!value) return new Date(0).toISOString();
  const t = Date.parse(value);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

export class PayPalAdapter implements ProcessorAdapter {
  readonly id = 'paypal';
  private readonly client: PayPalClient;

  constructor(private readonly config: PayPalAdapterConfig) {
    this.client = new PayPalClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      fetch: config.fetch,
      baseUrl: config.baseUrl,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive',
      externalRetryControl: true,
      accountUpdater: false, // PayPal owns the vaulted credential; no AX10M-drivable updater here
      networkTokens: true, // vault tokens / network tokens back the reference transaction
      partialCapture: false, // we capture the full order amount on the recovery path
      pauseNativeDunning: false, // PayPal owns subscription retries — nothing we can pause
      webhooks: true,
      listPaymentMethods: false, // vault tokens are not enumerable per-customer via this API
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    // Fail CLOSED: without a configured webhook id we cannot call verify-webhook-
    // signature, so we refuse rather than trust an unverified payload.
    if (!this.config.webhookId) {
      throw new Error('PayPalAdapter.ingestWebhook: webhookId not configured — refusing unverified webhook');
    }
    let event: { id?: string; event_type?: string; create_time?: string; resource?: PpResource };
    try {
      event = JSON.parse(raw.body);
    } catch {
      throw new Error('PayPalAdapter.ingestWebhook: body is not valid JSON');
    }

    // PayPal signature verification is a real API call, routed through the injectable
    // transport. Trust the event ONLY on verification_status === 'SUCCESS'.
    const verified = await verifyPaypalWebhookSignature(this.client, {
      headers: raw.headers,
      webhookId: this.config.webhookId,
      eventBody: raw.body,
    });
    if (!verified) {
      throw new Error('PayPalAdapter.ingestWebhook: verify-webhook-signature did not return SUCCESS — refusing webhook');
    }

    const eventId = event.id ?? '';
    const occurredAt = toIso(event.create_time);
    const resource = event.resource ?? {};

    const envelope = <T>(type: CanonicalEvent['type'], payload: T): CanonicalEvent<T> => ({
      id: `ax10m_evt_${eventId}`,
      type,
      merchantId: this.config.merchantId,
      processorEventId: eventId,
      occurredAt,
      payload,
    });

    switch (event.event_type) {
      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.SALE.DENIED':
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
        const invoice = this.mapResourceInvoice(resource, occurredAt, /*failed*/ true);
        const attempt = this.mapResourceAttempt(resource, invoice.id, true);
        const decline = this.mapResourceDecline(resource, invoice.id, attempt.id, occurredAt);
        const pn = resource.payer?.phone?.phone_number;
        const phone = pn?.country_code && pn?.national_number ? `+${pn.country_code}${pn.national_number}` : pn?.national_number;
        const customer = customerFromInvoice(invoice, contactOverrides(resource.payer?.email_address, phone));
        return [envelope('invoice.failed', { invoice, attempt, decline, customer })];
      }
      case 'PAYMENT.CAPTURE.COMPLETED':
      case 'PAYMENT.SALE.COMPLETED': {
        const invoice = this.mapResourceInvoice(resource, occurredAt, false);
        const attempt = this.mapResourceAttempt(resource, invoice.id, false);
        return [envelope('invoice.paid', { invoice, attempt })];
      }
      case 'BILLING.SUBSCRIPTION.CANCELLED': {
        return [envelope('subscription.updated', {
          processorRef: resource.id ?? '',
          status: resource.status ?? 'CANCELLED',
        })];
      }
      default:
        return []; // event we don't act on
    }
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(_cursor: Cursor): Promise<OpenFailuresPage> {
    // PayPal exposes no cross-merchant failed-invoice ledger via the Orders API —
    // failures arrive via webhooks. $-reconciliation would run against the
    // Transaction Search API (GET /v1/reporting/transactions). TODO(ax10m): wire it.
    return { invoices: [], nextCursor: null };
  }

  // ── drive: charge (card-on-file order + capture) ──────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    try {
      // Step 1 — create the order against the vaulted token. Same PayPal-Request-Id
      // is used for create AND capture so the whole two-step de-dupes as one unit.
      const created = await this.client.post(
        '/v2/checkout/orders',
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: invoice.processorRef,
              amount: {
                currency_code: invoice.amount.currency,
                value: minorToMajor(invoice.amount.amount),
              },
            },
          ],
          // Vault token only — never a PAN (SAQ-A).
          payment_source: { token: { id: method.token, type: 'PAYMENT_METHOD_TOKEN' } },
        },
        idempotencyKey,
      );

      const order = created.body as PpOrder;
      let status = String(order.status ?? '');
      let idempotentReplay = created.idempotentReplay;
      let capture = this.extractCapture(order);

      // Step 2 — capture if the order was created/approved but not auto-completed.
      // (We tolerate a single-response COMPLETED order and skip the second call.)
      if (status !== 'COMPLETED' && (status === 'CREATED' || status === 'APPROVED') && order.id) {
        const captured = await this.client.post(
          `/v2/checkout/orders/${encodeURIComponent(order.id)}/capture`,
          {},
          idempotencyKey,
        );
        idempotentReplay = idempotentReplay || captured.idempotentReplay;
        const capturedOrder = captured.body as PpOrder;
        capture = this.extractCapture(capturedOrder) ?? capture;
        // Prefer the capture-object status; fall back to the order status.
        status = capture?.status ?? String(capturedOrder.status ?? status);
      } else if (capture?.status) {
        status = capture.status;
      }

      const outcome: ChargeResult['outcome'] =
        status === 'COMPLETED' ? 'succeeded' : status === 'DECLINED' ? 'failed' : 'pending';

      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: outcome,
        declineCode:
          outcome === 'failed' ? mapPaypalDeclineCode(capture?.status_details?.reason) : undefined,
        txnId: capture?.id ?? order.id,
        attemptedAt: new Date().toISOString(),
      });
      return { attempt, outcome, idempotentReplay };
    } catch (err) {
      // A 422 issuer decline is an expected OUTCOME (a decline), not an error.
      if (err instanceof PayPalError && err.isPaymentFailure()) {
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: method.id,
          idempotencyKey,
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapPaypalDeclineCode(err.declineReason()),
          attemptedAt: new Date().toISOString(),
        });
        return { attempt, outcome: 'failed', idempotentReplay: false };
      }
      throw err; // infra / auth / validation error — let the saga retry
    }
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    // The vaulted credential is opaque to us and PayPal refreshes network tokens
    // server-side, so there is no separate "updated card" for AX10M to fetch/apply.
    return null;
  }

  async listPaymentMethods(_customer: Customer): Promise<PaymentMethod[]> {
    // PayPal vault tokens are not enumerable per-customer through this API — a token
    // is created/known at vault time, not listed back. Nothing to enumerate here.
    return [];
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: PayPal owns the subscription retry loop and exposes no pause we can drive.
    // We MEASURE PayPal's native retries rather than disabling them.
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  /** Pull the first capture object out of an order (create or capture response). */
  private extractCapture(order: PpOrder): PpCapture | undefined {
    for (const pu of order.purchase_units ?? []) {
      const cap = pu.payments?.captures?.[0];
      if (cap) return cap;
    }
    return undefined;
  }

  private mapResourceInvoice(resource: PpResource, occurredAt: string, failed: boolean): Invoice {
    // processorRef: prefer the explicit invoice_id / custom_id (merchant-owned), else
    // the resource id (capture/sale id) so we can always round-trip back to PayPal.
    const ref = resource.invoice_id ?? resource.custom_id ?? resource.id ?? '';
    const customerRef = resource.payer?.payer_id;
    return {
      id: `ax10m_inv_${ref}`,
      customerId: customerRef ? `ax10m_cus_${customerRef}` : '',
      merchantId: this.config.merchantId,
      processorRef: ref,
      amount: {
        amount: majorToMinor(resource.amount?.value),
        currency: resource.amount?.currency_code ?? 'USD',
      },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: occurredAt,
    };
  }

  private mapResourceAttempt(resource: PpResource, invoiceId: string, failed: boolean): ChargeAttempt {
    return this.buildAttempt({
      invoiceId,
      paymentMethodId: '',
      idempotencyKey: '',
      amount: {
        amount: majorToMinor(resource.amount?.value),
        currency: resource.amount?.currency_code ?? 'USD',
      },
      status: failed ? 'failed' : 'succeeded',
      declineCode: failed
        ? mapPaypalDeclineCode(resource.status_details?.reason ?? resource.reason)
        : undefined,
      txnId: resource.id,
      attemptedAt: toIso(undefined), // webhook resource carries no per-attempt timestamp we trust
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

  private mapResourceDecline(
    resource: PpResource,
    invoiceId: string,
    chargeAttemptId: string,
    occurredAt: string,
  ): DeclineEvent {
    const raw = resource.status_details?.reason ?? resource.reason;
    const code = mapPaypalDeclineCode(raw);
    return {
      id: `ax10m_dec_${resource.id ?? invoiceId}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason: raw,
      occurredAt,
    };
  }
}
