/**
 * The recovery saga driver — the loop that turns engine plans into a durable,
 * exactly-once charge schedule.
 *
 *   plan(attempt) → [sleep until retryAt] → execute(attempt) → succeeded? done
 *                                                            ↘ failed? attempt++ → plan(attempt) …
 *
 * The loop body is entirely `saga.ts` (pure) + `runtime` (now/sleepUntil) + `port`
 * (plan/execute). Because the runtime and port are injected, the same code runs
 * unchanged inside a Temporal workflow (durable sleeps, real charges) and inside a
 * unit test (virtual clock, fake port) — the property that makes the scheduler
 * trustworthy: what the tests prove is exactly what production runs.
 *
 * Exactly-once: `attemptNumber` is owned here and threaded into every execute() call,
 * so the idempotency key the adapter derives is stable across activity retries — a
 * crash-and-replay re-runs execute() with the SAME attemptNumber and the processor
 * de-dupes instead of double-charging.
 */

import { DEFAULT_SCHEDULER_CONFIG, type SchedulerConfig } from './config.js';
import { addMinutes, planStep, postExecuteStep } from './saga.js';
import type { SchedulerRuntime } from './runtime.js';
import type {
  AttemptInput,
  RecoveryCasePort,
  RecoverySagaResult,
  SagaEvent,
  StopReason,
} from './types.js';

/** Everything needed to run one case's recovery saga. */
export interface RecoverySagaInput {
  /** The failed invoice + method + latest decline. attemptNumber is managed by the saga. */
  attempt: Omit<AttemptInput, 'attemptNumber'>;
  /** Shadow = measure only, never move money (Phase 0). Active = Phase 1. */
  shadow: boolean;
}

/**
 * Run the durable recovery saga to a terminal state. Deterministic given the port's
 * responses and the runtime's clock.
 */
export async function runRecoverySaga(
  port: RecoveryCasePort,
  runtime: SchedulerRuntime,
  input: RecoverySagaInput,
  config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
): Promise<RecoverySagaResult> {
  const timeline: SagaEvent[] = [];
  const record = (kind: SagaEvent['kind'], attemptNumber: number, detail: Record<string, unknown>): void => {
    timeline.push({ at: runtime.now(), kind, attemptNumber, detail });
  };
  const stop = (reason: StopReason, attemptNumber: number): RecoverySagaResult => {
    record('stopped', attemptNumber, { reason });
    return { status: reason, attempts: attemptNumber, timeline };
  };

  let attemptNumber = 1;

  // Bounded by maxAttempts; postExecuteStep is the real terminator, this guards runaway.
  for (let guard = 0; guard <= config.maxAttempts + 1; guard++) {
    const attempt: AttemptInput = { ...input.attempt, attemptNumber };

    // 1) PLAN — ask the engine what to do for this attempt (no money, no guardrail).
    const { decision } = await port.plan(attempt);
    record('planned', attemptNumber, { action: decision.action, retryAt: decision.retryAt ?? null, rationale: decision.rationale });

    const step = planStep(decision, runtime.now(), config);
    if (step.kind === 'stop') return stop(step.reason, attemptNumber);
    if (step.kind === 'sleep_then_execute') {
      await runtime.sleepUntil(step.until);
      record('slept', attemptNumber, { until: step.until });
    }

    // 2) EXECUTE — engine → guardrail → adapter (or shadow). attemptNumber → exactly-once.
    const result = await port.execute(attempt);
    record('executed', attemptNumber, { action: result.action, outcome: result.outcome ?? null });

    // 3) DECIDE what happens next.
    const post = postExecuteStep(result, attemptNumber, config);
    if (post.kind === 'stop') return stop(post.reason, attemptNumber);
    if (post.kind === 'await_settlement') {
      // Co-drive / bank debit: the charge is in flight. Wait a settlement window; the
      // real outcome arrives on the webhook stream, which opens/continues its own case.
      const until = addMinutes(runtime.now(), config.settlementWindowMinutes);
      await runtime.sleepUntil(until);
      record('awaiting_settlement', attemptNumber, { until });
      return stop('pending_handoff', attemptNumber);
    }
    // post.kind === 'retry'
    attemptNumber = post.nextAttemptNumber;
  }

  // Unreachable in practice (postExecuteStep stops at maxAttempts); fail safe.
  return stop('exhausted', attemptNumber);
}
