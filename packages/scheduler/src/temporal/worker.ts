/**
 * Worker bootstrap — runs the recovery workflows + activities.
 *
 * Deploy this as a long-lived process next to a Temporal cluster. It hosts the
 * deterministic workflow code (loaded from the bundled `workflow.js`) and the
 * activities bound to a concrete `RecoveryCasePort` (the API's bridge to the
 * recovery-case service).
 *
 * `@temporalio/worker` carries a native core binary, so it is an OPTIONAL runtime
 * dependency — install it only where you actually run a worker:
 *     pnpm --filter @ax10m/scheduler add @temporalio/worker
 * It is imported dynamically below so the rest of the package (pure saga + client)
 * builds and ships without the native bridge.
 */

import { fileURLToPath } from 'node:url';
import { createRecoveryActivities } from './activities.js';
import { RECOVERY_TASK_QUEUE } from './client.js';
import type { RecoveryCasePort } from '../types.js';

export interface RecoveryWorkerOptions {
  /** The bridge to the recovery-case service (engine → guardrail → adapter). */
  port: RecoveryCasePort;
  /** Temporal frontend address. */
  address?: string;
  /** Task queue to poll (must match the client's). */
  taskQueue?: string;
  namespace?: string;
}

/**
 * Create and run the recovery worker. Resolves only when the worker shuts down.
 * Throws a clear message if the optional `@temporalio/worker` dep isn't installed.
 */
export async function runRecoveryWorker(opts: RecoveryWorkerOptions): Promise<void> {
  // Non-literal specifier: keep tsc from requiring the optional native package at
  // build time. Present only when a worker is actually deployed.
  const workerSpecifier = '@temporalio/worker';
  let workerModule: {
    NativeConnection: { connect(o: { address?: string }): Promise<unknown> };
    Worker: { create(o: Record<string, unknown>): Promise<{ run(): Promise<void> }> };
  };
  try {
    workerModule = (await import(workerSpecifier)) as typeof workerModule;
  } catch {
    throw new Error(
      "runRecoveryWorker: '@temporalio/worker' is not installed. Run `pnpm --filter @ax10m/scheduler add @temporalio/worker` on the worker host.",
    );
  }

  const { NativeConnection, Worker } = workerModule;
  const connection = await NativeConnection.connect({ address: opts.address ?? '127.0.0.1:7233' });
  const worker = await Worker.create({
    connection,
    namespace: opts.namespace ?? 'default',
    taskQueue: opts.taskQueue ?? RECOVERY_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflow.js', import.meta.url)),
    activities: createRecoveryActivities(opts.port),
  });
  await worker.run();
}
