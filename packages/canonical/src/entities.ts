/**
 * Canonical entity schema.
 *
 * Everything upstream of the decision core speaks this vocabulary, so the core
 * never knows which processor (Stripe, Adyen, Braintree, ...) produced an event.
 * Processor adapters (see @ax10m/poal) are responsible for normalizing native
 * payloads into these shapes. See ARCHITECTURE.md §4.1.
 *
 * Design notes:
 *  - We NEVER store a PAN. `PaymentMethod` carries only tokenized / display data.
 *  - All monetary amounts are integer minor units (cents) + an ISO-4217 currency,
 *    to avoid float drift in anything that touches money.
 *  - `id` fields are AX10M-internal canonical ids; `processorRef` fields hold the
 *    opaque native id so adapters can round-trip back to the processor.
 */

import type { DeclineCode, DeclineFamily } from './decline-taxonomy.js';

/** ISO-4217 currency code, e.g. "USD", "EUR". */
export type CurrencyCode = string;

/** Integer minor units (e.g. cents). Never a float. */
export type MinorUnits = number;

/** A monetary amount as integer minor units + currency. */
export interface Money {
  amount: MinorUnits;
  currency: CurrencyCode;
}

/** Identifier of the processor that owns the underlying records. */
export type ProcessorId =
  | 'stripe'
  | 'adyen'
  | 'braintree'
  | 'chargebee'
  | 'recurly'
  | 'zuora';

/**
 * MRR tier bucket. Used as a stratification key for holdout assignment so
 * control and treatment groups are comparable across value bands.
 */
export type MrrTier = 'micro' | 'small' | 'mid' | 'large' | 'enterprise';

/** Coarse issuer region, used as a stratification key. */
export type IssuerRegion = 'na' | 'emea' | 'latam' | 'apac' | 'unknown';

/** A AX10M-onboarded merchant (tenant). */
export interface Merchant {
  id: string;
  processor: ProcessorId;
  processorRef: string;
  displayName: string;
  /** Whether AX10M is actively driving recovery, or only observing (shadow). */
  mode: 'shadow' | 'active';
  createdAt: string;
}

/** An end customer of a merchant. */
export interface Customer {
  id: string;
  merchantId: string;
  processorRef: string;
  email?: string;
  /** E.164 phone (e.g. "+15555550123") — the SMS dunning channel's destination. Never a PAN. */
  phone?: string;
  /** Coarse issuer region derived from the primary payment method BIN. */
  issuerRegion: IssuerRegion;
  /** When the customer relationship started — feeds tenure features. */
  createdAt: string;
  /** Consent / contactability, enforced by the guardrail layer. */
  consent: ConsentState;
}

/** Per-channel consent + global opt-out, enforced before any comms attempt. */
export interface ConsentState {
  email: boolean;
  sms: boolean;
  whatsapp: boolean;
  push: boolean;
  /** Hard global opt-out overrides every channel. */
  globallyOptedOut: boolean;
}

/**
 * A tokenized payment method. We store ONLY non-sensitive display fields and
 * the processor token — never the PAN. See ARCHITECTURE.md §9.
 */
export interface PaymentMethod {
  id: string;
  customerId: string;
  processorRef: string;
  /** Tokenized reference (e.g. Stripe PaymentMethod id / network token id). */
  token: string;
  brand?: string;
  /** Last 4 for display only. */
  last4?: string;
  /** Issuer Identification Number (first 6-8). Used for BIN-level priors. */
  bin?: string;
  expMonth?: number;
  expYear?: number;
  /** True once refreshed via Account Updater / network token auto-update. */
  autoUpdated?: boolean;
}

/** A recurring subscription. */
export interface Subscription {
  id: string;
  customerId: string;
  merchantId: string;
  processorRef: string;
  status: 'active' | 'past_due' | 'canceled' | 'paused';
  /** Monthly recurring value of this subscription. */
  mrr: Money;
  mrrTier: MrrTier;
  currentPeriodEnd: string;
}

/** An invoice that may succeed or fail to be collected. */
export interface Invoice {
  id: string;
  subscriptionId?: string;
  customerId: string;
  merchantId: string;
  processorRef: string;
  amount: Money;
  status: 'open' | 'paid' | 'uncollectible' | 'void';
  /** First time collection failed, if it has. Anchors the recovery window. */
  firstFailedAt?: string;
  createdAt: string;
}

/** A single attempt to charge an invoice against a payment method. */
export interface ChargeAttempt {
  id: string;
  invoiceId: string;
  paymentMethodId: string;
  /** Deterministic idempotency key — guarantees exactly-once charging. */
  idempotencyKey: string;
  amount: Money;
  status: 'succeeded' | 'failed' | 'pending';
  /** Populated on failure. */
  declineCode?: DeclineCode;
  attemptNumber: number;
  attemptedAt: string;
}

/** Normalized decline event emitted by an adapter from a native failure. */
export interface DeclineEvent {
  id: string;
  invoiceId: string;
  chargeAttemptId: string;
  code: DeclineCode;
  family: DeclineFamily;
  /** Raw processor reason string, retained for audit/debugging. */
  rawReason?: string;
  occurredAt: string;
}

/**
 * The unit of work for the recovery engine and the unit of holdout assignment.
 * One case per failed invoice. See ARCHITECTURE.md §3.1 & §4.3.
 */
export interface RecoveryCase {
  id: string;
  merchantId: string;
  customerId: string;
  invoiceId: string;
  /** Holdout bucket. `control` = baseline-only; `treatment` = AX10M engine. */
  bucket: 'control' | 'treatment';
  status: 'open' | 'recovered' | 'abandoned';
  openedAt: string;
  resolvedAt?: string;
  /** Recovered amount if the case closed successfully. */
  recoveredAmount?: Money;
}

/**
 * The canonical event envelope produced by `ProcessorAdapter.ingestWebhook`.
 * A single native webhook may normalize into zero or more canonical events.
 */
export type CanonicalEventType =
  | 'invoice.failed'
  | 'invoice.paid'
  | 'charge.attempted'
  | 'charge.succeeded'
  | 'charge.failed'
  | 'payment.reversed'
  | 'payment_method.updated'
  | 'subscription.updated';

/** How a previously-collected payment was reversed — drives fee clawback on net recovery. */
export type ReversalKind = 'refund' | 'chargeback';

/**
 * Payload for `payment.reversed`: a payment we may have recovered was later refunded or charged
 * back. `invoiceId` is the canonical invoice id (`ax10m_inv_*`) linking it to the recovery;
 * `amount` is the reversed amount in minor units. Net recovery = recovered − reversed.
 */
export interface ReversalPayload {
  invoiceId: string;
  amount: MinorUnits;
  currency: CurrencyCode;
  kind: ReversalKind;
  reason?: string;
}

export interface CanonicalEvent<T = unknown> {
  id: string;
  type: CanonicalEventType;
  merchantId: string;
  /** Original processor event id, for dedupe + reconciliation. */
  processorEventId: string;
  occurredAt: string;
  payload: T;
}
