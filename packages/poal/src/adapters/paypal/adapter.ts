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
    // PayPal's payer.phone.phone_number carries ONLY `national_number` (no country code) per the
    // Orders payer schema (validated against developer.paypal.com, 2026-08), so it can't be
    // assembled into E.164 — toE164 drops it downstream and PayPal is effectively email-only.
    phone?: { phone_number?: { national_number?: string } };
  };
}

/** A HATEOAS link object (rel/href/method). */
interface PpLink {
  href?: string;
  rel?: string;
  method?: string;
}
/**
 * A `PAYMENT.CAPTURE.REFUNDED` webhook `resource` — a Payments-v2 Refund object.
 * modeled on PayPal webhook — CONFIRM (Payments v2 refund schema, developer.paypal.com / paypal-rest-api-specifications).
 * CRITICAL: `id` here is the REFUND id, NOT the capture id — the capture id (the value
 * `mapResourceInvoice` falls back to) is only reachable via the rel:"up" link.
 */
interface PpRefundResource {
  id?: string; // the refund id — distinct from the capture id
  status?: string;
  amount?: PpAmount;
  invoice_id?: string; // echoes the merchant invoice number, if the caller set one
  custom_id?: string; // echoes the merchant custom id, if the caller set one
  links?: PpLink[]; // includes rel:"up" → /v2/payments/captures/{captureId}
}
/**
 * One entry in a dispute's `disputed_transactions[]` (Customer-Disputes v1).
 * modeled on PayPal webhook — CONFIRM. Disputes v1 names the merchant refs
 * `invoice_number`/`custom` (vs `invoice_id`/`custom_id` on the Orders/Payments capture);
 * `seller_transaction_id` is the seller-side transaction id == the capture id.
 */
interface PpDisputedTransaction {
  seller_transaction_id?: string;
  buyer_transaction_id?: string;
  invoice_number?: string;
  custom?: string;
  reference_id?: string;
}
/**
 * A `CUSTOMER.DISPUTE.CREATED` webhook `resource` — a Customer-Disputes-v1 dispute object.
 * modeled on PayPal webhook — CONFIRM.
 */
interface PpDisputeResource {
  dispute_id?: string;
  dispute_amount?: PpAmount;
  reason?: string;
  status?: string;
  disputed_transactions?: PpDisputedTransaction[];
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

/**
 * Extract the parent CAPTURE id from a Refund object's HATEOAS links (rel:"up" →
 * `/v2/payments/captures/{captureId}`). This is the value `mapResourceInvoice` uses as its
 * final fallback for the ORIGINAL capture (a driven charge carries no invoice_id/custom_id),
 * so it lets a refund round-trip to the SAME `ax10m_inv_…` id — the refund's own `id` (a
 * distinct refund id) must NOT be used for that. modeled on PayPal webhook — CONFIRM.
 */
function captureIdFromRefundLinks(links: PpLink[] | undefined): string | undefined {
  const up = (links ?? []).find((l) => (l.rel ?? '').toLowerCase() === 'up');
  if (!up?.href) return undefined;
  const m = up.href.match(/\/captures\/([^/?#]+)/);
  return m?.[1];
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
        // Email is the reliable PayPal contact; the payer phone is national-only → dropped by toE164.
        const customer = customerFromInvoice(invoice, contactOverrides(resource.payer?.email_address, resource.payer?.phone?.phone_number?.national_number));
        return [envelope('invoice.failed', { invoice, attempt, decline, customer })];
      }
      case 'PAYMENT.CAPTURE.COMPLETED':
      case 'PAYMENT.SALE.COMPLETED': {
        const invoice = this.mapResourceInvoice(resource, occurredAt, false);
        const attempt = this.mapResourceAttempt(resource, invoice.id, false);
        return [envelope('invoice.paid', { invoice, attempt })];
      }
      case 'PAYMENT.CAPTURE.REFUNDED': {
        // A collected capture was (partially) refunded → net-recovery / fee clawback. The
        // reversal MUST resolve to the SAME id `mapResourceInvoice` built for the original
        // capture: `invoice_id ?? custom_id ?? <capture id>`. The Refund object echoes the
        // merchant invoice_id/custom_id, but its own `id` is the REFUND id — so the fallback
        // takes the CAPTURE id from the rel:"up" link, never resource.id.
        // modeled on PayPal webhook — CONFIRM
        const refund = resource as unknown as PpRefundResource;
        const ref = refund.invoice_id ?? refund.custom_id ?? captureIdFromRefundLinks(refund.links);
        const amount = majorToMinor(refund.amount?.value);
        if (!ref || amount <= 0) return []; // can't map to a recovery invoice id → skip
        const reversal: ReversalPayload = {
          invoiceId: `ax10m_inv_${ref}`,
          amount,
          currency: refund.amount?.currency_code ?? 'USD',
          kind: 'refund',
        };
        return [envelope('payment.reversed', reversal)];
      }
      case 'CUSTOMER.DISPUTE.CREATED': {
        // A dispute/chargeback was opened → net-recovery clawback. The dispute references the
        // seller-side transaction (the capture) via disputed_transactions[].seller_transaction_id,
        // which equals the capture id `mapResourceInvoice` falls back to for a driven recovery.
        // Disputes v1 names the merchant refs invoice_number/custom (vs invoice_id/custom_id on the
        // capture); we mirror the SAME precedence. Reverses on dispute CREATION (funds held); a
        // later resolution in the merchant's favour is a follow-up, not modeled here.
        // modeled on PayPal webhook — CONFIRM
        const dispute = resource as unknown as PpDisputeResource;
        const tx = (dispute.disputed_transactions ?? []).find(
          (t) => t.seller_transaction_id || t.invoice_number || t.custom,
        );
        const ref = tx?.invoice_number ?? tx?.custom ?? tx?.seller_transaction_id;
        const amount = majorToMinor(dispute.dispute_amount?.value);
        if (!ref || amount <= 0) return []; // can't map to a recovery invoice id → skip
        const reversal: ReversalPayload = {
          invoiceId: `ax10m_inv_${ref}`,
          amount,
          currency: dispute.dispute_amount?.currency_code ?? 'USD',
          kind: 'chargeback',
          reason: dispute.reason,
        };
        return [envelope('payment.reversed', reversal)];
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
