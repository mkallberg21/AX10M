/**
 * The Payment Orchestration Abstraction Layer (POAL).
 *
 * The single most important architectural decision for "works with any billing
 * system" (ARCHITECTURE.md §4.1). Every processor is wrapped in an adapter that
 * implements the narrow `ProcessorAdapter` interface below; everything upstream
 * of the decision core speaks the canonical schema (@ax10m/canonical), so the core
 * never knows which processor it is driving.
 *
 * Capability-gated: not every processor supports external retry control, Account
 * Updater, or partial capture. Adapters advertise a `CapabilityMatrix`; the core
 * degrades to advisory mode when it cannot drive a capability directly.
 */

import type {
  CanonicalEvent,
  ChargeAttempt,
  Customer,
  Invoice,
  PaymentMethod,
  Subscription,
} from '@ax10m/canonical';

/**
 * How much of the recovery loop this processor lets AX10M own (PROCESSORS.md §1):
 *  - 'drive'    — we re-attempt the charge on our own schedule against a token/mandate.
 *  - 'co-drive' — we drive some recovery but must coordinate with / disable the
 *                 processor's own retry engine to avoid double-charging.
 *  - 'advisory' — the platform owns the token and retry loop (Merchant-of-Record,
 *                 app-store IAP). We measure failure/recovery and recommend/prompt
 *                 out-of-band actions, but cannot trigger the charge.
 */
export type IntegrationMode = 'drive' | 'co-drive' | 'advisory';

/**
 * What a processor can do. The decision core reads this to decide whether it can
 * drive an action directly or must fall back to advisory mode.
 */
export interface CapabilityMatrix {
  /** Overall integration posture — the headline of the capability set. */
  integrationMode: IntegrationMode;
  /** Can we trigger charge attempts ourselves (vs. only observe)? */
  externalRetryControl: boolean;
  /** Card Account Updater / network-token auto-refresh available? */
  accountUpdater: boolean;
  /** Network tokenization supported for stored methods? */
  networkTokens: boolean;
  /** Can we capture a partial/negotiated amount? */
  partialCapture: boolean;
  /** Can we pause the processor's native dunning to take control? */
  pauseNativeDunning: boolean;
  /** Real-time webhooks available (vs. polling-only)? */
  webhooks: boolean;
  /** Can we enumerate a customer's stored payment methods? */
  listPaymentMethods: boolean;
}

/** Result of an `attemptCharge` call, normalized across processors. */
export interface ChargeResult {
  /** The canonical charge attempt record produced by this call. */
  attempt: ChargeAttempt;
  outcome: 'succeeded' | 'failed' | 'pending';
  /** True if the processor recognized the idempotency key and returned a prior
   *  result rather than performing a new charge. Critical for exactly-once. */
  idempotentReplay: boolean;
}

/** Opaque, processor-defined pagination cursor for reconciliation polls. */
export type Cursor = string | null;

/** A page of open failures plus the cursor to continue from. */
export interface OpenFailuresPage {
  invoices: Invoice[];
  nextCursor: Cursor;
}

/**
 * Raw inbound webhook, pre-normalization. Adapters verify the signature against
 * the shared secret before trusting `body`.
 */
export interface RawWebhook {
  /** Raw request body bytes/string, needed for signature verification. */
  body: string;
  headers: Record<string, string>;
}

/**
 * The narrow interface every processor adapter implements. Kept intentionally
 * small — this is the contract the whole platform is billing-agnostic through.
 */
export interface ProcessorAdapter {
  /** Stable processor id, e.g. "stripe". */
  readonly id: string;

  /**
   * Verify + normalize a native webhook into zero or more canonical events.
   * MUST be side-effect free beyond signature verification: persistence and
   * dedupe happen downstream keyed on `CanonicalEvent.processorEventId`.
   */
  ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]>;

  /**
   * Reconciliation poll — the truth source. Webhooks lie/drop; this guarantees
   * we never miss or double-count a failure (ARCHITECTURE.md §4.1).
   */
  listOpenFailures(cursor: Cursor): Promise<OpenFailuresPage>;

  /**
   * Attempt to charge an invoice against a payment method. The idempotency key
   * MUST be deterministic for the (invoice, method, attempt) tuple so retries
   * under partition never double-charge (ARCHITECTURE.md §4.3, §9).
   */
  attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult>;

  /**
   * Fetch an updated card via Account Updater / network token, if the processor
   * supports it and a newer card exists. Returns null when nothing changed.
   */
  fetchUpdatedCard(method: PaymentMethod): Promise<PaymentMethod | null>;

  /** Enumerate a customer's stored (tokenized) payment methods. */
  listPaymentMethods(customer: Customer): Promise<PaymentMethod[]>;

  /** Pause the processor's native dunning so AX10M can take control. */
  pauseNativeDunning(subscription: Subscription): Promise<void>;

  /** Advertise what this processor supports. */
  capabilities(): CapabilityMatrix;
}
