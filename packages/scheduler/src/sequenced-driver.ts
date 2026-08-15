/**
 * Sequence-driven recovery saga — executes an ARSE-planned schedule.
 *
 * Where `runRecoverySaga` re-plans one attempt at a time, this plans the WHOLE retry
 * sequence up front (`port.planSequence`, backed by the engine's `planRetrySequence`)
 * and then walks it: sleep to each step's scheduled time, execute, stop on success /
 * settlement / a terminal non-retry step, else fall through to the next step. The
 * sequence already encodes the network-aware cadence, credential rotation, and the
 * recoverability-floor cutoff, so this driver stays a thin, durable executor.
 *
 * Exactly-once is unchanged: each step carries its own saga-owned `attemptNumber`, so
 * a crash-and-replay re-executes a step with the same idempotency key.
 */

import { DEFAULT_SCHEDULER_CONFIG, type SchedulerConfig } from './config.js';
import { addMinutes } from './saga.js';
import type { SchedulerRuntime } from './runtime.js';
import type { RecoverySagaInput } from './driver.js';
import type { AttemptInput, RecoveryCasePort, RecoverySagaResult, SagaEvent, StopReason } from './types.js';

/**
 * Run the ARSE sequence to a terminal state. Requires a port that implements
 * `planSequence`. Deterministic given the port's responses and the runtime clock.
 */
export async function runSequencedRecoverySaga(
  port: RecoveryCasePort,
  runtime: SchedulerRuntime,
  input: RecoverySagaInput,
  config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
): Promise<RecoverySagaResult> {
  if (!port.planSequence) {
    throw new Error('runSequencedRecoverySaga: port does not implement planSequence.');
  }

  const timeline: SagaEvent[] = [];
  const record = (kind: SagaEvent['kind'], attemptNumber: number, detail: Record<string, unknown>): void => {
    timeline.push({ at: runtime.now(), kind, attemptNumber, detail });
  };
  const stop = (reason: StopReason, attemptNumber: number): RecoverySagaResult => {
    record('stopped', attemptNumber, { reason });
    return { status: reason, attempts: attemptNumber, timeline };
  };

  // Plan once from the first attempt.
  const steps = await port.planSequence({ ...input.attempt, attemptNumber: 1 });
  record('planned', 1, { steps: steps.length });

  // No step worth scheduling (recoverability floor cut everything) → nothing to do.
  if (steps.length === 0) return stop('engine_suppressed', 1);

  let lastAttempt = 1;
  for (const step of steps) {
    lastAttempt = step.attemptNumber;

    // A terminal non-retry step (dead/expired credential, or suppress) ends the saga.
    if (step.action !== 'retry') {
      return stop(step.action === 'card_update' ? 'card_update_comms' : 'engine_suppressed', step.attemptNumber);
    }

    await runtime.sleepUntil(step.at);
    record('slept', step.attemptNumber, { until: step.at, methodRef: step.methodRef ?? null });

    const attempt: AttemptInput = { ...input.attempt, attemptNumber: step.attemptNumber };
    // Stamp post-sleep saga time → per-credential min-interval measured in the saga's clock.
    const result = await port.execute({ ...attempt, nowIso: runtime.now() });
    record('executed', step.attemptNumber, { action: result.action, outcome: result.outcome ?? null });

    switch (result.action) {
      case 'shadowed':
        return stop('shadow_complete', step.attemptNumber);
      case 'guardrail_suppressed':
        return stop('guardrail_suppressed', step.attemptNumber);
      case 'engine_suppressed':
        return stop('engine_suppressed', step.attemptNumber);
      case 'card_update_comms':
        return stop('card_update_comms', step.attemptNumber);
      case 'charged':
        break;
    }

    if (result.outcome === 'succeeded') return stop('recovered', step.attemptNumber);
    if (result.outcome === 'pending') {
      const until = addMinutes(runtime.now(), config.settlementWindowMinutes);
      await runtime.sleepUntil(until);
      record('awaiting_settlement', step.attemptNumber, { until });
      return stop('pending_handoff', step.attemptNumber);
    }
    // outcome === 'failed' → fall through to the next planned step.
  }

  // Walked the whole sequence without recovering.
  return stop('exhausted', lastAttempt);
}
