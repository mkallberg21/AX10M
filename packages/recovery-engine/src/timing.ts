/**
 * Retry-timing policy — WHEN to re-attempt a recoverable failure.
 *
 * The SECOND half of the recovery brain, and where beating a fixed schedule (and,
 * eventually, Smart Retries) actually comes from: the best time to retry depends on
 * the decline reason and the issuer's rhythm. Insufficient-funds recovers around
 * payday; issuer-unavailable is transient and worth a quick retry; do-not-honor
 * needs a longer, escalating backoff. The times are deterministic given `nowIso`
 * (no wall-clock read) so the schedule is reproducible and testable. Each decision
 * carries a human-readable rationale for the explainability ledger.
 *
 * Learning target: replace the hand-set offsets with a per-issuer model of the
 * hour/day an approval is most likely — that is the durable, data-flywheel edge.
 */

import { DeclineCode } from '@ax10m/canonical';
import type { RecoveryFeatures } from './recoverability.js';

export interface RetryTiming {
  /** ISO timestamp to attempt the retry at. */
  retryAt: string;
  rationale: string;
}

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** Next 1st-or-15th of the month at/after `from` — a payday proxy for NSF timing. */
function nextPaydayProxy(from: Date): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  if (d < 15) return new Date(Date.UTC(y, m, 15, 12));
  return new Date(Date.UTC(y, m + 1, 1, 12)); // the 1st of next month
}

/**
 * Choose the next retry time for a (recoverable) failure. Backoff escalates with the
 * attempt number; the reason shapes the shape of the schedule.
 */
export function optimalRetryTime(f: RecoveryFeatures, nowIso: string): RetryTiming {
  const now = new Date(nowIso);
  const attempt = Math.max(1, f.attemptNumber);
  const at = (ms: number, rationale: string): RetryTiming => ({
    retryAt: new Date(now.getTime() + ms).toISOString(),
    rationale,
  });

  switch (f.declineCode) {
    case DeclineCode.IssuerUnavailable:
    case DeclineCode.ProcessingError:
    case DeclineCode.TryAgainLater: {
      // Transient issuer-side error — retry soon, short escalating backoff.
      const hours = [2, 6, 24][Math.min(attempt - 1, 2)]!;
      return at(hours * MS_PER_HOUR, `Transient issuer error — quick retry in ${hours}h (attempt ${attempt}).`);
    }
    case DeclineCode.InsufficientFunds: {
      // Align to the customer's likely payday; but never wait absurdly long on a
      // first attempt — take the sooner of "+2 days" and "next payday proxy".
      const twoDays = new Date(now.getTime() + 2 * MS_PER_DAY);
      const payday = nextPaydayProxy(now);
      const pick = attempt === 1 && twoDays < payday ? twoDays : payday;
      return {
        retryAt: pick.toISOString(),
        rationale: `Insufficient funds — timed to likely payday (${pick.toISOString().slice(0, 10)}); funds most likely available then.`,
      };
    }
    case DeclineCode.VelocityLimitExceeded: {
      // Wait out the issuer's velocity window.
      return at(24 * MS_PER_HOUR, 'Velocity/limit exceeded — wait out the issuer window (24h).');
    }
    case DeclineCode.AuthenticationRequired: {
      // Needs the cardholder to act; schedule after a comms nudge has time to land.
      return at(12 * MS_PER_HOUR, 'Authentication required — retry after a comms nudge (12h).');
    }
    case DeclineCode.DoNotHonor:
    case DeclineCode.Fraudulent:
    default: {
      // Gray / generic decline — longer escalating backoff, don't hammer the issuer.
      const days = [1, 3, 7, 14][Math.min(attempt - 1, 3)]!;
      return at(days * MS_PER_DAY, `Generic decline — escalating backoff, retry in ${days}d (attempt ${attempt}).`);
    }
  }
}
