/**
 * Compliance guardrail types (ARCHITECTURE.md §2, §4.2).
 *
 * The guardrail is a HARD-CONSTRAINT layer applied AFTER the learned policy
 * proposes an action. Constraints ALWAYS override policy. Every suppression is
 * logged with a machine-readable reason. This is what makes over-retry network
 * fines structurally impossible rather than merely discouraged.
 */

import type { DeclineCode, DeclineFamily } from '@ax10m/canonical';

/** A proposed action the decision core wants to take. */
export type ProposedActionKind = 'charge_retry' | 'comms';

/** Communication channel for a comms action. */
export type CommsChannel = 'email' | 'sms' | 'whatsapp' | 'push' | 'in_app';

export interface ProposedAction {
  kind: ProposedActionKind;
  /** For comms actions: which channel. */
  channel?: CommsChannel;
  /** The most recent decline code on the case (drives hard-decline suppression). */
  declineCode: DeclineCode;
  declineFamily: DeclineFamily;
  /** How many network retry attempts have already been made on this case. */
  attemptsSoFar: number;
  /** Customer-local hour (0-23) at the proposed execution time. */
  localHour: number;
  /** Consent for the proposed channel; true for charge retries. */
  hasConsent: boolean;
  /** Global opt-out flag — overrides everything. */
  globallyOptedOut: boolean;
}

/** Network / policy limits the guardrail enforces. Injected, not hardcoded. */
export interface GuardrailPolicy {
  /** Max network retry attempts allowed on a single case (card-network cap). */
  maxRetryAttempts: number;
  /** Quiet-hours window [startHour, endHour) in customer-local time, inclusive
   *  of start, exclusive of end. Comms are suppressed inside this window. */
  quietHours: { start: number; end: number };
}

export const DEFAULT_GUARDRAIL_POLICY: GuardrailPolicy = {
  // Conservative default well under Visa/MC caps; tune per network/issuer.
  maxRetryAttempts: 4,
  quietHours: { start: 21, end: 8 }, // 9pm–8am local
};

/** Why an action was suppressed. Stable machine-readable codes for the ledger. */
export enum SuppressionReason {
  HardDecline = 'hard_decline_suppressed',
  RetryCapReached = 'retry_attempt_cap_reached',
  QuietHours = 'quiet_hours',
  NoConsent = 'no_consent',
  GlobalOptOut = 'global_opt_out',
  NonRetriableCode = 'non_retriable_code',
}

export type GuardrailDecision =
  | { allow: true }
  | { allow: false; reason: SuppressionReason; message: string };
