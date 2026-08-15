/**
 * Recurly processor adapter — CO-DRIVE (PROCESSORS.md §3, ARCHITECTURE.md §4.1).
 *
 * NOTE: the endpoint paths and JSON field names below are modeled on Recurly's
 * documented v3 REST API (Accept: application/vnd.recurly.v2021-02-25) and MUST be
 * re-confirmed against the live API version before production — treat them as the
 * plausible shape, not gospel. The load-bearing MECHANISM is real and is the
 * deliverable: a deterministic `Idempotency-Key`, fail-closed Basic-auth webhook
 * verification, token-only (never a PAN → SAQ-A), and the decline-vs-error split (a
 * 422 transaction error is an expected OUTCOME; an infra/auth failure THROWS).
 *
 * CO-DRIVE: Recurly runs its own dunning campaigns. In Phase 0 shadow mode we leave
 * them ON as the measured baseline; taking control means coordinating with / pausing
 * that native dunning so we never double-collect.
 *
 * End-to-end against Recurly v3:
 *  - ingestWebhook   — verify the webhook's HTTP Basic auth (Recurly optionally
 *                      authenticates its notification endpoint with Basic auth),
 *                      then normalize failed/successful payment + canceled
 *                      subscription notifications. Recurly notifications are XML;
 *                      a real impl uses an XML parser (see parseRecurlyNotification).
 *  - listOpenFailures— reconciliation poll over invoices in `past_due`.
 *  - attemptCharge   — PUT /invoices/{id}/collect against the account's stored
 *                      billing info (token, never a PAN → SAQ-A).
 *  - fetchUpdatedCard— null: Recurly Account Updater refreshes billing_info
 *                      server-side, so the next collect already uses the freshest card.
 *  - listPaymentMethods — enumerate an account's tokenized billing_infos.
 *  - pauseNativeDunning — see method note (Recurly dunning is campaign-level).
 *
 * Hard rule: we hold only Recurly tokens / ids, never a PAN.
 */

import { timingSafeEqual } from 'node:crypto';
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
import { RecurlyClient, RecurlyError, type FetchLike } from './client.js';
import { mapRecurlyDeclineCode } from './decline-map.js';

export interface RecurlyAdapterConfig {
  /** Recurly API key (Basic-auth username, empty password). Injected, never hardcoded. */
  apiKey: string;
  /** AX10M-internal merchant id this adapter instance serves (stamped on canonical events). */
  merchantId: string;
  /** Basic-auth credentials Recurly sends ON its webhook endpoint (configured in Recurly). */
  webhookUser?: string;
  webhookPassword?: string;
  /** Injectable transport for testing. */
  fetch?: FetchLike;
  /** Override base URL (tests / regions). Defaults to https://v3.recurly.com. */
  baseUrl?: string;
}

/** Shapes of the Recurly JSON we read (only the fields we use). */
interface RlTransaction {
  id?: string;
  uuid?: string;
  status?: string; // success | declined | error | void | ...
  error_code?: string;
  decline_code?: string;
  error_message?: string;
  amount?: number; // v3 decimal major
  amount_in_cents?: number; // v2 minor
  currency?: string;
  created_at?: string;
}
interface RlInvoice {
  id?: string;
  uuid?: string;
  number?: string;
  state?: string; // open | past_due | paid | processing | failed | ...
  currency?: string;
  total?: number; // v3 decimal major
  balance?: number; // v3 decimal major
  total_in_cents?: number; // v2 minor
  balance_in_cents?: number; // v2 minor
  account?: { id?: string; code?: string };
  subscription_ids?: string[];
  created_at?: string;
  updated_at?: string;
  transactions?: RlTransaction[];
}
interface RlBillingInfo {
  id?: string;
  account_id?: string;
  payment_method?: {
    card_type?: string;
    first_six?: string;
    last_four?: string;
    exp_month?: number;
    exp_year?: number;
    gateway_token?: string;
    account_type?: string;
  };
}

const toCents = (major: number | undefined): number | undefined =>
  typeof major === 'number' ? Math.round(major * 100) : undefined;

