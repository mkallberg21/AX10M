/**
 * The compliance guardrail engine (ARCHITECTURE.md §4.2).
 *
 * `evaluate` takes a proposed action and returns allow / suppress + reason.
 * Constraints are checked in priority order and are INVIOLABLE — no learned
 * policy can override a suppression. Ordering matters only for which reason is
 * reported first; any single failing constraint suppresses the action.
 */

import { DeclineFamily, isRetriable } from '@ax10m/canonical';
import {
  DEFAULT_GUARDRAIL_POLICY,
  SuppressionReason,
  type GuardrailDecision,
  type GuardrailPolicy,
  type ProposedAction,
} from './types.js';

const ALLOW: GuardrailDecision = { allow: true };

function suppress(reason: SuppressionReason, message: string): GuardrailDecision {
  return { allow: false, reason, message };
}

/** Is the given local hour inside the quiet-hours window? Handles wrap-around. */
export function inQuietHours(hour: number, window: { start: number; end: number }): boolean {
  const { start, end } = window;
  if (start === end) return false;
  // Wrap-around window (e.g. 21 → 8): quiet if hour >= start OR hour < end.
  if (start > end) return hour >= start || hour < end;
  // Normal window (e.g. 1 → 6): quiet if start <= hour < end.
  return hour >= start && hour < end;
}

/**
 * Evaluate a proposed action against the guardrail. Returns the FIRST breached
 * constraint's suppression, or `{ allow: true }` if all constraints pass.
 */
export function evaluate(
  action: ProposedAction,
  policy: GuardrailPolicy = DEFAULT_GUARDRAIL_POLICY,
): GuardrailDecision {
  // 1. Global opt-out overrides absolutely everything.
  if (action.globallyOptedOut) {
    return suppress(SuppressionReason.GlobalOptOut, 'Customer has globally opted out of all contact.');
  }

  if (action.kind === 'charge_retry') {
    // 2. Hard declines are never retriable — retrying triggers network penalties.
    if (action.declineFamily === DeclineFamily.Hard) {
      return suppress(
        SuppressionReason.HardDecline,
        `Hard decline (${action.declineCode}) — retries suppressed; route to card-update comms.`,
      );
    }
    // 3. Taxonomy-level non-retriable codes (e.g. expired_card) — no same-card retry.
    if (!isRetriable(action.declineCode)) {
      return suppress(
        SuppressionReason.NonRetriableCode,
        `Decline code ${action.declineCode} is not retriable on the same card.`,
      );
    }
    // 4. Network attempt cap.
    if (action.attemptsSoFar >= policy.maxRetryAttempts) {
      return suppress(
        SuppressionReason.RetryCapReached,
        `Retry cap reached (${action.attemptsSoFar}/${policy.maxRetryAttempts}).`,
      );
    }
    return ALLOW;
  }

  // Comms actions.
  if (action.kind === 'comms') {
    // 5. Per-channel consent.
    if (!action.hasConsent) {
      return suppress(
        SuppressionReason.NoConsent,
        `No consent for channel ${action.channel ?? 'unknown'}.`,
      );
    }
    // 6. Quiet hours.
    if (inQuietHours(action.localHour, policy.quietHours)) {
      return suppress(
        SuppressionReason.QuietHours,
        `Local hour ${action.localHour} falls within quiet hours ` +
          `[${policy.quietHours.start}, ${policy.quietHours.end}).`,
      );
    }
    return ALLOW;
  }

  return ALLOW;
}
