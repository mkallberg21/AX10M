/**
 * RecoveryDispatcher — the seam that hands a failed-invoice case to the DURABLE charge
 * path (a Temporal workflow) instead of running it inline. Keeping it behind an
 * interface means the recovery service has no Temporal dependency and stays fully
 * testable with a fake; production injects the Temporal-backed implementation.
 *
 * Idempotency at the workflow level: the workflowId is the canonical invoice id, so a
 * redelivered webhook (at-least-once) cannot start a second saga for the same case —
 * Temporal rejects a duplicate start.
 */

import { Logger } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import { RECOVERY_TASK_QUEUE, startRecoveryWorkflow, type RecoveryWorkflowInput } from '@ax10m/scheduler/temporal';

export interface DurableRecoveryRequest {
  /** Canonical case/invoice id → the Temporal workflowId (dedupes redelivered webhooks). */
  workflowId: string;
  input: RecoveryWorkflowInput;
}

export interface RecoveryDispatcher {
  /** Start (or reuse) the durable recovery saga for a case. */
  dispatch(req: DurableRecoveryRequest): Promise<void>;
}

/**
 * Default: do nothing. With no dispatcher configured, the service keeps its existing
 * shadow-plan-only behavior — no durable saga, no money. This keeps single-process dev
 * and every existing test unchanged.
 */
export class NoopRecoveryDispatcher implements RecoveryDispatcher {
  async dispatch(_req: DurableRecoveryRequest): Promise<void> {
    /* intentionally does nothing */
  }
}

/** Production dispatcher: starts the durable workflow on a Temporal cluster. */
export class TemporalRecoveryDispatcher implements RecoveryDispatcher {
  private readonly logger = new Logger(TemporalRecoveryDispatcher.name);

  constructor(
    private readonly client: Client,
    private readonly taskQueue: string = RECOVERY_TASK_QUEUE,
  ) {}

  async dispatch(req: DurableRecoveryRequest): Promise<void> {
    try {
      await startRecoveryWorkflow(this.client, req.workflowId, req.input, this.taskQueue);
      this.logger.debug(`Dispatched durable recovery workflow ${req.workflowId}`);
    } catch (err) {
      // A duplicate start for an already-running case is expected and safe (idempotent
      // at the workflow level); anything else is a real dispatch failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (/already started|WorkflowExecutionAlreadyStarted/i.test(msg)) {
        this.logger.debug(`Workflow ${req.workflowId} already running — reused (idempotent).`);
        return;
      }
      throw err;
    }
  }
}
