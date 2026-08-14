/**
 * The Payment Orchestration Abstraction Layer (POAL).
 *
 * The single most important architectural decision for "works with any billing
 * system" (ARCHITECTURE.md §4.1). Every processor is wrapped in an adapter that
 * implements the narrow `ProcessorAdapter` interface below; everything upstream
 * of the decision core speaks the canonical schema (@lift/canonical), so the core
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
} from '@lift/canonical';

/**
 * What a processor can do. The decision core reads this to decide whether it can
 * drive an action directly or must fall back to advisory mode.
 */
export interface CapabilityMatrix {
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

  /** Pause the processor's native dunning so Lift can take control. */
  pauseNativeDunning(subscription: Subscription): Promise<void>;

  /** Advertise what this processor supports. */
  capabilities(): CapabilityMatrix;
}
