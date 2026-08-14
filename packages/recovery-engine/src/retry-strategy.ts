/**
 * Retry-strategy library — how to space attempts, per decline code AND card network.
 *
 * The recoverability model says *whether* a retry is worth it; this says *what the
 * retry cadence should be* for that failure kind, and how it differs by network. The
 * cadences encode payments domain knowledge (NSF wants payday-spaced days; a transient
 * issuer error wants minutes; do-not-honor wants a backoff and a credential rotation),
 * and the per-network ceilings reflect that Amex/Discover tolerate fewer attempts than
 * Visa/Mastercard. The compliance guardrail (@ax10m/guardrail) still enforces the hard
 * network caps on top of this — a strategy proposes, the guardrail disposes.
 */

import { DeclineCode } from '@ax10m/canonical';
import { classifyDecline, type RecommendedAction } from './decline-intel.js';

/** Card network — mirrors @ax10m/guardrail's taxonomy (kept local to avoid coupling). */
export type CardNetwork = 'visa' | 'mastercard' | 'amex' | 'discover' | 'other';

export interface RetryStrategy {
  code: DeclineCode;
  network: CardNetwork;
  action: RecommendedAction;
  /** Max charge attempts this strategy proposes (0 for non-retry actions). */
  maxAttempts: number;
  /** Minutes to wait before each successive attempt (length === maxAttempts). */
  delaysMinutes: number[];
  /** Switch to an alternate stored credential after this many failed attempts, if any. */
  rotateMethodAfterAttempt?: number;
  rationale: string;
}

/** Per-network ceiling on attempts (conservative; the guardrail holds the real caps). */
const NETWORK_MAX_ATTEMPTS: Readonly<Record<CardNetwork, number>> = {
  visa: 4,
  mastercard: 4,
  amex: 3,
  discover: 3,
  other: 2,
};

/** Base cadence by decline code (minutes before each attempt), pre network-clamp. */
function baseCadence(code: DeclineCode): { delays: number[]; rotateAfter?: number; note: string } {
  switch (code) {
    case DeclineCode.InsufficientFunds:
      return { delays: [1440, 4320, 10080], note: 'NSF: payday-spaced (1d, 3d, 7d) to catch a funded balance.' };
    case DeclineCode.IssuerUnavailable:
    case DeclineCode.ProcessingError:
    case DeclineCode.TryAgainLater:
      return { delays: [15, 120, 720], note: 'Transient issuer error: quick escalating retry (15m, 2h, 12h).' };
    case DeclineCode.VelocityLimitExceeded:
      return { delays: [1440, 2880], note: 'Velocity limit: wait out the issuer window (1d, 2d).' };
    case DeclineCode.AuthenticationRequired:
      return { delays: [60], note: 'Auth required: one retry via an authenticated (3DS/SCA) flow.' };
    case DeclineCode.DoNotHonor:
      return { delays: [720, 2880, 7200], rotateAfter: 2, note: 'Do-not-honor: backoff (12h, 2d, 5d) and rotate credential after 2 fails.' };
    default:
      return { delays: [720, 2880], note: 'Unmapped gray decline: cautious backoff (12h, 2d).' };
  }
}

/** Build the retry strategy for a decline code on a given network. */
export function strategyFor(code: DeclineCode, network: CardNetwork = 'other'): RetryStrategy {
  const { recommendedAction } = classifyDecline(code);
  if (recommendedAction !== 'retry') {
    return {
      code,
      network,
      action: recommendedAction,
      maxAttempts: 0,
      delaysMinutes: [],
      rationale: recommendedAction === 'card_update'
        ? 'Dead/expired credential — no charge retries; route to a card update.'
        : 'Non-retriable (fraud/hard) — suppress; retrying risks network penalties.',
    };
  }

  const { delays, rotateAfter, note } = baseCadence(code);
  const cap = NETWORK_MAX_ATTEMPTS[network];
  const capped = delays.slice(0, cap);
  return {
    code,
    network,
    action: 'retry',
    maxAttempts: capped.length,
    delaysMinutes: capped,
    rotateMethodAfterAttempt: rotateAfter !== undefined && rotateAfter < capped.length ? rotateAfter : undefined,
    rationale: `${note} Network ${network} caps at ${cap} attempts.`,
  };
}
