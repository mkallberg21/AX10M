/**
 * Recovery WORKER host — the process that actually runs the durable charge saga.
 *
 * Assembles the real recovery-case service + a per-merchant adapter resolver (built from
 * the configured processor connections) into a `ServiceRecoveryCasePort`, then runs a
 * Temporal worker that polls the recovery task queue. This is the deployable other half
 * of the HTTP API: the API ingests webhooks and DISPATCHES workflows; this worker HOSTS
 * them (durable timers, activity retries, exactly-once charging).
 *
 * SAFE BY DEFAULT: shadow mode unless `AX10M_LIVE_CHARGING=true`. In shadow the saga
 * plans and measures but the charge path stops before any money moves.
 *
 * Run it:  corepack pnpm --filter @ax10m/api run worker      (see docs/RUNBOOK-WORKER.md)
 */

import { buildAdapter, type ProcessorAdapter } from '@ax10m/poal';
import type { Invoice } from '@ax10m/canonical';
import { readTemporalEnv, runRecoveryWorker } from '@ax10m/scheduler/temporal';
import { OnboardingService } from '../onboarding/onboarding.service.js';
import { RecoveryCaseService } from '../recovery/recovery-case.service.js';
import { ServiceRecoveryCasePort, type AdapterResolver } from '../recovery/recovery-case.port.js';
import { buildLedgerPort } from '../recovery/ledger-port.js';
import { buildCredentialAttemptStore } from '../recovery/credential-attempt-store.js';
import { buildFeatureStore } from '../recovery/feature-store-builder.js';
import { buildDunningComms } from '../recovery/dunning-comms-builder.js';
import { buildSendDedupeStore } from '../recovery/send-dedupe-store.js';
import { loadActiveChampion } from '../recovery/retrain-job.js';
import { buildConnectionStore } from '../webhooks/merchant-connections.js';

export interface RecoveryWorkerRuntime {
  service: RecoveryCaseService;
  port: ServiceRecoveryCasePort;
  shadow: boolean;
  /** true when appending to the shared persisted (Postgres) ledger, not in-memory. */
  sharedLedger: boolean;
  address: string;
  namespace: string;
  taskQueue: string;
}

/**
 * Assemble the worker's runtime: real service, an adapter resolver preloaded from the
 * configured connections, and the scheduler port (shadow = !liveCharging).
 */
export async function buildRecoveryWorkerRuntime(env: NodeJS.ProcessEnv = process.env): Promise<RecoveryWorkerRuntime> {
  const temporal = readTemporalEnv(env);
  const service = new RecoveryCaseService(new OnboardingService());

  // Share the persisted ledger with the API (same Postgres) so the worker's real charges
  // land in the chain the API reads and the retrainer consumes. Falls back to in-memory
  // (single-process) when no DATABASE_URL is set.
  const ledger = await buildLedgerPort(env);
  if (ledger) service.useLedger(ledger);
  const sharedLedger = ledger !== null;
  // Share the per-credential network-cap counter across API + worker (same Postgres).
  const credentialAttempts = await buildCredentialAttemptStore(env);
  if (credentialAttempts) service.useCredentialAttempts(credentialAttempts);
  const featureStore = buildFeatureStore(env);
  if (featureStore) service.useFeatureStore(featureStore);
  // Load the active retrained champion (if any) so the worker charges with the latest model.
  const champion = await loadActiveChampion({ env });
  if (champion) service.useChampion(champion);
  // Dunning comms: LLM personalization (real Anthropic client) when ANTHROPIC_API_KEY is set,
  // else the deterministic template; composition is opt-in via AX10M_CARD_UPDATE_URL + opt-out.
  const { agent: dunningAgent, config: dunningConfig, sender: dunningSender, live: liveComms } = buildDunningComms(env);
  service.useDunningAgent(dunningAgent, dunningConfig);
  if (dunningSender) service.useDunningSender(dunningSender, { live: liveComms });
  // Share the send-idempotency store across API + worker (same Postgres) so a reminder is sent once.
  const sendDedupe = await buildSendDedupeStore(env);
  if (sendDedupe) service.useSendDedupeStore(sendDedupe);

  // Preload the configured processor connections into a merchant→adapter map. The saga's
  // resolver is synchronous, so we resolve credentials up front (the worker starts with a
  // known, finite set of connections; new ones require a restart — noted in the RUNBOOK).
  const store = await buildConnectionStore(env);
  const connections = await store.list();
  const byMerchant = new Map<string, ProcessorAdapter>();
  let fallback: ProcessorAdapter | undefined;
  for (const c of connections) {
    const adapter = buildAdapter(c.processor, c.merchantId, c.config);
    byMerchant.set(c.merchantId, adapter);
    fallback ??= adapter;
  }

  const resolveAdapter: AdapterResolver = (invoice: Invoice): ProcessorAdapter => {
    const adapter = byMerchant.get(invoice.merchantId) ?? fallback;
    if (!adapter) {
      throw new Error(
        `No processor connection configured for merchant '${invoice.merchantId}'. ` +
          'Set processor credentials in the environment (e.g. STRIPE_SECRET_KEY) — see docs/RUNBOOK-WORKER.md.',
      );
    }
    return adapter;
  };

  const port = new ServiceRecoveryCasePort(service, resolveAdapter, /*shadow*/ !temporal.liveCharging);
  return {
    service,
    port,
    shadow: !temporal.liveCharging,
    sharedLedger,
    address: temporal.address,
    namespace: temporal.namespace,
    taskQueue: temporal.taskQueue,
  };
}

/** Build the runtime and run the worker until shutdown. */
export async function startRecoveryWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const rt = await buildRecoveryWorkerRuntime(env);
  // eslint-disable-next-line no-console
  console.log(
    `[recovery-worker] queue=${rt.taskQueue} address=${rt.address} namespace=${rt.namespace} ` +
      `ledger=${rt.sharedLedger ? 'shared-postgres' : 'in-memory(single-process)'} ` +
      `shadow=${rt.shadow}${rt.shadow ? ' (NO money will move — set AX10M_LIVE_CHARGING=true to charge)' : ' (LIVE CHARGING)'}`,
  );
  await runRecoveryWorker({ port: rt.port, address: rt.address, namespace: rt.namespace, taskQueue: rt.taskQueue });
}
