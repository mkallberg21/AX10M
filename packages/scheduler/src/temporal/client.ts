/**
 * Client helper — start a recovery saga workflow.
 *
 * The API calls this when a treatment-bucket invoice fails: it kicks off one durable
 * workflow per case, keyed by the case's canonical id so a redelivered webhook can't
 * start a duplicate saga (Temporal rejects a second start with the same workflowId,
 * or we reuse the running one). The workflow is referenced BY NAME so this module —
 * which runs in ordinary Node — never imports the workflow sandbox code.
 */

import { Client, Connection, type WorkflowHandle } from '@temporalio/client';
import type { RecoveryWorkflowInput } from './workflow.js';

/** Task queue the recovery worker polls. */
export const RECOVERY_TASK_QUEUE = 'ax10m-recovery';

/** Connect a Temporal client (address defaults to a local dev server). */
export async function createRecoveryClient(address = '127.0.0.1:7233'): Promise<Client> {
  const connection = await Connection.connect({ address });
  return new Client({ connection });
}

/**
 * Start (or reuse) the recovery saga for a case. `workflowId` MUST be the canonical
 * case/invoice id so redelivered webhooks are idempotent at the workflow level.
 */
export async function startRecoveryWorkflow(
  client: Client,
  workflowId: string,
  input: RecoveryWorkflowInput,
): Promise<WorkflowHandle> {
  return client.workflow.start('recoveryWorkflow', {
    taskQueue: RECOVERY_TASK_QUEUE,
    workflowId,
    args: [input],
    // Reuse-policy is deployment-specific; the caller can pass a richer options set.
  });
}
