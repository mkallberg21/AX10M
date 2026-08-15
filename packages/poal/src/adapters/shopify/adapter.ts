/**
 * Shopify processor adapter — CO-DRIVE (Shopify Subscriptions, ecommerce platform).
 *
 * NOTE (co-drive): AX10M does NOT hold the card. `attemptCharge` TRIGGERS a
 * subscription billing attempt through the Admin GraphQL API; Shopify's own billing
 * pipeline and its configured gateway (Shopify Payments / a third-party gateway)
 * perform the ACTUAL charge. Endpoint path and field names are modeled on the
 * documented Admin API version (default 2024-07) and MUST be confirmed against the
 * pinned version — the MECHANISM (fail-closed HMAC verify, idempotency-key
 * pass-through, pending-vs-failed, token-only) is the deliverable.
 *
 * End-to-end against the Admin GraphQL API + signed webhooks:
 *  - ingestWebhook   — verify the X-Shopify-Hmac-Sha256 header (fail closed),
 *                      normalize subscription_billing_attempts/{failure,success}
 *                      and orders/paid into canonical events.
 *  - listOpenFailures— reconciliation poll over subscriptionBillingAttempts. Left as
 *                      a documented stub (see the method) — Shopify's billing-attempt
 *                      list is app-scoped and the exact filter shape is version-gated.
 *  - attemptCharge   — subscriptionBillingAttemptCreate against the subscription
 *                      contract gid, carrying an idempotencyKey. Because the charge is
 *                      performed asynchronously by Shopify's gateway, a submitted
 *                      attempt with no synchronous error resolves to `pending`; the
 *                      real outcome arrives later via webhook.
 *  - fetchUpdatedCard— null: Shopify owns the payment method vault (no AU hook here).
 *  - listPaymentMethods — []: Shopify holds the stored methods; we never see them.
 *  - pauseNativeDunning — no-op: the Shopify subscription app owns dunning.
 *
 * Hard rules: we hold only Shopify gids / tokens, never a PAN (SAQ-A).
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
import { ShopifyClient, type FetchLike } from './client.js';
import { mapShopifyDeclineCode, verifyShopifyHmac } from './decline-map.js';

export interface ShopifyAdapterConfig {
  /** Shop subdomain: <shop>.myshopify.com. */
  shop: string;
  /** Admin API access token (X-Shopify-Access-Token). Injected, never hardcoded. */
  accessToken: string;
  /** App API secret — the key Shopify signs its webhook HMAC with. */
  apiSecret: string;
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Admin API version. Defaults to '2024-07'. */
  apiVersion?: string;
  /** Injectable transport for testing. */
  fetch?: FetchLike;
  /** Override base URL (tests / regions). */
  baseUrl?: string;
}

/** The `subscriptionBillingAttemptCreate` mutation. Field names per Admin API 2024-07 — confirm on pin. */
const BILLING_ATTEMPT_CREATE = /* GraphQL */ `
  mutation subscriptionBillingAttemptCreate($subscriptionContractId: ID!, $input: SubscriptionBillingAttemptInput!) {
    subscriptionBillingAttemptCreate(subscriptionContractId: $subscriptionContractId, subscriptionBillingAttemptInput: $input) {
      subscriptionBillingAttempt {
        id
        ready
        errorMessage
        errorCode
        transactions(first: 1) { edges { node { id status } } }
      }
      userErrors { field message }
    }
  }
`;

/** Contact lookup: the billing-attempt webhook carries the contract id but no contact, so we
 *  read the contract's customer email/phone. Uses the non-deprecated Customer.defaultEmailAddress
 *  / defaultPhoneNumber accessors (the flat Customer.email/phone are deprecated in the current
 *  Admin GraphQL — validated against shopify.dev, 2026-08). */
const SUBSCRIPTION_CONTRACT_CUSTOMER = /* GraphQL */ `
  query subscriptionContractCustomer($id: ID!) {
    subscriptionContract(id: $id) {
      customer {
        defaultEmailAddress { emailAddress }
        defaultPhoneNumber { phoneNumber }
      }
    }
  }
`;

