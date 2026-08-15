# RUNBOOK — the recovery worker & live charging

The **recovery worker** is the process that runs the durable charge saga: it hosts the
Temporal `recoveryWorkflow`, sleeps durably between retries (a retry scheduled three days
out survives restarts/deploys/crashes), and executes each attempt through the real
`engine → guardrail → adapter` path with exactly-once idempotency.

Two processes, one task queue:

| Process | Command | Role |
|---|---|---|
| **HTTP API** | `pnpm --filter @ax10m/api start` | Ingests webhooks; **dispatches** a workflow per treatment case (when `AX10M_DURABLE_RECOVERY=true`). |
| **Worker** | `pnpm --filter @ax10m/api run worker` | **Hosts** the workflows + activities; does the actual charging. |

## Safety gate (read first)

- **Shadow is the default.** With `AX10M_LIVE_CHARGING` unset or not `true`, the worker
  plans and measures but the charge path stops before any money moves. The startup log
  states the mode explicitly.
- **Live charging requires two things at once:** `AX10M_LIVE_CHARGING=true` **and** real
  processor credentials in the worker's environment. Neither alone moves money.
- **No secrets in the repo.** Processor keys live only in the worker host's environment
  (or a secrets manager). `.env.example` holds placeholders only.

## Local end-to-end (dev)

```bash
# 1. Start a local Temporal cluster (UI at http://localhost:8080).
docker compose -f docker-compose.temporal.yml up -d

# 2. Build the API (compiles the worker entry + the workflow bundle).
corepack pnpm --filter @ax10m/api build

# 3. Run the worker — SHADOW mode (no money moves).
TEMPORAL_ADDRESS=localhost:7233 corepack pnpm --filter @ax10m/api run worker

# 4. In another shell, run the API with durable dispatch on.
AX10M_DURABLE_RECOVERY=true TEMPORAL_ADDRESS=localhost:7233 \
  corepack pnpm --filter @ax10m/api start
```

A treatment-bucket `invoice.failed` webhook now starts a durable workflow (visible in the
Temporal UI). The saga plans → sleeps to the retry time → executes. In shadow it records
the intent; flip `AX10M_LIVE_CHARGING=true` on the worker (with real creds) to charge.

## Going live (production)

1. Point `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` at your Temporal Cloud or self-hosted
   cluster; use the same `TEMPORAL_TASK_QUEUE` on the API and worker.
2. Provision **restricted** processor credentials (SAQ-A, token-only — never a PAN) in the
   worker's environment. Verify the adapter's connection resolves for the merchant.
3. Start with `AX10M_LIVE_CHARGING=false` and confirm the shadow ledger looks right.
4. Set `AX10M_LIVE_CHARGING=true`. Roll out to a small merchant first; the holdout keeps
   billing honest (unproven months bill $0).

## Exactly-once & durability (how it holds)

The saga owns `attemptNumber`; the adapter derives its idempotency key from it. A worker
crash mid-attempt makes Temporal **replay** the activity with the *same* attemptNumber, so
the processor de-dupes instead of double-charging. This is verified against a **real
Temporal server** in `packages/scheduler/src/temporal/worker.e2e.test.ts` (time-skipping
test server: it runs the workflow, fast-forwards the multi-day sleep, and asserts an
activity retry settles no second charge).

## Shared ledger (worker + API → one chain)

With `DATABASE_URL` set (real Postgres), the API and the worker append to **one** shared
hash-chained ledger: both build a `PersistedLedgerPort` over the same database, so a charge
the worker records is in the same tamper-evident chain the API reads and the retrainer
consumes. Concurrent appends from the two processes are serialized by a transaction-scoped
advisory lock (with a seq-collision retry backstop), so the chain stays contiguous and
`verifyChain` passes — proven under concurrent writes in
`apps/api/src/recovery/shared-ledger.e2e.test.ts`.

Without `DATABASE_URL`, each process keeps its own in-memory ledger — **pglite is
single-process and cannot be shared across the API and worker**, so the shared ledger
requires Postgres. The worker's startup log prints `ledger=shared-postgres` or
`ledger=in-memory(single-process)` so you can see which mode you're in.

## Known limitations (honest)

- **Auto-dispatch needs the failed payment method on the event.** The API enqueues a
  durable saga only when the normalized `invoice.failed` event carries `payload.method`.
  Adapters that don't yet populate it fall back to inline shadow planning (logged).
- **Worker connections are preloaded at startup.** New merchant connections require a
  worker restart (the saga's adapter resolver is synchronous).
- **No real charge has been executed from this repo.** The durable machinery is proven
  against the Temporal test server with scripted/fake processors; moving real money
  requires an operator to supply real credentials and a real cluster.
