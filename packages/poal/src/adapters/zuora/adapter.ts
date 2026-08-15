/**
 * Zuora processor adapter — CO-DRIVE (PROCESSORS.md §3, ARCHITECTURE.md §4.1).
 *
 * NOTE: the endpoint paths and JSON field names below are modeled on Zuora's
 * documented REST API and MUST be re-confirmed against the live API version — treat
 * them as the plausible shape, not gospel. Zuora's response envelope in particular is
 * assumed heavily (see attemptCharge). The load-bearing MECHANISM is real and is the
 * deliverable: deterministic `Idempotency-Key`, fail-closed HMAC Callout verification,
 * token-only (never a PAN → SAQ-A), and the decline-vs-error split — a GATEWAY decline
 * is an expected OUTCOME (Zuora returns a Payment in `Error` status), an infra/auth/
 * validation failure THROWS.
 *
 * CO-DRIVE: Zuora runs its own payment retry / dunning config. We coordinate with it
 * rather than owning the loop outright.
 *
 * End-to-end against Zuora REST:
 *  - ingestWebhook   — verify the Callout `Zuora-Signature` (HMAC-SHA256, hex) FAIL
 *                      CLOSED, normalize payment-failed/processed + subscription-
 *                      cancelled callouts.
 *  - listOpenFailures— reconciliation poll over invoices in `Posted` (open balance).
 *  - attemptCharge   — POST /v1/payments applying a payment to the invoice against a
 *                      stored payment method (token, never a PAN → SAQ-A).
 *  - fetchUpdatedCard— null (Zuora has no AX10M-drivable Account Updater here).
 *  - listPaymentMethods — not enumerable via this integration (capability false).
 *  - pauseNativeDunning — no-op (Zuora dunning is tenant-config-level).
 *
 * Hard rule: we hold only Zuora tokens / ids, never a PAN.
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
import { customerFromInvoice } from '../../customer.js';
import type {
  CapabilityMatrix,
  ChargeResult,
  Cursor,
  OpenFailuresPage,
  ProcessorAdapter,
  RawWebhook,
} from '../../adapter.js';
import { ZuoraClient, ZuoraError, type FetchLike } from './client.js';
import { mapZuoraDeclineCode, verifyZuoraSignature } from './decline-map.js';

export interface ZuoraAdapterConfig {
  /** OAuth2 client id. Injected, never hardcoded. */
  clientId: string;
  /** OAuth2 client secret. Injected, never hardcoded. */
  clientSecret: string;
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Shared secret Zuora signs its Callout notifications with (Zuora-Signature). */
  webhookSecret?: string;
  /** Injectable transport for testing. */
  fetch?: FetchLike;
  /** Override base URL. Prod https://rest.zuora.com; sandbox https://rest.apisandbox.zuora.com. */
  baseUrl?: string;
}

/** Read a field that Zuora may return with a lower- OR upper-first casing. */
function pick(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (body[k] !== undefined) return body[k];
  }
  return undefined;
}

/** Zuora amounts are decimal MAJOR units; canonical is integer minor units. */
const majorToMinor = (major: number | undefined): number =>
  typeof major === 'number' && !Number.isNaN(major) ? Math.round(major * 100) : 0;
const minorToMajor = (amount: number): number => amount / 100;

