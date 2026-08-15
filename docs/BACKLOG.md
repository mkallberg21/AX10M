# AX10M — Backlog

Out-of-scope-but-worth-doing items, captured here instead of derailing the current
phase (per the build-plan rule "no scope creep"). Not prioritized; the phased plan
drives sequencing.

## Deferred from the phased plan / prior sessions
- ~~**Local Temporal harness + runnable worker.**~~ **DONE** — `docker-compose.temporal.yml`
  (dev cluster + UI), a runnable worker entry (`apps/api` `run worker`), the API-side durable
  dispatcher, and a real worker e2e (`packages/scheduler/src/temporal/worker.e2e.test.ts`,
  time-skipping Temporal server) that proves the durable saga + exactly-once-under-retry.
  See `docs/RUNBOOK-WORKER.md`. **Remaining to actually charge real money:** an operator
  supplies real processor creds + a real cluster, and flips `AX10M_LIVE_CHARGING=true`.
- ~~**Shared persisted ledger across worker + API.**~~ **DONE** — a `LedgerPort` seam
  (in-memory default; `PersistedLedgerPort` over `@ax10m/persistence` `LedgerRepository`).
  With `DATABASE_URL` set, both the API and worker append to one shared hash-chained ledger,
  serialized by a transaction-scoped advisory lock (seq-collision retry backstop); proven
  contiguous + `verifyChain`-valid under concurrent writes in
  `apps/api/src/recovery/shared-ledger.e2e.test.ts`.
- ~~**Run the retrainer against the persisted ledger.**~~ **DONE** — `runRetrainJob`
  (`apps/api/src/recovery/retrain-job.ts`, `run retrain`) reads the persisted ledger, runs
  the champion/challenger gate, and on promotion persists the new champion to a versioned
  model store (`recovery_models`) + records a `model.promoted` ledger event. The API and
  worker load the active champion at startup (`useChampion`), closing the flywheel. Proven
  end-to-end in `apps/api/src/recovery/retrain-persisted.e2e.test.ts` (fills the persisted
  ledger by running the service, promotes, persists, reloads). *Remaining downstream: run
  it against real Postgres filled by real charges (needs live charging on).*
- **Adapters populate `invoice.failed` payload.method.** The API auto-dispatches a durable
  saga only when the normalized failure event carries the failed payment method. Have each
  adapter's `ingestWebhook` include it so durable dispatch covers every processor (today it
  falls back to inline shadow planning when absent).
- ~~**Credential recovery in the live charge path.**~~ **DONE** — `executeRecovery` now, for
  dead-credential declines, runs `executeCredentialRecovery`: `card_refresh` (via
  `adapter.fetchUpdatedCard` → charge the Account-Updater-refreshed credential) then
  `alternate_rail` (via `adapter.listPaymentMethods` → charge a backup method), each
  guardrailed as a `fresh_credential_charge` (a new guardrail kind that skips the dead-card
  hard-decline / non-retriable blocks but keeps caps + opt-out), with distinct idempotency
  keys per method. The `Customer` now threads through the durable Temporal saga too
  (`AttemptInput.customer` → port → `executeRecovery`; the webhook path forwards
  `payload.customer`), and the **drive/co-drive adapters now populate `payload.customer` on
  `invoice.failed`** (shared `customerFromInvoice` helper strips the `ax10m_cus_` prefix to
  recover the processor customer ref `listPaymentMethods` queries by), so alt-rail fires from
  real webhooks end-to-end. The **network retry-cap is now accounted PER CREDENTIAL** (card
  token), not per case: the service tracks an attempt count keyed by (invoice, card token)
  and feeds it into the guardrail's `attemptsInWindow`, so a refreshed / backup card starts
  with a fresh window while the global attempt cap stays per-case (prevents infinite
  credential-hopping). Min-interval spacing stays the saga's job (its durable sleeps), driven
  by the caller's `minutesSinceLastAttempt` — the service does NOT enforce it from its own wall
  clock (that would misfire under the saga's virtual/durable clock). The per-credential
  counter is now **persisted + shared** (a `CredentialAttemptStore` seam like the ledger:
  in-memory default, `PersistedCredentialAttemptStore` over a `credential_attempts` table
  when `DATABASE_URL` is set; `increment` is an atomic `ON CONFLICT DO UPDATE count+1`),
  so the network-cap count survives restarts and is shared across the API + worker — proven
  in `persistence.test.ts` (concurrent bumps lose no increments, independent per card,
  survives a restart). *Remaining: advisory adapters (BigCommerce/Kajabi/SamCart/ThriveCart)
  can't charge so they skip customer; the adapter-provided customer is minimal (no email/
  issuer region) — richer fields would need a customer-details fetch; a saga-timeline
  per-credential min-interval is a further refinement.*

## Hygiene / correctness
- **`@ax10m/canonical` has no tests**, which breaks `pnpm -r test`. Add a trivial test
  (e.g. `isRetriable`/`familyOf` coverage) or set `passWithNoTests` so the recursive
  runner doesn't halt.
- **Stale factual claims in `README.md` and `docs/STRATEGY.md`.** Both predate this
  session's work: README's coverage table (Stripe listed as skeleton), the "~113 unit
  tests" figure, the monorepo layout (missing `scheduler`, `protocol`), and STRATEGY §5
  ("the Stripe adapter is the skeleton") are now false. The **honest-status blocks stay**
  (the engine is still unproven vs the incumbent); only the stale implementation facts
  need refreshing. Partially addressed in Phase 0; finish as docs settle.

## Compliance hardening (from docs/COMPLIANCE.md)
- **Honor the raw network advice/response code, not the inferred canonical family.**
  Adapters map the issuer response → canonical `DeclineCode` and discard the raw
  Mastercard Merchant Advice Code (MAC) / Visa reattempt category. The guardrail then
  infers retriability from the family. The authoritative signal is the raw code. Add a
  `networkRetryAdvice` ('do_not_retry' | 'retry_after' | 'ok') + `retryAfterDays` to the
  adapter output + `ProposedAction`, and enforce it as a hard suppression overriding
  inference. (COMPLIANCE.md §1.4 — a real gap.)
- **Source retry caps from a maintained per-network/region/MCC table**, not one
  default; confirm the exact current numbers against Visa Core Rules + Mastercard TPR +
  the acquirer. The shipped caps are conservative placeholders (COMPLIANCE.md §1.3).
- **Third-party charge authority on Stripe** — confirm the permitted integration model
  + scopes with Stripe partnerships + legal counsel before live drive; default to
  advisory mode where unconfirmed (COMPLIANCE.md §2). Not a code task.

## Holdout economics (from STRATEGY §2, roadmap)
- `holdoutLossCredit` in the billing worksheet — credit the control arm's forgone
  recovery against the fee during the certification window.
- "Estimated holdout cost" line on the Uplift Statement.
- Certification-window → thin-audit-holdout taper as an enforced policy.

## Depth (later)
- Cross-merchant issuer/BIN model beyond the per-BIN Beta-shrunk prior.
- Retention-value (LTV) billing mode alongside recovered-dollars.
- Licensed BIN→region database to replace the illustrative seed table.
