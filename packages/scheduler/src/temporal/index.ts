/**
 * @ax10m/scheduler/temporal — the Temporal binding for the recovery saga.
 *
 * Exports the activity factory, the client-start helper, and the worker bootstrap.
 * The workflow module (`workflow.ts`) is intentionally NOT re-exported: it runs only
 * inside Temporal's workflow sandbox (its top-level `proxyActivities` call is invalid
 * in ordinary Node), so the worker loads it by path and clients start it by name.
 */

export * from './activities.js';
export * from './client.js';
export * from './worker.js';
export type { RecoveryWorkflowInput } from './workflow.js';