/** Recurly v3 uses decimal-major amounts; v2 used `_in_cents`. We support both. */
function invoiceCents(inv: RlInvoice): number {
  return inv.balance_in_cents ?? inv.total_in_cents ?? toCents(inv.balance) ?? toCents(inv.total) ?? 0;
}

function toIso(value: string | undefined): string {
  if (!value) return new Date(0).toISOString();
  const t = Date.parse(value);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

/** The last transaction on an invoice carries the most recent gateway result. */
function lastTransaction(inv: RlInvoice): RlTransaction | undefined {
  const txns = inv.transactions ?? [];
  return txns.length ? txns[txns.length - 1] : undefined;
}

/** Case-insensitive header lookup (webhook header casing varies by proxy). */
function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Normalized shape we pull out of a (JSON or XML) Recurly notification. */
interface RlNotification {
  type: string;
  invoiceId?: string;
  subscriptionId?: string;
  accountCode?: string;
  accountEmail?: string; // modeled on Recurly webhook — CONFIRM (notification <account> block carries <email>; phone is not reliably present)
  currency?: string;
  amountInCents?: number;
  transactionErrorCode?: string;
  transactionId?: string;
  transactionStatus?: string;
  rawReason?: string;
  occurredAt?: string;
}

function firstMatch(body: string, re: RegExp): string | undefined {
  return body.match(re)?.[1]?.trim() || undefined;
}

/**
 * Parse a Recurly notification into a minimal normalized shape.
 *
 * Recurly notifications are XML; if the body happens to parse as JSON we read it
 * directly, otherwise we extract just the fields we need via simple regex. A real
 * production impl uses a proper XML parser — this keeps the dependency surface at
 * zero while proving the MECHANISM. The XML root element name IS the notification
 * type (e.g. `<failed_payment_notification>`).
 */
export function parseRecurlyNotification(body: string): RlNotification | null {
  const trimmed = body.trim();
  // JSON branch (some setups POST a JSON transform of the notification).
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as {
        type?: string;
        event_type?: string;
        invoice?: { uuid?: string; id?: string; number?: string; currency?: string; total_in_cents?: number; balance_in_cents?: number };
        transaction?: { id?: string; uuid?: string; status?: string; error_code?: string; decline_code?: string; message?: string };
        subscription?: { uuid?: string; id?: string };
        account?: { account_code?: string; code?: string; email?: string };
        occurred_at?: string;
      };
      const type = j.type ?? j.event_type ?? '';
      if (!type) return null;
      return {
        type,
        invoiceId: j.invoice?.uuid ?? j.invoice?.id ?? j.invoice?.number,
        subscriptionId: j.subscription?.uuid ?? j.subscription?.id,
        accountCode: j.account?.account_code ?? j.account?.code,
        accountEmail: j.account?.email,
        currency: j.invoice?.currency,
        amountInCents: j.invoice?.balance_in_cents ?? j.invoice?.total_in_cents,
        transactionErrorCode: j.transaction?.error_code ?? j.transaction?.decline_code,
        transactionId: j.transaction?.uuid ?? j.transaction?.id,
        transactionStatus: j.transaction?.status,
        rawReason: j.transaction?.message ?? j.transaction?.error_code,
        occurredAt: j.occurred_at,
      };
    } catch {
      return null;
    }
  }
  // XML branch — extract the notification type (root element) and the fields we use.
  const type = firstMatch(trimmed, /<\s*([a-z_]+_notification)\b/i);
  if (!type) return null;
  const invoiceBlock = firstMatch(trimmed, /<invoice>([\s\S]*?)<\/invoice>/i) ?? '';
  const txnBlock = firstMatch(trimmed, /<transaction>([\s\S]*?)<\/transaction>/i) ?? '';
  return {
    type,
    invoiceId: firstMatch(invoiceBlock, /<uuid>([^<]+)<\/uuid>/i) ?? firstMatch(invoiceBlock, /<invoice_number(?:[^>]*)>([^<]+)<\/invoice_number>/i),
    subscriptionId: firstMatch(trimmed, /<subscription>[\s\S]*?<uuid>([^<]+)<\/uuid>/i),
    accountCode: firstMatch(trimmed, /<account>[\s\S]*?<account_code>([^<]+)<\/account_code>/i),
    accountEmail: firstMatch(trimmed, /<account>[\s\S]*?<email>([^<]+)<\/email>/i),
    currency: firstMatch(invoiceBlock, /<currency>([^<]+)<\/currency>/i),
    amountInCents: Number(firstMatch(invoiceBlock, /<total_in_cents(?:[^>]*)>([^<]+)<\/total_in_cents>/i)) || undefined,
    transactionErrorCode: firstMatch(txnBlock, /<error_code(?:[^>]*)>([^<]+)<\/error_code>/i),
    transactionId: firstMatch(txnBlock, /<uuid>([^<]+)<\/uuid>/i) ?? firstMatch(txnBlock, /<id(?:[^>]*)>([^<]+)<\/id>/i),
    transactionStatus: firstMatch(txnBlock, /<status>([^<]+)<\/status>/i),
    rawReason: firstMatch(txnBlock, /<message>([^<]+)<\/message>/i) ?? firstMatch(txnBlock, /<error_code(?:[^>]*)>([^<]+)<\/error_code>/i),
  };
}

