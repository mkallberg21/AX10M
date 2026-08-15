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

/**
 * Base cadence by decline code (gaps in minutes BEFORE each successive attempt),
 * pre network-clamp. Cumulative reach in the comments.
 *
 * DESIGN NOTE (the timing rework, grounded in real recovery windows — not in any
 * backtest's parameters): a failed subscription payment recovers over WEEKS, not days.
 * NSF recovers when the balance replenishes, which for monthly and semi-monthly pay
 * cycles is 2–4 weeks out; card reissues (Account Updater) take ~3 weeks; a diffuse
 * do-not-honor resolves across the dunning window. A schedule that stops at ~day 11
 * structurally misses the back half of every window. So each RETRIABLE cadence now
 * reaches into the 2–4 week range, while staying DECLINE-SPECIFIC — transient issuer
 * errors still get a fast first attempt; NSF spans the pay cycle — which a single,
 * decline-agnostic schedule cannot do simultaneously.
 */
function baseCadence(code: DeclineCode): { delays: number[]; rotateAfter?: number; note: string } {
  switch (code) {
    case DeclineCode.InsufficientFunds:
      // cumulative: day 1, 4, 14, 28 — span weekly / bi-weekly / monthly paydays.
      return { delays: [1440, 4320, 14400, 20160], note: 'NSF: span the pay cycle — day 1, 4, 14, 28 (weekly→bi-weekly→monthly paydays).' };
    case DeclineCode.IssuerUnavailable:
    case DeclineCode.ProcessingError:
    case DeclineCode.TryAgainLater:
      // cumulative: ~15m, ~4h, ~1d, ~6d — fast first, then backups for a longer outage.
      return { delays: [15, 240, 1440, 7200], note: 'Transient issuer error: fast first (15m, 4h), then day-1 and day-6 backups for a longer outage.' };
    case DeclineCode.VelocityLimitExceeded:
      // cumulative: day 1, 5, 15 — wait out the issuer velocity window.
      return { delays: [1440, 5760, 14400], note: 'Velocity limit: day 1, 5, 15 — wait out the issuer window.' };
    case DeclineCode.AuthenticationRequired:
      // cumulative: ~1h, ~2d — authenticated retry + one backup.
      return { delays: [60, 2880], note: 'Auth required: retry via an authenticated (3DS/SCA) flow, one backup at day 2.' };
    case DeclineCode.DoNotHonor:
      // cumulative: 12h, ~3.5d, ~11.5d, ~26.5d — escalating backoff spanning the window.
      return { delays: [720, 4320, 11520, 21600], rotateAfter: 2, note: 'Do-not-honor: escalating backoff (12h, 3.5d, 11.5d, 26.5d), rotate credential after 2.' };
    default:
      // cumulative: 12h, ~3.5d, ~13.5d.
      return { delays: [720, 4320, 14400], note: 'Unmapped gray decline: cautious backoff to ~day 13.' };
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
