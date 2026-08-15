/**
 * Temporal connection settings, read from the environment. Shared by the worker
 * bootstrap and the client so a deployment configures both from one place.
 *
 * SAFE BY DEFAULT: `liveCharging` is false unless AX10M_LIVE_CHARGING is explicitly
 * "true". Everything else defaults to a local dev cluster. No secret ever lives here —
 * processor credentials are resolved separately (per-merchant connection store).
 */

export interface TemporalEnv {
  address: string;
  namespace: string;
  taskQueue: string;
  /** false → shadow mode (no money moves). Flip ONLY with AX10M_LIVE_CHARGING=true. */
  liveCharging: boolean;
}

const DEFAULT_TASK_QUEUE = 'ax10m-recovery';

export function readTemporalEnv(env: NodeJS.ProcessEnv = process.env): TemporalEnv {
  return {
    address: env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE,
    liveCharging: env.AX10M_LIVE_CHARGING === 'true',
  };
}
