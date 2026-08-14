/**
 * The recovery saga's DECISION LOGIC — pure, deterministic, runtime-free.
 *
 * These functions decide, from an engine plan or an execution result, what the
 * durable orchestration should do next. They read no clock and perform no I/O, so
 * the whole control flow is unit-testable without Temporal, sleeps, or a processor.
 * `driver.ts` and the Temporal workflow are thin shells that call these and then
 * actually sleep / charge.
 */

import type { RecoveryDecision } from '@ax10m/recovery-engine';
import type { SchedulerConfig } from './config.js';
import type { ExecuteResult, StopReason } from './types.js';

/** What to do before executing a planned attempt. */
export type PlanStep =
  | { kind: 'sleep_then_execute'; until: string }
  | { kind: 'execute_now' }
  | { kind: 'stop'; reason: StopReason };

/** What to do after executing an attempt. */
export type PostExecuteStep =
  | { kind: 'retry'; nextAttemptNumber: number }
  | { kind: 'await_settlement' }
  | { kind: 'stop'; reason: StopReason };

/**
 * Given the engine's plan for the current attempt, decide whether to sleep until its
 * `retryAt`, execute immediately, or stop (the engine chose comms/suppress, so there
 * is nothing to schedule a charge for).
 *
 * `now` is passed in (never read from a clock) so this stays pure and the Temporal
 * workflow can pass its own deterministic time.
 */
export function planStep(
  decision: RecoveryDecision,
  now: string,
  config: SchedulerConfig,
): PlanStep {
  if (decision.action === 'card_update_comms') return { kind: 'stop', reason: 'card_update_comms' };
  if (decision.action === 'suppress') return { kind: 'stop', reason: 'engine_suppressed' };

  // action === 'retry': schedule for the engine's chosen time, but never hot-loop.
  const target = futureTime(decision.retryAt, now, config.fallbackBackoffMinutes);
  if (target === null) return { kind: 'execute_now' };
  return { kind: 'sleep_then_execute', until: target };
}

/**
 * Given the result of executing an attempt, decide whether to schedule another
 * attempt, wait for an async settlement, or stop with a terminal reason.
 */
export function postExecuteStep(
  result: ExecuteResult,
  attemptNumber: number,
  config: SchedulerConfig,
): PostExecuteStep {
  switch (result.action) {
    case 'shadowed':
      // Shadow mode measured the intent; there is no realized outcome to loop on.
      return { kind: 'stop', reason: 'shadow_complete' };
    case 'engine_suppressed':
      return { kind: 'stop', reason: 'engine_suppressed' };
    case 'guardrail_suppressed':
      return { kind: 'stop', reason: 'guardrail_suppressed' };
    case 'card_update_comms':
      return { kind: 'stop', reason: 'card_update_comms' };
    case 'charged':
      break;
  }

  if (result.outcome === 'succeeded') return { kind: 'stop', reason: 'recovered' };
  if (result.outcome === 'pending') return { kind: 'await_settlement' };

  // outcome === 'failed' → schedule another attempt unless we've hit the ceiling.
  const next = attemptNumber + 1;
  if (next > config.maxAttempts) return { kind: 'stop', reason: 'exhausted' };
  return { kind: 'retry', nextAttemptNumber: next };
}

/**
 * Resolve the time to sleep until: the engine's `retryAt` if it is in the future,
 * else a fallback backoff from now, else `null` meaning "execute now" (retryAt is in
 * the past — the scheduled moment has already arrived).
 */
function futureTime(retryAt: string | undefined, now: string, fallbackMinutes: number): string | null {
  const nowMs = Date.parse(now);
  if (retryAt) {
    const t = Date.parse(retryAt);
    if (Number.isFinite(t)) {
      return t > nowMs ? new Date(t).toISOString() : null;
    }
  }
  // No usable retryAt: never hot-loop — back off a fixed gap from now.
  return new Date(nowMs + fallbackMinutes * 60_000).toISOString();
}

/** Add minutes to an ISO instant (used for the settlement window). */
export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}
