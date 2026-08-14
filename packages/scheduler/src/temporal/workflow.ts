/**
 * The recovery Temporal WORKFLOW.
 *
 * This is the durable host for `runRecoverySaga`: it supplies a `SchedulerRuntime`
 * backed by Temporal's replay-safe clock + `sleep` (a retry scheduled three days out
 * survives worker restarts, deploys, and crashes), and a `RecoveryCasePort` that
 * proxies to activities (the only place side effects run). The saga logic itself is
 * the exact same pure code the unit tests exercise.
 *
 * IMPORTANT: this module executes inside Temporal's deterministic workflow sandbox.
 * Do not import it from ordinary Node code (the top-level `proxyActivities` call is
 * only valid in the sandbox) — the worker loads it via `workflowsPath`, and clients
 * start it by name. That's why it is deliberately NOT re-exported from any barrel.
 */

import { proxyActivities, sleep } from '@temporalio/workflow';
import type { RecoveryActivities } from './activities.js';
import { runRecoverySaga, type RecoverySagaInput } from '../driver.js';
import type { SchedulerConfig } from '../config.js';
import type { SchedulerRuntime } from '../runtime.js';
import type { RecoveryCasePort, RecoverySagaResult } from '../types.js';

// Activities get their own retry policy (transport blips retry); the SAGA owns the
// business-level attempt cap. Idempotency keeps activity retries safe.
const { planAttempt, executeAttempt } = proxyActivities<RecoveryActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5, initialInterval: '5s', backoffCoefficient: 2 },
});

export interface RecoveryWorkflowInput {
  saga: RecoverySagaInput;
  config?: SchedulerConfig;
}

/** Durable recovery saga. One workflow per failed-invoice case; workflowId = the case id. */
export async function recoveryWorkflow(input: RecoveryWorkflowInput): Promise<RecoverySagaResult> {
  const port: RecoveryCasePort = {
    plan: (attempt) => planAttempt(attempt),
    execute: (attempt) => executeAttempt(attempt),
  };
  const runtime: SchedulerRuntime = {
    // Inside the sandbox Date is deterministic (backed by workflow time).
    now: () => new Date().toISOString(),
    sleepUntil: async (iso) => {
      const ms = Date.parse(iso) - Date.now();
      if (ms > 0) await sleep(ms);
    },
  };
  return runRecoverySaga(port, runtime, input.saga, input.config);
}
