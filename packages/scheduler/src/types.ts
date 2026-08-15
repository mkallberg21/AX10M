/**
 * Scheduler ports & result types (ARCHITECTURE.md §4.3 — the durable charge path).
 *
 * The scheduler orchestrates *when* and *how many times* AX10M attempts recovery on
 * a failed invoice. It never talks to a processor directly — it drives a
 * `RecoveryCasePort`, which the API implements by delegating to the recovery-case
 * service (engine PROPOSES → guardrail DISPOSES → adapter charges). This keeps the
 * package dependency arrow correct (packages never import apps) and makes the whole
 * saga unit-testable against a fake port with zero real time or network.
 */

import type { Customer, DeclineEvent, Invoice, PaymentMethod } from '@ax10m/canonical';
import type { RecoveryDecision, RetryStep } from '@ax10m/recovery-engine';

export type { RetryStep };

/** Inputs the port needs to plan or execute a single attempt. */
export interface AttemptInput {
  invoice: Invoice;
  method: PaymentMethod;
  /** The most recent decline on the case (drives recoverability + timing). */
  decline?: DeclineEvent;
  /** Saga-owned, 1-based. Stable across activity retries → exactly-once idempotency key. */
  attemptNumber: number;
  /** Customer-local hour at the planned execution time (guardrail quiet-hours). */
  localHour?: number;
  /** Minutes since the previous attempt (guardrail min-interval). */
  minutesSinceLastAttempt?: number;
  /** The customer, for alternate-rail backup-method discovery on dead credentials. */
  customer?: Customer;
  /**
   * The saga's current time at execution (from the SchedulerRuntime clock, which advances
   * via durable sleeps). Lets the service measure the per-credential min-interval in the
   * SAGA's timeline rather than the service's wall clock. Set by the driver on execute().
   */
  nowIso?: string;
}

/** What the engine/guardrail did on an execute() call. */
export type ExecutedAction =
  | 'charged' // a real charge was attempted against the processor
  | 'shadowed' // shadow mode: measured the intent, moved no money
  | 'guardrail_suppressed' // the guardrail vetoed the proposed retry
  | 'engine_suppressed' // the engine chose not to retry (EV ≤ 0 / below threshold)
  | 'card_update_comms'; // dead credential → routed to out-of-band card-update comms

/** The realized processor outcome of a `charged` action. */
export type ChargeOutcome = 'succeeded' | 'failed' | 'pending';

/** Result of executing one attempt. */
export interface ExecuteResult {
  action: ExecutedAction;
  /** Present only when action === 'charged'. `pending` = co-drive/bank-debit, settles via webhook. */
  outcome?: ChargeOutcome;
  decision: RecoveryDecision;
}

/** Result of planning one attempt (engine only — no money, no guardrail). */
export interface PlanResult {
  decision: RecoveryDecision;
}

/**
 * The seam between the scheduler and the recovery-case service. The API provides a
 * concrete implementation; the saga only ever sees this interface.
 */
export interface RecoveryCasePort {
  /** Run the engine for the given attempt and return its decision (incl. `retryAt`). */
  plan(input: AttemptInput): Promise<PlanResult>;
  /** Run engine → guardrail → adapter for the given attempt. In shadow mode, moves no money. */
  execute(input: AttemptInput): Promise<ExecuteResult>;
  /**
   * Plan the FULL ARSE retry sequence for a case up front (network-aware cadence,
   * credential rotation, bounded by predicted recoverability). Required by
   * `runSequencedRecoverySaga`; the adaptive per-attempt saga only needs `plan`.
   */
  planSequence?(input: AttemptInput): Promise<RetryStep[]>;
}

/** Why the recovery saga stopped. */
export type StopReason =
  | 'recovered' // a charge succeeded — the money is back
  | 'exhausted' // hit the max-attempts ceiling without recovering
  | 'engine_suppressed' // engine declined to (further) retry
  | 'guardrail_suppressed' // guardrail vetoed the retry (network cap / quiet hours / consent)
  | 'card_update_comms' // dead credential — handed to comms, charge saga ends
  | 'shadow_complete' // shadow mode: the plan was measured, nothing to loop on
  | 'pending_handoff'; // charge is in flight (co-drive); the webhook stream confirms it

/** One recorded event in the saga's timeline (for the ledger / observability). */
export interface SagaEvent {
  at: string;
  kind: 'planned' | 'slept' | 'executed' | 'awaiting_settlement' | 'stopped';
  attemptNumber: number;
  detail: Record<string, unknown>;
}

/** The terminal result of running a recovery saga. */
export interface RecoverySagaResult {
  status: StopReason;
  attempts: number;
  timeline: SagaEvent[];
}