/** Pull the Recurly `cursor` value out of a `next` list link, if present. */
function cursorFromNext(next: unknown): Cursor {
  if (typeof next !== 'string' || !next) return null;
  const m = next.match(/[?&]cursor=([^&]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export class RecurlyAdapter implements ProcessorAdapter {
  readonly id = 'recurly';
  private readonly client: RecurlyClient;

  constructor(private readonly config: RecurlyAdapterConfig) {
    this.client = new RecurlyClient({
      apiKey: config.apiKey,
      fetch: config.fetch,
      baseUrl: config.baseUrl,
    });
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive',
      externalRetryControl: true,
      accountUpdater: true, // Recurly Account Updater refreshes billing_info server-side
      networkTokens: true,
      partialCapture: false, // collect settles the invoice balance, not a negotiated partial
      pauseNativeDunning: true, // dunning campaigns can be disabled to take control
      webhooks: true,
      listPaymentMethods: true,
    };
  }

  // ── ingress ────────────────────────────────────────────────────────────────

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    this.verifyWebhookAuth(raw.headers);
    const note = parseRecurlyNotification(raw.body);
    if (!note) return [];
    const occurredAt = toIso(note.occurredAt);

    const envelope = <T>(type: CanonicalEvent['type'], payload: T): CanonicalEvent<T> => ({
      id: `ax10m_evt_${note.transactionId ?? note.invoiceId ?? note.type}`,
      type,
      merchantId: this.config.merchantId,
      processorEventId: note.transactionId ?? note.invoiceId ?? '',
      occurredAt,
      payload,
    });

    switch (note.type) {
      case 'failed_payment_notification':
      case 'failed_charge': {
        const invoice = this.mapNotificationInvoice(note, occurredAt, /*failed*/ true);
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: '',
          idempotencyKey: '',
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapRecurlyDeclineCode(note.transactionErrorCode),
          txnId: note.transactionId,
          attemptedAt: occurredAt,
        });
        const decline = this.buildDecline(note, invoice.id, attempt.id, occurredAt);
        // Recurly's notification <account> block carries the customer email (feeds the
        // email dunning channel); it does NOT reliably carry a phone, so pass undefined
        // rather than fabricate a country code.
        const customer = customerFromInvoice(invoice, contactOverrides(note.accountEmail, undefined));
        return [envelope('invoice.failed', { invoice, attempt, decline, customer })];
      }
      case 'successful_payment_notification':
      case 'paid_charge': {
        const invoice = this.mapNotificationInvoice(note, occurredAt, false);
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: '',
          idempotencyKey: '',
          amount: invoice.amount,
          status: 'succeeded',
          txnId: note.transactionId,
          attemptedAt: occurredAt,
        });
        return [envelope('invoice.paid', { invoice, attempt })];
      }
      case 'canceled_subscription_notification': {
        if (!note.subscriptionId) return [];
        return [envelope('subscription.updated', { processorRef: note.subscriptionId, status: 'canceled' })];
      }
      default:
        return []; // notification we don't act on
    }
  }

  /** Recurly optionally authenticates its webhook endpoint with HTTP Basic auth. */
  private verifyWebhookAuth(headers: Record<string, string>): void {
    // Fail CLOSED: refuse to process a webhook when no credentials are configured,
    // rather than accepting a forged (unauthenticated) payload.
    if (!this.config.webhookUser && !this.config.webhookPassword) {
      throw new Error('RecurlyAdapter.ingestWebhook: webhook Basic-auth credentials not configured — refusing unverified webhook');
    }
    const provided = headerLookup(headers, 'authorization') ?? '';
    const expected = `Basic ${Buffer.from(`${this.config.webhookUser ?? ''}:${this.config.webhookPassword ?? ''}`).toString('base64')}`;
    // Constant-time comparison to avoid leaking the secret via response timing.
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error('RecurlyAdapter.ingestWebhook: webhook Basic auth verification failed');
    }
  }

  // ── reconciliation poll ──────────────────────────────────────────────────────

  async listOpenFailures(cursor: Cursor): Promise<OpenFailuresPage> {
    const res = await this.client.get('/invoices', {
      state: 'past_due',
      limit: 100,
      cursor: cursor ?? undefined,
    });
    const data = Array.isArray(res.data) ? (res.data as RlInvoice[]) : [];
    const invoices = data.map((inv) => this.mapInvoice(inv, toIso(inv.updated_at ?? inv.created_at), true));
    return { invoices, nextCursor: cursorFromNext(res.next) };
  }

  // ── co-drive: charge ───────────────────────────────────────────────────────

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    try {
      // Collect the open invoice against the account's stored billing info. An empty
      // `transaction` object uses the account default; a payment_gateway/account could
      // be pinned here. Token-only — never a PAN (SAQ-A).
      const { body, idempotentReplay } = await this.client.put(
        `/invoices/${encodeURIComponent(invoice.processorRef)}/collect`,
        { transaction: {} },
        idempotencyKey,
      );
      const inv = body as RlInvoice;
      const txn = lastTransaction(inv);
      const outcome: ChargeResult['outcome'] =
        inv.state === 'paid' || txn?.status === 'success'
          ? 'succeeded'
          : txn?.status === 'declined' || txn?.status === 'error'
            ? 'failed'
            : 'pending';
      const attempt = this.buildAttempt({
        invoiceId: invoice.id,
        paymentMethodId: method.id,
        idempotencyKey,
        amount: invoice.amount,
        status: outcome,
        declineCode: outcome === 'failed' ? mapRecurlyDeclineCode(txn?.error_code ?? txn?.decline_code) : undefined,
        txnId: txn?.uuid ?? txn?.id ?? inv.uuid ?? inv.id,
        attemptedAt: txn?.created_at ? toIso(txn.created_at) : new Date().toISOString(),
      });
      return { attempt, outcome, idempotentReplay };
    } catch (err) {
      // A 422 transaction error is a DECLINE (an expected outcome), not an error.
      if (err instanceof RecurlyError && err.isPaymentFailure()) {
        const attempt = this.buildAttempt({
          invoiceId: invoice.id,
          paymentMethodId: method.id,
          idempotencyKey,
          amount: invoice.amount,
          status: 'failed',
          declineCode: mapRecurlyDeclineCode(err.declineReason()),
          txnId: err.body.transaction_error?.transaction_id,
          attemptedAt: new Date().toISOString(),
        });
        return { attempt, outcome: 'failed', idempotentReplay: false };
      }
      throw err; // infra / auth / validation error — let the saga retry
    }
  }

  async fetchUpdatedCard(_method: PaymentMethod): Promise<PaymentMethod | null> {
    // Recurly Account Updater refreshes the account's billing_info server-side, so a
    // subsequent collect already runs against the freshest credential — there is no
    // separate "updated card" for AX10M to fetch and apply.
    return null;
  }

  async listPaymentMethods(customer: Customer): Promise<PaymentMethod[]> {
    const res = await this.client.get(`/accounts/${encodeURIComponent(customer.processorRef)}/billing_infos`);
    const data = Array.isArray(res.data) ? (res.data as RlBillingInfo[]) : [];
    return data
      .filter((bi): bi is RlBillingInfo => Boolean(bi))
      .map((bi) => this.mapBillingInfo(bi, customer));
  }

  async pauseNativeDunning(_subscription: Subscription): Promise<void> {
    // No-op. Recurly dunning is DUNNING-CAMPAIGN-level (configured per plan/site), not a
    // per-subscription toggle we can flip through the public API. Taking full control
    // means assigning a no-op dunning campaign in the Recurly dashboard; in Phase 0
    // shadow mode we intentionally leave native dunning ON as the measured baseline
    // (ARCHITECTURE.md §1.2). ASSUMPTION: confirm the campaign-assignment endpoint
    // before wiring an automated pause here.
  }

  // ── mapping helpers ──────────────────────────────────────────────────────────

  private mapInvoice(inv: RlInvoice, occurredAt: string, failed: boolean): Invoice {
    const ref = inv.uuid ?? inv.id ?? inv.number ?? '';
    const accountRef = inv.account?.code ?? inv.account?.id;
    return {
      id: `ax10m_inv_${ref}`,
      subscriptionId: inv.subscription_ids?.[0] ? `ax10m_sub_${inv.subscription_ids[0]}` : undefined,
      customerId: accountRef ? `ax10m_cus_${accountRef}` : '',
      merchantId: this.config.merchantId,
      processorRef: ref,
      amount: { amount: invoiceCents(inv), currency: inv.currency ?? 'USD' },
      status: mapInvoiceState(inv.state),
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: toIso(inv.created_at),
    };
  }

  private mapNotificationInvoice(note: RlNotification, occurredAt: string, failed: boolean): Invoice {
    const ref = note.invoiceId ?? '';
    return {
      id: `ax10m_inv_${ref}`,
      subscriptionId: note.subscriptionId ? `ax10m_sub_${note.subscriptionId}` : undefined,
      customerId: note.accountCode ? `ax10m_cus_${note.accountCode}` : '',
      merchantId: this.config.merchantId,
      processorRef: ref,
      amount: { amount: note.amountInCents ?? 0, currency: note.currency ?? 'USD' },
      status: failed ? 'open' : 'paid',
      firstFailedAt: failed ? occurredAt : undefined,
      createdAt: occurredAt,
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

  private buildDecline(note: RlNotification, invoiceId: string, chargeAttemptId: string, occurredAt: string): DeclineEvent {
    const code = mapRecurlyDeclineCode(note.transactionErrorCode);
    return {
      id: `ax10m_dec_${note.transactionId ?? invoiceId}`,
      invoiceId,
      chargeAttemptId,
      code,
      family: familyOf(code),
      rawReason: note.rawReason ?? note.transactionErrorCode,
      occurredAt,
    };
  }

  private mapBillingInfo(bi: RlBillingInfo, customer: Customer): PaymentMethod {
    const pm = bi.payment_method ?? {};
    const token = pm.gateway_token ?? bi.id ?? '';
    return {
      id: `ax10m_pm_${bi.id ?? token}`,
      customerId: customer.id,
      processorRef: bi.id ?? token,
      token, // Recurly gateway token / billing_info id — no PAN
      brand: pm.card_type ?? pm.account_type,
      last4: pm.last_four,
      bin: pm.first_six,
      expMonth: pm.exp_month,
      expYear: pm.exp_year,
    };
  }
}

function mapInvoiceState(state: string | undefined): Invoice['status'] {
  switch (state) {
    case 'paid':
      return 'paid';
    case 'voided':
    case 'closed':
      return 'void';
    case 'failed':
      return 'uncollectible';
    case 'open':
    case 'past_due':
    case 'processing':
    case 'pending':
      return 'open';
    default:
      return 'open';
  }
}