function toIso(value: string | undefined): string {
  if (!value) return new Date(0).toISOString();
  const t = Date.parse(value);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

/** Case-insensitive header lookup (proxies vary the casing of Zuora-Signature). */
function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Shapes of the Zuora JSON we read (only the fields we use). */
interface ZInvoice {
  id?: string;
  accountId?: string;
  amount?: number; // decimal major
  balance?: number; // decimal major
  currency?: string;
  status?: string; // Posted | Paid | Canceled | ...
  invoiceDate?: string;
}
/** A Zuora Callout notification (configurable — union of the fields we read). */
interface ZCallout {
  eventType?: string;
  type?: string;
  invoice?: { id?: string; accountId?: string; amount?: number; balance?: number; currency?: string; status?: string; invoiceDate?: string };
  payment?: { id?: string; status?: string; gatewayResponse?: string; gatewayResponseCode?: string };
  subscription?: { id?: string; status?: string };
  eventTime?: string;
}

export class ZuoraAdapter implements ProcessorAdapter {
  readonly id = 'zuora';
  private readonly client: ZuoraClient;

  constructor(private readonly config: ZuoraAdapterConfig) {
    this.client = new ZuoraClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      fetch: config.fetch,
      baseUrl: config.baseUrl,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive',
      externalRetryControl: true,
      accountUpdater: false, // no AX10M-drivable Account Updater on this integration
      networkTokens: false,
      partialCapture: true, // a Payment can apply a partial amount to the invoice
      pauseNativeDunning: false, // Zuora dunning is tenant-config-level, not API-toggled
      webhooks: true,
      listPaymentMethods: false,
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    // Fail CLOSED: without a configured shared secret we cannot verify the Callout
    // signature, so we refuse rather than trust an unverified payload.
    if (!this.config.webhookSecret) {
      throw new Error('ZuoraAdapter.ingestWebhook: webhookSecret not configured — refusing unverified webhook');
    }
    const signature = headerLookup(raw.headers, 'zuora-signature');
    if (!verifyZuoraSignature(raw.body, signature, this.config.webhookSecret)) {
      throw new Error('ZuoraAdapter.ingestWebhook: Zuora-Signature verification failed');
    }

    let callout: ZCallout;
    try {
      callout = JSON.parse(raw.body) as ZCallout;
    } catch {
      throw new Error('ZuoraAdapter.ingestWebhook: body is not valid JSON');
    }

    const type = (callout.eventType ?? callout.type ?? '').trim().toLowerCase();
    const occurredAt = toIso(callout.eventTime);

    const envelope = <T>(t: CanonicalEvent['type'], payload: T): CanonicalEvent<T> => ({
      id: `ax10m_evt_${callout.payment?.id ?? callout.invoice?.id ?? type}`,
      type: t,
      merchantId: this.config.merchantId,
      processorEventId: callout.payment?.id ?? callout.invoice?.id ?? '',
      occurredAt,
      payload,
    });

    // Payment failed → invoice.failed.
    if (type.includes('paymentfailed') || type.includes('payment_failed') || type === 'paymenterror') {
      const invoice = this.mapCalloutInvoice(callout, occurredAt, /*failed*/ true);
      const rawReason = callout.payment?.gatewayResponse ?? callout.payment?.gatewayResponseCode;
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: '',
        idempotencyKey: '',
        amount: invoice.amount,
        status: 'failed',
        declineCode: mapZuoraDeclineCode(rawReason),
        txnId: callout.payment?.id,
        attemptedAt: occurredAt,
      });
      const decline = this.buildDecline(callout, invoice.id, attempt.id, occurredAt);
      return [envelope('invoice.failed', { invoice, attempt, decline, customer: customerFromInvoice(invoice) })];
    }
    // Payment processed → invoice.paid.
    if (type.includes('paymentprocessed') || type.includes('payment_processed') || type === 'paymentsuccess') {
      const invoice = this.mapCalloutInvoice(callout, occurredAt, false);
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: '',
        idempotencyKey: '',
        amount: invoice.amount,
        status: 'succeeded',
        txnId: callout.payment?.id,
        attemptedAt: occurredAt,
      });
      return [envelope('invoice.paid', { invoice, attempt })];
    }
    // Subscription cancelled → subscription.updated.
    if (type.includes('subscriptioncancel') || type.includes('subscription_cancel')) {
      if (!callout.subscription?.id) return [];
      return [envelope('subscription.updated', { processorRef: callout.subscription.id, status: callout.subscription.status ?? 'Cancelled' })];
    }
    return []; // callout we don't act on
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(cursor: Cursor): Promise<OpenFailuresPage> {
    // Invoices in `Posted` with an open balance are the reconciliation truth source.
    const res = await this.client.get('/v1/invoices', {
      status: 'Posted',
      pageSize: 100,
      pageToken: cursor ?? undefined,
    });
    const list = Array.isArray(res.invoices) ? (res.invoices as ZInvoice[]) : [];
    const invoices = list
      // Only invoices that still owe money are open failures.
      .filter((inv) => (inv.balance ?? inv.amount ?? 0) > 0)
      .map((inv) => this.mapInvoice(inv, toIso(inv.invoiceDate), true));
    return { invoices, nextCursor: tokenFromNextPage(res.nextPage) };
  }

  // ── co-drive: charge ───────────────────────────────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    // Create a Payment applied to the invoice against the stored payment method. The
    // amount is sent in decimal MAJOR units. Token-only — never a PAN (SAQ-A).
    const { body, idempotentReplay } = await this.client.post(
      '/v1/payments',
      {
        amount: minorToMajor(invoice.amount.amount),
        currency: invoice.amount.currency,
        invoiceId: invoice.processorRef,
        paymentMethodId: method.token,
      },
      idempotencyKey,
    );

    // ENVELOPE ASSUMPTION: Zuora returns `{ success, id, status, gatewayResponse,
    // gatewayResponseCode }` (field casing varies by API surface — we read both). A
    // request-level rejection (`success: false` with reasons) is an INFRA/VALIDATION
    // error → THROW so the saga retries. A gateway decline is `success: true` with the
    // Payment left in an `Error` status → an expected DECLINE outcome.
    const success = pick(body, 'success', 'Success');
    if (success === false) {
      throw new ZuoraError(200, body as { reasons?: { message?: string }[] }, JSON.stringify(body));
    }
    const status = String(pick(body, 'status', 'Status') ?? '');
    const gatewayResponse =
      (pick(body, 'gatewayResponse', 'GatewayResponse') as string | undefined) ??
      (pick(body, 'gatewayResponseCode', 'GatewayResponseCode') as string | undefined);
    const outcome: ChargeResult['outcome'] =
      status === 'Processed'
        ? 'succeeded'
        : status === 'Error' || status === 'Declined'
          ? 'failed'
          : 'pending';

    const attempt = this.buildAttempt({
      invoiceId: invoice.id,
      paymentMethodId: method.id,
      idempotencyKey,
      amount: invoice.amount,
      status: outcome,
      declineCode: outcome === 'failed' ? mapZuoraDeclineCode(gatewayResponse) : undefined,
      txnId: pick(body, 'id', 'Id') as string | undefined,
      attemptedAt: new Date().toISOString(),
    });
    return { attempt, outcome, idempotentReplay };
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    // No AX10M-drivable Account Updater on this integration — nothing to fetch/apply.
    return null;
  }

  async listPaymentMethods(_customer: Customer): Promise<PaymentMethod[]> {
    // Not enumerated on this integration (capability listPaymentMethods=false). Zuora
    // exposes GET /v1/payment-methods?accountId=… — wire it if the capability is
    // promoted. Returning [] keeps the contract honest with the advertised matrix.
    return [];
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: Zuora dunning / payment-retry is TENANT-CONFIG-level (Payment Runs +
    // retry rules), not a per-subscription API toggle. We coordinate by configuration,
    // not by an API call here (capability pauseNativeDunning=false).
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  private mapInvoice(inv: ZInvoice, occurredAt: string, failed: boolean): Invoice {
    const ref = inv.id ?? '';
    return {
      id: `ax10m_inv_${ref}`,
      customerId: inv.accountId ? `ax10m_cus_${inv.accountId}` : '',
      merchantId: this.config.merchantId,
      processorRef: ref,
      amount: { amount: majorToMinor(inv.balance ?? inv.amount), currency: inv.currency ?? 'USD' },
      status: mapInvoiceStatus(inv.status),
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: toIso(inv.invoiceDate),
    };
  }

  private mapCalloutInvoice(callout: ZCallout, occurredAt: string, failed: boolean): Invoice {
    const inv = callout.invoice ?? {};
    const ref = inv.id ?? '';
    return {
      id: `ax10m_inv_${ref}`,
      customerId: inv.accountId ? `ax10m_cus_${inv.accountId}` : '',
      merchantId: this.config.merchantId,
      processorRef: ref,
      amount: { amount: majorToMinor(inv.balance ?? inv.amount), currency: inv.currency ?? 'USD' },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: toIso(inv.invoiceDate ?? callout.eventTime),
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
      attemptNumber: 1, // attempt count is tracked by the recovery-case service, not the adapter
      attemptedAt: p.attemptedAt,
    };
  }

  private buildDecline(callout: ZCallout, invoiceId: string, chargeAttemptId: string, occurredAt: string): DeclineEvent {
    const raw = callout.payment?.gatewayResponse ?? callout.payment?.gatewayResponseCode;
    const code = mapZuoraDeclineCode(raw);
    return {
      id: `ax10m_dec_${callout.payment?.id ?? invoiceId}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason: raw,
      occurredAt,
    };
  }
}

/** Pull the `pageToken` (or `page`) value out of a Zuora `nextPage` link, if present. */
function tokenFromNextPage(nextPage: unknown): Cursor {
  if (typeof nextPage !== 'string' || !nextPage) return null;
  const m = nextPage.match(/[?&](?:pageToken|page)=([^&]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

function mapInvoiceStatus(status: string | undefined): Invoice['status'] {
  switch (status) {
    case 'Paid':
      return 'paid';
    case 'Canceled':
    case 'Cancelled':
      return 'void';
    case 'Error':
      return 'uncollectible';
    case 'Posted':
    case 'Draft':
      return 'open';
    default:
      return 'open';
  }
}
