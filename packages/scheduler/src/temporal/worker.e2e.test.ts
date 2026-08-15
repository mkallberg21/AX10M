/**
 * LIVE WORKER end-to-end — the durable charge path running on a REAL Temporal server.
 *
 * This is not a fake-clock unit test: it boots Temporal's time-skipping test server,
 * registers the real `recoveryWorkflow` (loaded, bundled, and executed inside Temporal's
 * workflow sandbox) plus the real activities, and drives a full recovery saga through
 * it. The durable multi-day `sleep` between retries is fast-forwarded by the test
 * server, so we exercise the exact production code path — durable timers, activity
 * dispatch, replay — in seconds.
 *
 * What it proves:
 *   1. The worker actually hosts and runs the workflow (the "live worker" claim).
 *   2. Exactly-once charging survives activity RETRIES: a transport blip makes Temporal
 *      re-run executeAttempt with the SAME saga-owned attemptNumber → the processor sees
 *      the same idempotency key and de-dupes, so no double charge.
 *   3. The saga reaches `recovered` and the charge ledger reflects one settled attempt.
 *
 * The workflow is loaded from the COMPILED output (dist/temporal/workflow.js) — the test
 * script runs `tsc -b` first — because Temporal bundles the workflow graph as real JS.
 */

import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { createRecoveryActivities } from './activities.js';
import type { RecoveryWorkflowInput } from './workflow.js';
import type {
  AttemptInput,
  ExecuteResult,
  PlanResult,
  RecoveryCasePort,
  RecoverySagaResult,
} from '../types.js';

const WORKFLOW_JS = fileURLToPath(new URL('../../dist/temporal/workflow.js', import.meta.url));
const TASK_QUEUE = 'ax10m-recovery-test';

/**
 * A scripted port that stands in for the API's ServiceRecoveryCasePort. It "charges" a
 * fake processor that fails the first attempt then succeeds — and de-dupes by
 * idempotency key so a Temporal activity retry of the SAME attempt cannot double-charge.
 */
class ScriptedPort implements RecoveryCasePort {
  /** Distinct idempotency keys the processor actually settled (proves exactly-once). */
  readonly settledKeys = new Set<string>();
  /** Every execute() invocation, including activity retries (may exceed settledKeys). */
  executeCalls = 0;
  /** Set true for one execute() to simulate a transport blip → Temporal retries it. */
  private failOnceAtCall = 0;

  constructor(opts: { blipOnCall?: number } = {}) {
    this.failOnceAtCall = opts.blipOnCall ?? 0;
  }

  async plan(input: AttemptInput): Promise<PlanResult> {
    // Retry, scheduled ~3 days out (a DURABLE sleep the test server fast-forwards).
    const retryAt = new Date(Date.parse(input.decline?.occurredAt ?? '2026-08-14T00:00:00.000Z') + 3 * 86_400_000).toISOString();
    return {
      decision: {
        action: 'retry',
        retryAt,
        recoverabilityScore: 0.6,
        expectedValueMinor: 5000,
        rationale: 'scripted retry',
      },
    };
  }

  async execute(input: AttemptInput): Promise<ExecuteResult> {
    this.executeCalls++;
    // Deterministic key from the SAGA-owned attemptNumber — identical across activity
    // retries of the same attempt. This is the exactly-once guarantee under test.
    const key = `${input.invoice.id}:${input.attemptNumber}`;

    if (this.executeCalls === this.failOnceAtCall) {
      // Blip AFTER the processor would have seen the request but BEFORE we return, so a
      // real processor would have the key recorded; our fake records it then throws so
      // Temporal retries. The retry must NOT settle a second, distinct charge.
      this.settledKeys.add(key);
      throw new Error('simulated transport blip — Temporal should retry this activity');
    }
    this.settledKeys.add(key); // idempotent: Set de-dupes the retried key

    // attempt 1 fails (insufficient funds), attempt 2 succeeds.
    const outcome = input.attemptNumber >= 2 ? 'succeeded' : 'failed';
    return {
      action: 'charged',
      outcome,
      decision: {
        action: 'retry',
        recoverabilityScore: 0.6,
        expectedValueMinor: 5000,
        rationale: 'scripted charge',
      },
    };
  }
}

const baseInput: RecoveryWorkflowInput = {
  saga: {
    attempt: {
      invoice: {
        id: 'ax10m_inv_worker_1',
        customerId: 'ax10m_cus_1',
        merchantId: 'mrc_1',
        processorRef: 'in_1',
        amount: { amount: 14900, currency: 'USD' },
        status: 'open',
        createdAt: '2026-08-14T00:00:00.000Z',
      },
      method: { id: 'ax10m_pm_1', customerId: 'ax10m_cus_1', processorRef: 'pm_1', token: 'pm_1', brand: 'visa' },
      decline: undefined,
    },
    shadow: false,
  },
};

describe('live Temporal worker — durable recovery saga', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    if (!existsSync(WORKFLOW_JS)) {
      throw new Error(`Compiled workflow not found at ${WORKFLOW_JS}. Run \`tsc -b\` before the e2e (the test script does).`);
    }
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  async function runWorkflow(port: RecoveryCasePort, workflowId: string): Promise<RecoverySagaResult> {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: WORKFLOW_JS,
      activities: createRecoveryActivities(port),
    });
    return worker.runUntil(
      env.client.workflow.execute('recoveryWorkflow', {
        taskQueue: TASK_QUEUE,
        workflowId,
        args: [baseInput],
      }),
    );
  }

  it('runs the saga to recovery on a real server, fast-forwarding the durable retry sleep', async () => {
    const port = new ScriptedPort();
    const res = await runWorkflow(port, 'wf-recover-1');

    expect(res.status).toBe('recovered');
    // Two distinct attempts settled (attempt 1 failed, attempt 2 succeeded).
    expect(port.settledKeys.size).toBe(2);
    expect(res.timeline.some((e) => e.kind === 'slept')).toBe(true); // the durable sleep ran
  }, 120_000);

  it('does not double-charge when an activity retries (exactly-once under replay)', async () => {
    // Blip on the 2nd execute() call → Temporal retries that activity. The retry reuses
    // the same attemptNumber-derived key, so only distinct attempts settle.
    const port = new ScriptedPort({ blipOnCall: 2 });
    const res = await runWorkflow(port, 'wf-exactly-once-1');

    expect(res.status).toBe('recovered');
    // execute() ran at least 3 times (attempt1, attempt2-blip, attempt2-retry)…
    expect(port.executeCalls).toBeGreaterThanOrEqual(3);
    // …but only TWO distinct idempotency keys ever settled — the retry did not add a third.
    expect(port.settledKeys.size).toBe(2);
  }, 120_000);
});
