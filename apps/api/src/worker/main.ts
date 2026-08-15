/**
 * Recovery worker entrypoint. Long-lived process; run next to a Temporal cluster.
 *
 *   corepack pnpm --filter @ax10m/api run worker
 *
 * Requires `@temporalio/worker` (native bridge) on the host and processor credentials in
 * the environment. Defaults to SHADOW mode; set AX10M_LIVE_CHARGING=true to move money.
 * See docs/RUNBOOK-WORKER.md.
 */

import { startRecoveryWorker } from './recovery-worker.js';

startRecoveryWorker().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[recovery-worker] fatal:', err);
  process.exitCode = 1;
});