/** Shapes of the Shopify GraphQL JSON we read (only the fields we use). */
interface ShopifyUserError {
  field?: string[] | null;
  message?: string;
}
interface ShopifyTransactionNode {
  id?: string;
  status?: string; // SUCCESS | FAILURE | PENDING | ...
}
interface ShopifyBillingAttempt {
  id?: string;
  ready?: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  transactions?: { edges?: Array<{ node?: ShopifyTransactionNode }> };
}
interface BillingAttemptCreatePayload {
  subscriptionBillingAttempt?: ShopifyBillingAttempt | null;
  userErrors?: ShopifyUserError[];
}

/** Shape of the webhook JSON bodies we normalize (subscription billing attempts / orders). */
interface ShopifyWebhookPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  subscription_contract_id?: number | string;
  order_id?: number | string;
  amount?: string; // major-unit decimal string
  currency?: string;
  error_code?: string;
  error_message?: string;
  // orders/paid shape:
  total_price?: string;
  customer?: { id?: number | string };
  created_at?: string;
}

/** Convert a Shopify major-unit decimal string (e.g. "149.00") to integer minor units (14900). */
function toMinorUnits(major: string | undefined): number {
  if (!major) return 0;
  const n = Number(major);
  if (!Number.isFinite(n)) return 0;
  // Shopify amounts are decimal strings in the store currency's major unit; round to
  // the nearest cent to avoid float drift (assumes 2-minor-digit currencies — the
  // common case; zero/three-decimal currencies would need a per-currency exponent).
  return Math.round(n * 100);
}

