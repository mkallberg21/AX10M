/** Scheduler policy knobs. Injected, never hardcoded into the saga. */
export interface SchedulerConfig {
  /**
   * Hard ceiling on charge attempts for a single case. MUST be ≤ the compliance
   * guardrail's all-time cap (@ax10m/guardrail DEFAULT_GUARDRAIL_POLICY.maxRetryAttempts,
   * currently 8) — the guardrail is the real enforcer; this is a saga-level backstop so
   * we stop looping even if a misconfigured guardrail would keep allowing attempts.
   */
  maxAttempts: number;
  /**
   * How long to wait for a `pending` (co-drive / bank-debit) charge to settle via the
   * webhook stream before the saga hands off. Bank debits (e.g. GoCardless) can take days.
   */
  settlementWindowMinutes: number;
  /**
   * Fallback gap before the next attempt when the engine returns no `retryAt`
   * (it always should for a retry, but we never want to hot-loop a charge).
   */
  fallbackBackoffMinutes: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxAttempts: 8,
  settlementWindowMinutes: 60,
  fallbackBackoffMinutes: 60,
};
