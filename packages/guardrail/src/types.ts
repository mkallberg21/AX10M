/**
 * Compliance guardrail types (ARCHITECTURE.md §2, §4.2).
 *
 * The guardrail is a HARD-CONSTRAINT layer applied AFTER the learned policy
 * proposes an action. Constraints ALWAYS override policy. Every suppression is
 * logged with a machine-readable reason. This is what makes over-retry network
 * fines structurally impossible rather than merely discouraged.
 */

import type { DeclineCode, DeclineFamily } from '@ax10m/canonical';

/**
 * A proposed action the decision core wants to take.
 *  - `charge_retry`            — re-attempt the ORIGINAL credential (same card).
 *  - `fresh_credential_charge` — charge a DIFFERENT working credential: an
 *    Account-Updater-refreshed card (`card_refresh`) or a stored backup method
 *    (`alternate_rail`). The hard-decline / non-retriable-code blocks (which exist to
 *    stop pounding a dead card) do NOT apply — the whole point is that this is a new,
 *    valid credential — but the attempt caps and opt-out still do.
 *  - `comms`                   — a customer message (e.g. dunning card-update prompt).
 */
export type ProposedActionKind = 'charge_retry' | 'fresh_credential_charge' | 'comms';

/** Communication channel for a comms action. */
export type CommsChannel = 'email' | 'sms' | 'whatsapp' | 'push' | 'in_app';

/** Card network — drives network-specific retry-cap compliance. */
export type CardNetwork = 'visa' | 'mastercard' | 'amex' | 'discover' | 'other';

export interface ProposedAction {
  kind: ProposedActionKind;
  /** For comms actions: which channel. */
  channel?: CommsChannel;
  /** The most recent decline code on the case (drives hard-decline suppression). */
  declineCode: DeclineCode;
  declineFamily: DeclineFamily;
  /** How many network retry attempts have already been made on this case (all-time). */
  attemptsSoFar: number;
  /** Card network of the payment method (drives network retry-cap compliance). */
  cardNetwork?: CardNetwork;
  /** Retry attempts within the network's rolling compliance window (e.g. trailing 30 days). */
  attemptsInWindow?: number;
  /** Minutes since the last charge attempt on this case (min-interval enforcement). */
  minutesSinceLastAttempt?: number;
  /** Customer-local hour (0-23) at the proposed execution time. */
  localHour: number;
  /** Consent for the proposed channel; true for charge retries. */
  hasConsent: boolean;
  /** Global opt-out flag — overrides everything. */
  globallyOptedOut: boolean;
}

/** Per-network retry-cap rule (card-network compliance). */
export interface NetworkRetryCap {
  /** Max retry attempts allowed within the rolling window for the same transaction. */
  maxAttemptsPerWindow: number;
  /** Rolling window length in days. */
  windowDays: number;
  /** Minimum minutes that must elapse between attempts (anti-hammering). */
  minMinutesBetween: number;
}

/** Network / policy limits the guardrail enforces. Injected, not hardcoded. */
export interface GuardrailPolicy {
  /** Global fallback cap on all-time retry attempts on a single case. */
  maxRetryAttempts: number;
  /**
   * Card-network retry-cap compliance. Exceeding a network's attempt count in its
   * rolling window (or retrying inside the min-interval) risks card-network fines
   * and acquirer scrutiny — the guardrail makes that structurally impossible.
   *
   * NOTE: the defaults are conservative placeholders modeled on published network
   * guidance (e.g. Visa's ~15 authorization attempts / 30 days for the same
   * transaction). CONFIRM the exact current caps per network/region/MCC before
   * production — the value here is the enforcement MECHANISM, not the numbers.
   */
  networkCaps?: Record<CardNetwork, NetworkRetryCap>;
  /** Quiet-hours window [startHour, endHour) in customer-local time, inclusive
   *  of start, exclusive of end. Comms are suppressed inside this window. */
  quietHours: { start: number; end: number };
}

const CONSERVATIVE_CAP = (maxAttemptsPerWindow: number): NetworkRetryCap => ({
  maxAttemptsPerWindow,
  windowDays: 30,
  minMinutesBetween: 60,
});

export const DEFAULT_GUARDRAIL_POLICY: GuardrailPolicy = {
  // Conservative global fallback well under any network cap.
  maxRetryAttempts: 8,
  // Placeholders — CONFIRM against current network rules per region/MCC (see above).
  networkCaps: {
    visa: CONSERVATIVE_CAP(15),
    mastercard: CONSERVATIVE_CAP(10),
    amex: CONSERVATIVE_CAP(10),
    discover: CONSERVATIVE_CAP(10),
    other: CONSERVATIVE_CAP(8),
  },
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
  /** Retry would exceed the card network's attempt cap in its rolling window. */
  NetworkWindowCapReached = 'network_window_cap_reached',
  /** Retry attempted before the network's minimum inter-attempt interval elapsed. */
  MinIntervalNotElapsed = 'min_interval_not_elapsed',
  /** An action kind the guardrail does not recognize — fail closed. */
  UnknownAction = 'unknown_action',
}

export type GuardrailDecision =
  | { allow: true }
  | { allow: false; reason: SuppressionReason; message: string };
