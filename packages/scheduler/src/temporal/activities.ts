/**
 * Temporal activities for the recovery saga.
 *
 * Activities are the ONLY place side effects happen (planning calls the engine;
 * executing charges the processor). Temporal persists each activity's result, so a
 * worker crash mid-saga resumes without re-charging — combined with the saga-owned
 * `attemptNumber` → deterministic idempotency key, this is the exactly-once charge
 * path the whole product rests on.
 *
 * The activities just delegate to a `RecoveryCasePort` (implemented by the API over
 * the recovery-case service), so this file has no processor knowledge and the port
 * stays independently testable.
 */

import type { AttemptInput, ExecuteResult, PlanResult, RecoveryCasePort } from '../types.js';

/** The activity surface the workflow proxies. */
export interface RecoveryActivities {
  planAttempt(input: AttemptInput): Promise<PlanResult>;
  executeAttempt(input: AttemptInput): Promise<ExecuteResult>;
}

/** Bind the activities to a concrete port (registered on the Temporal worker). */
export function createRecoveryActivities(port: RecoveryCasePort): RecoveryActivities {
  return {
    planAttempt: (input) => port.plan(input),
    executeAttempt: (input) => port.execute(input),
  };
}