/** Case-insensitive header lookup (proxies vary the casing of X-Shopify-* headers). */
function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export class ShopifyAdapter implements ProcessorAdapter {
  readonly id = 'shopify';
  private readonly client: ShopifyClient;

  constructor(private readonly config: ShopifyAdapterConfig) {
    this.client = new ShopifyClient({
      shop: config.shop,
      accessToken: config.accessToken,
      apiVersion: config.apiVersion,
      fetch: config.fetch,
      baseUrl: config.baseUrl,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      // co-drive: we trigger the billing attempt, Shopify's gateway performs the charge.
      integrationMode: 'co-drive',
      externalRetryControl: true, // we can trigger subscriptionBillingAttemptCreate
      accountUpdater: true, // Shopify Payments refreshes network tokens behind the vault
      networkTokens: true, // held by Shopify; we never see the PAN
      partialCapture: false, // a billing attempt collects the contract's due amount
      pauseNativeDunning: false, // the Shopify subscription app owns dunning, not us
      webhooks: true,
      listPaymentMethods: false, // Shopify holds the stored methods
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    this.verifyWebhookHmac(raw);
    const topic = headerLookup(raw.headers, 'x-shopify-topic') ?? '';
    let payload: ShopifyWebhookPayload;
    try {
      payload = JSON.parse(raw.body);
    } catch {
      throw new Error('ShopifyAdapter.ingestWebhook: body is not valid JSON');
    }

    const eventId = String(payload.admin_graphql_api_id ?? payload.id ?? '');
    const occurredAt = payload.created_at ?? new Date(0).toISOString();
    const base = {
      id: `ax10m_evt_${eventId}`,
      merchantId: this.config.merchantId,
      processorEventId: eventId,
      occurredAt,
    };

    switch (topic) {
      case 'subscription_billing_attempts/failure': {
        const invoice = this.mapWebhookInvoice(payload, occurredAt, /*failed*/ true);
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: '',
          idempotencyKey: '',
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapShopifyDeclineCode(payload.error_code),
          txnId: eventId,
          attemptedAt: occurredAt,
        });
        const decline = this.buildDecline(payload, invoice.id, attempt.id, occurredAt);
        // Enrich contact for the dunning channels — the billing-attempt webhook carries no
        // email/phone, so read them from the subscription contract's customer (best-effort;
        // an enrichment failure yields no contact, never a dropped event).
        const contact = await this.fetchContractContact(invoice.processorRef);
        const customer = customerFromInvoice(invoice, contactOverrides(contact?.email, contact?.phone));
        return [{ ...base, type: 'invoice.failed', payload: { invoice, attempt, decline, customer } }];
      }
      case 'subscription_billing_attempts/success':
      case 'orders/paid': {
        const invoice = this.mapWebhookInvoice(payload, occurredAt, false);
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: '',
          idempotencyKey: '',
          amount: invoice.amount,
          status: 'succeeded',
          txnId: eventId,
          attemptedAt: occurredAt,
        });
        return [{ ...base, type: 'invoice.paid', payload: { invoice, attempt } }];
      }
      default:
        return []; // topic we don't act on
    }
  }

  /**
   * Best-effort contact enrichment: fetch the subscription contract's customer email/phone
   * (the billing-attempt webhook carries neither). A missing/failed lookup returns null so the
   * recovery event still emits — enrichment must never break ingestion. Shopify stores the phone
   * in E.164, which flows through contactOverrides/toE164 unchanged.
   */
  private async fetchContractContact(contractGid: string): Promise<{ email?: string; phone?: string } | null> {
    if (!contractGid.startsWith('gid://')) return null; // no contract gid → nothing to look up
    try {
      const data = await this.client.graphql(SUBSCRIPTION_CONTRACT_CUSTOMER, { id: contractGid });
      const customer = (data.subscriptionContract as
        | { customer?: { defaultEmailAddress?: { emailAddress?: string }; defaultPhoneNumber?: { phoneNumber?: string } } }
        | undefined)?.customer;
      if (!customer) return null;
      // Shopify's phoneNumber may not be E.164; contactOverrides/toE164 drops it if it isn't.
      return { email: customer.defaultEmailAddress?.emailAddress, phone: customer.defaultPhoneNumber?.phoneNumber };
    } catch {
      return null;
    }
  }

  /**
   * Shopify signs webhooks with `X-Shopify-Hmac-Sha256` = base64 HMAC-SHA256 of the
   * RAW body keyed by the app API secret. Fail CLOSED: refuse to process when no
   * secret is configured, rather than accepting a forged (unverified) payload.
   */
  private verifyWebhookHmac(raw: RawWebhook): void {
    if (!this.config.apiSecret) {
      throw new Error('ShopifyAdapter.ingestWebhook: apiSecret not configured — refusing unverified webhook');
    }
    const signature = headerLookup(raw.headers, 'x-shopify-hmac-sha256');
    if (!verifyShopifyHmac(raw.body, signature, this.config.apiSecret)) {
      throw new Error('ShopifyAdapter.ingestWebhook: X-Shopify-Hmac-Sha256 verification failed');
    }
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(_cursor: Cursor): Promise<OpenFailuresPage> {
    // Shopify has no cross-shop "list failed invoices" endpoint: billing attempts are
    // enumerated per subscription contract, and the failure filter is version-gated.
    // The production reconciliation query is a paged `subscriptionBillingAttempts`
    // scan filtered to unsuccessful attempts, e.g.:
    //   query { subscriptionBillingAttempts(first: 100, after: $cursor, query: "success:false") {
    //     edges { cursor node { id ready errorCode subscriptionContract { id } } }
    //     pageInfo { hasNextPage }
    //   } }
    // Kept as a documented stub (returns empty) until the contract-scoped query is
    // wired; webhooks (subscription_billing_attempts/failure) are the primary signal.
    return { invoices: [], nextCursor: null };
  }

  // ── co-drive: trigger a billing attempt ──────────────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    // The subscription contract id is a Shopify gid (gid://shopify/SubscriptionContract/...);
    // we carry it as invoice.processorRef. AX10M does NOT pass a card — Shopify charges
    // the method stored on the contract.
    const data = await this.client.graphql(BILLING_ATTEMPT_CREATE, {
      subscriptionContractId: invoice.processorRef,
      input: { idempotencyKey }, // pass the deterministic key through for exactly-once
    });
    const result = (data.subscriptionBillingAttemptCreate as BillingAttemptCreatePayload | undefined) ?? {};

    // userErrors → a validation problem with the request (bad contract, wrong state):
    // surface as a THROW so the saga can fix/retry, NOT a decline.
    const userErrors = result.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(
        `ShopifyAdapter.attemptCharge: userErrors — ${userErrors.map((e) => e.message ?? 'unknown').join('; ')}`,
      );
    }

    const attempt = result.subscriptionBillingAttempt;
    if (!attempt) {
      throw new Error('ShopifyAdapter.attemptCharge: no billing attempt returned');
    }

    // A synchronous gateway decline: errorCode present → 'failed' with a mapped code.
    if (attempt.errorCode) {
      const built = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: 'failed',
        declineCode: mapShopifyDeclineCode(attempt.errorCode),
        txnId: attempt.id,
        attemptedAt: new Date().toISOString(),
      });
      return { attempt: built, outcome: 'failed', idempotentReplay: false };
    }

    // A completed successful attempt carries a SUCCESS transaction → 'succeeded'.
    const txnStatus = attempt.transactions?.edges?.[0]?.node?.status;
    if (attempt.ready === true && txnStatus === 'SUCCESS') {
      const built = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: 'succeeded',
        txnId: attempt.id,
        attemptedAt: new Date().toISOString(),
      });
      return { attempt: built, outcome: 'succeeded', idempotentReplay: false };
    }

    // ready=false and no error → the charge is in flight; the true outcome arrives
    // asynchronously via the subscription_billing_attempts/{success,failure} webhook.
    const built = this.buildAttempt({
      invoiceId: invoice.id,
      paymentMethodId: method.id,
      idempotencyKey,
      amount: invoice.amount,
      status: 'pending',
      txnId: attempt.id ?? idempotencyKey,
      attemptedAt: new Date().toISOString(),
    });
    return { attempt: built, outcome: 'pending', idempotentReplay: false };
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    return null; // Shopify owns the vault + Account Updater; no card is exposed to us
  }

  async listPaymentMethods(_customer: Customer): Promise<PaymentMethod[]> {
    return []; // Shopify holds the stored payment methods; we never see them (SAQ-A)
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op: the Shopify subscription app owns the dunning schedule; there is no
    // AX10M-side toggle. We co-drive by triggering our own billing attempts.
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  private mapWebhookInvoice(payload: ShopifyWebhookPayload, occurredAt: string, failed: boolean): Invoice {
    const currency = payload.currency ?? 'USD';
    const amount = toMinorUnits(payload.amount ?? payload.total_price);
    // The subscription contract gid is the round-trip ref for a billing attempt.
    const contractRef = payload.subscription_contract_id
      ? `gid://shopify/SubscriptionContract/${payload.subscription_contract_id}`
      : String(payload.admin_graphql_api_id ?? payload.id ?? '');
    return {
      id: `ax10m_inv_${String(payload.id ?? '')}`,
      subscriptionId: payload.subscription_contract_id ? `ax10m_sub_${payload.subscription_contract_id}` : undefined,
      customerId: payload.customer?.id ? `ax10m_cus_${payload.customer.id}` : '',
      merchantId: this.config.merchantId,
      processorRef: contractRef,
      amount: { amount, currency },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: payload.created_at ?? occurredAt,
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

  private buildDecline(payload: ShopifyWebhookPayload, invoiceId: string, chargeAttemptId: string, occurredAt: string): DeclineEvent {
    const code = mapShopifyDeclineCode(payload.error_code);
    return {
      id: `ax10m_dec_${String(payload.id ?? invoiceId)}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason: payload.error_message ?? payload.error_code,
      occurredAt,
    };
  }
}
