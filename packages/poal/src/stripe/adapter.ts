/**
 * Stripe processor adapter (skeleton).
 *
 * Implements `ProcessorAdapter` against Stripe (ARCHITECTURE.md §7). This is a
 * scaffold: signature verification, canonical normalization, and API calls are
 * marked TODO(lift). The shape, capability matrix, and safety invariants are real.
 *
 * Hard rules baked into this adapter:
 *  - We NEVER store or transmit a PAN. Card updates flow through Stripe Elements
 *    / network tokens; we only ever hold Stripe tokens (SAQ-A posture).
 *  - Every charge uses a deterministic idempotency key (see ../idempotency).
 *  - Webhook bodies are verified against STRIPE_WEBHOOK_SECRET before trust.
 */

import type {
  CanonicalEvent,
  Customer,
  Invoice,
  PaymentMethod,
  Subscription,
} from '@lift/canonical';
import type {
  CapabilityMatrix,
  ChargeResult,
  Cursor,
  OpenFailuresPage,
  ProcessorAdapter,
  RawWebhook,
} from '../adapter.js';

export interface StripeAdapterConfig {
  /** Restricted, least-privilege secret key. Injected, never hardcoded. */
  secretKey: string;
  /** Webhook signing secret for signature verification. */
  webhookSecret: string;
  apiVersion?: string;
}

export class StripeAdapter implements ProcessorAdapter {
  readonly id = 'stripe';

  constructor(private readonly config: StripeAdapterConfig) {
    // TODO(lift): construct the Stripe SDK client with restricted key +
    // apiVersion, and a per-tenant Connect account context where applicable.
  }

  capabilities(): CapabilityMatrix {
    return {
      externalRetryControl: true,
      accountUpdater: true, // Stripe supports card auto-updates / network tokens
      networkTokens: true,
      partialCapture: true,
      pauseNativeDunning: true, // via Billing settings / retry schedule control
      webhooks: true,
      listPaymentMethods: true,
    };
  }

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    // TODO(lift): verify signature with stripe.webhooks.constructEvent(
    //   raw.body, raw.headers['stripe-signature'], this.config.webhookSecret).
    // Reject on failure — never trust an unverified body.
    //
    // TODO(lift): switch on event.type and normalize into canonical events:
    //   - invoice.payment_failed        → 'invoice.failed' (+ DeclineEvent)
    //   - invoice.payment_succeeded     → 'invoice.paid'
    //   - charge.failed                 → 'charge.failed'  (map decline_code via
    //                                      mapStripeDeclineCode)
    //   - charge.succeeded              → 'charge.succeeded'
    //   - payment_method.updated /
    //     payment_method.automatically_updated → 'payment_method.updated'
    //   - customer.subscription.updated → 'subscription.updated'
    // Set processorEventId = event.id for downstream dedupe + reconciliation.
    void raw;
    return [];
  }

  async listOpenFailures(cursor: Cursor): Promise<OpenFailuresPage> {
    // TODO(lift): page stripe.invoices.list({ status: 'open', collection_method:
    //   'charge_automatically', starting_after: cursor }) and map each to a
    //   canonical Invoice. This poll is the reconciliation truth source.
    void cursor;
    return { invoices: [], nextCursor: null };
  }

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    // TODO(lift): create/confirm a PaymentIntent for invoice.amount against
    //   method.token, passing { idempotencyKey } in request options. Detect an
    //   idempotent replay (Stripe returns the original object) and set
    //   idempotentReplay accordingly — this is what guarantees exactly-once.
    void invoice;
    void method;
    throw new Error(
      `TODO(lift): StripeAdapter.attemptCharge not implemented (idemKey=${idempotencyKey})`,
    );
  }

  async fetchUpdatedCard(method: PaymentMethod): Promise<PaymentMethod | null> {
    // TODO(lift): read the PaymentMethod / network token to see if the card was
    //   auto-updated (new exp / new token). Return a refreshed canonical
    //   PaymentMethod, or null if unchanged. Never expose PAN.
    void method;
    return null;
  }

  async listPaymentMethods(customer: Customer): Promise<PaymentMethod[]> {
    // TODO(lift): stripe.paymentMethods.list({ customer: customer.processorRef,
    //   type: 'card' }) → canonical PaymentMethod[] (tokens + display fields only).
    void customer;
    return [];
  }

  async pauseNativeDunning(subscription: Subscription): Promise<void> {
    // TODO(lift): disable Smart Retries / native dunning for this subscription
    //   so Lift can take control. NOTE: in Phase 0 shadow mode we deliberately
    //   do NOT pause — Smart Retries stays on and becomes the measured baseline
    //   (ARCHITECTURE.md §1.2). Only Phase 1 "take control" calls this.
    void subscription;
    throw new Error('TODO(lift): StripeAdapter.pauseNativeDunning not implemented');
  }
}
