/**
 * Stripe Smart Retries baseline (Phase 1, Step B).
 *
 * DOCUMENTED behavior (Stripe billing docs, qualitative): Smart Retries uses machine
 * learning to choose the retry TIMES most likely to succeed within a failed
 * subscription invoice's retry window, up to a bounded number of attempts, and
 * Stripe's Account Updater automatically refreshes expired/rotated cards so a later
 * retry can hit the new credential.
 *
 * NOT PUBLIC: the exact ML-selected times and the attempt count for a given invoice.
 *
 * MODEL: a deliberately STRONG, decline-AGNOSTIC schedule of four attempts placed to
 * cover the aggregate recovery-onset mass — fast for transient issuer errors, spread
 * out far enough to catch NSF paydays and card reissues: **days 1, 4, 10, 18**. It is
 * decline-agnostic because Smart Retries optimizes at the merchant/aggregate level, not
 * per canonical decline code (that per-code customization is exactly what the AX10M
 * engine claims as its edge — so giving the baseline per-code intelligence would be
 * unfaithful in the OTHER direction). The uncertainty in the exact schedule is stated
 * in report.md; the sensitivity sweep does not vary the baseline, only the world.
 *
 * A weak baseline is the single easiest way to make this whole exercise worthless, so
 * this is tuned to be a fair, capable opponent, not a punching bag.
 */

import type { ObservedInvoice, Policy, RecoveryAction } from '../policy/policy.js';

export const SMART_RETRIES_SCHEDULE_DAYS = [1, 4, 10, 18] as const;

export class StripeSmartRetriesBaseline implements Policy {
  readonly name = 'stripe-smart-retries';
  constructor(private readonly scheduleDays: readonly number[] = SMART_RETRIES_SCHEDULE_DAYS) {}

  plan(_obs: ObservedInvoice): RecoveryAction[] {
    // Retries every invoice (Account Updater covers expired/rotated cards on a late
    // attempt); a doomed hard decline simply fails in the world, at no modeled cost.
    return this.scheduleDays.map((day) => ({ day, kind: 'retry' as const }));
  }
}
