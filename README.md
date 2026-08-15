# AX10M — AI-Native Failed-Payment Recovery

> Overlays Stripe Smart Retries (and any processor) and bills **12% of
> live-holdout-verified uplift** — the lower bound of a real randomized experiment,
> recorded in a signed, reconcilable ledger. The only recovery engine that proves
> its lift with a live control group instead of a trust-me baseline.

A merchant connects (OAuth, zero code), AX10M measures their true baseline in
**shadow mode**, shows the *projected* uplift and would-be fee **before** activation,
then — once live — runs a stratified randomized holdout, drives recovery with the
retry engine, bills only the statistically-proven lower bound, and hands the CFO a
signed statement they can reconcile **penny-for-penny against the processor's own
payout**. That reconcilable ledger is the defensible edge; the statistics are how we
keep the bill honest.

> ### Honest status (read `docs/STRATEGY.md`)
> The **product is the recovery engine** — the retry brain that must beat Stripe
> Smart Retries. The measurement (holdout + mSPRT + signed ledger) is the **pricing
> and trust mechanism**, not the product. The measurement is rigorous; the engine
> (`@ax10m/recovery-engine`) is **not yet a winner**. The first backtest
> (`packages/backtest`, Phase 1 — engine vs a faithful Smart Retries baseline in a
> synthetic, source-grounded world) found the engine **does not beat the baseline and
> currently *underperforms* it on recovery rate by ~19 pp**, because its retry cadence
> is front-loaded (last attempt ~day 11) while real recovery onsets — paydays, card
> reissues — run 2–4 weeks, so the baseline's later attempts recover more. The A/A test
> passed, so the estimator is sound; the sign is stable across a ±30% sensitivity sweep.
> **Update — timing rework + fairness sweep.** A decline-specific cadence rework
> (reaching into the 2-4 week recovery window) closed that gap: the engine now roughly
> **matches** Smart Retries' default. But the decisive check: against a baseline that
> simply retries *as far as the engine*, the engine **loses** (-8 to -11 pp). So the
> apparent gain was a window-length artifact any baseline can copy; decline-specific
> timing does not beat blanket persistence on recovery rate. The engine's case must rest
> on what recovery rate does not price — per-attempt cost, network-cap compliance, and
> the cross-merchant issuer flywheel (cold features here).
> **Update — net value (cost + compliance objective).** Pricing per-attempt cost and
> do-not-retry fines gives a mixed, honest result: against the Smart Retries **default**
> (~day 18, what merchants actually run) the engine now **wins on net value** — it recovers
> marginally more using **~22% fewer attempts** ($26.05 vs $24.91 per invoice). But against
> a **maximally-persistent** baseline that retries to window-close, the engine **loses**
> ($26.05 vs $32.59); brute persistence recovers so much more that its extra cost and fines
> don't close the gap, and the engine only overtakes it once the do-not-retry fine reaches
> an **implausible ~$20/violation**. So: a real edge over what merchants run today (cheaper,
> equal-or-better), no edge over "just retry longer." AX10M's incremental *lift* is still
> **not yet demonstrated** and the bill would be **$0** either way.
> See [`packages/backtest/out/report.md`](packages/backtest/out/report.md) (verdict +
> assumptions) and [`docs/STRATEGY.md`](docs/STRATEGY.md).

**Design & specs:** [`docs/STRATEGY.md`](docs/STRATEGY.md) (honest positioning &
roadmap) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md) (the mSPRT + CUPED math) ·
[`docs/PROCESSORS.md`](docs/PROCESSORS.md) (per-processor capability matrix) ·
[`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) (network retry caps + third-party charge authority) ·
[`docs/STANDARD.md`](docs/STANDARD.md) (VIS — the vendor-neutral verified-incrementality standard, DRAFT) ·
[`docs/COMPETITIVE.md`](docs/COMPETITIVE.md) (teardown) · [`docs/DEPLOY.md`](docs/DEPLOY.md) · `docs/pitch.html`.

## Monorepo layout

```
lift/
├─ docs/                          # ARCHITECTURE · ATTRIBUTION · PROCESSORS · COMPETITIVE · pitch
├─ packages/
│  ├─ canonical/                  # canonical entities + decline taxonomy (isRetriable)
│  ├─ poal/                       # Payment Orchestration Abstraction Layer + adapters
│  │  ├─ stripe/                  # Stripe adapter (implemented: /pay charge, signed webhooks, reconciler)
│  │  ├─ adapters/                # ~17 webhook-capable adapters + 13 enterprise skeletons + registry
│  │  └─ factory.ts               # buildAdapter(processor, merchantId, config) for per-merchant routing
│  ├─ recovery-engine/           # ★ the recovery brain: recoverability (trained) · retry-timing · decline-intel · ARSE sequencer · feature store (flywheel) · retrain job · bandit
│  ├─ attribution/               # holdout · mSPRT+CUPED uplift · hash-chained ledger · statement · CFO reconciliation
│  ├─ guardrail/                  # compliance hard-constraints (card-network retry caps, quiet hours, consent, fraud)
│  ├─ onboarding/                 # shadow-first lifecycle + projection ("see the money before you pay")
│  ├─ scheduler/                  # durable charge scheduler: adaptive + ARSE-sequenced sagas + Temporal binding
│  ├─ protocol/                   # the AX10M Protocol (AXP-01..06) typed message spec
│  ├─ persistence/                # Postgres (Drizzle): restart-safe ledger + encrypted per-merchant creds
│  └─ backtest/                   # engine-vs-Smart-Retries backtest (Phase 1) + demo-data generator
└─ apps/
   ├─ api/                        # NestJS: webhook ingress (5 processors) · reconciler · recovery · onboarding
   └─ dashboard/                  # Next.js: shadow banner + projected uplift + cohort table + CFO reconciliation panel
```

### The packages

- **`@ax10m/canonical`** — the vocabulary everything speaks: `Merchant`, `Customer`,
  `PaymentMethod`, `Subscription`, `Invoice`, `ChargeAttempt`, `DeclineEvent`,
  `RecoveryCase`, `CanonicalEvent`, plus the soft/hard/gray decline taxonomy and
  `isRetriable(code)`.
- **`@ax10m/poal`** — the `ProcessorAdapter` interface + `CapabilityMatrix`
  (`integrationMode: drive | co-drive | advisory`) that make AX10M processor-agnostic,
  deterministic idempotency keys (exactly-once), a **registry** of 24 processors,
  and the adapters (see coverage table).
- **`@ax10m/recovery-engine`** — the product core: given a failed invoice, decide
  WHETHER to retry, WHEN (decline-aware timing — NSF→payday, issuer-error→quick,
  do-not-honor→escalating backoff), WITH WHICH credential, or route to card-update
  comms — plus the expected-value reward. Ships a `RetryPolicy`/`ContextualBanditPolicy`
  interface so a learned policy replaces the cold-start heuristic unchanged. The
  engine PROPOSES; the guardrail DISPOSES.
- **`@ax10m/attribution`** — measurement + billing. Deterministic customer-clustered,
  stratified holdout assignment; the **billing-safe estimator** (CUPED variance
  reduction + cluster-robust variance + an always-valid **mSPRT confidence
  sequence**, billed on the lower bound); an append-only **hash-chained ledger**
  (tamper-evident); the monthly **Uplift Statement**; and the **CFO reconciliation
  export** (`reconcileAgainstPayout` + Ed25519-signed statement).
- **`@ax10m/guardrail`** — a hard-constraint layer: `evaluate(action)` → allow /
  suppress + reason. Network caps, hard-decline suppression, quiet hours, and
  consent always override the learned policy.
- **`@ax10m/onboarding`** — the shadow-first lifecycle (`connect → shadow → active`)
  and the projection engine that estimates uplift from baseline-only observation
  (conservative per-decline-code priors, only over invoices the baseline missed,
  clearly labeled `holdoutVerified: false`).
- **`@ax10m/scheduler`** — the durable charge scheduler. A runtime-agnostic recovery
  saga (plan → sleep-until-`retryAt` → execute → loop) plus an ARSE **sequenced** saga
  that executes a full up-front schedule, hosted by Temporal (durable, replay-safe
  sleeps). Exactly-once via a saga-owned `attemptNumber` → deterministic idempotency key.
- **`@ax10m/protocol`** — the **AX10M Protocol (AXP)**: typed, versioned messages
  (AXP-01 decline normalization … AXP-06 merchant onboarding) so processors, MoRs, and
  merchants speak "payment uplift" the same way. Draft v0.1 (`docs/AXP.md`).

## Processor coverage

One canonical core, an adapter per processor. `drive` = we re-attempt the charge;
`co-drive` = we recover alongside the processor's own retries; `advisory` = the
platform owns the token, we measure + prompt. See `docs/PROCESSORS.md` for the full
capability matrix.

| Processor | Segment | Mode | Status |
|---|---|---|---|
| **Chargebee** | billing platform | drive | ✅ implemented (collect_payment, Basic-auth webhooks, reconciler) |
| **Adyen** | card gateway | drive | ✅ implemented (Checkout /payments, HMAC webhooks, stored methods) |
| **Braintree** | card gateway | drive | ✅ implemented (classic-gateway sale, HMAC-SHA1 webhooks, vault) |
| **GoCardless** | bank debit | co-drive | ✅ implemented (retry action + Success+ deconfliction, signed webhooks, poll) |
| **Stripe** | card gateway | drive | ✅ implemented (`/invoices/{id}/pay`, Stripe-Signature webhooks, reconciler) |
| **PayPal · Checkout.com · Worldpay · TSYS · Elavon** | card gateway | drive | ✅ implemented (token charge, signed webhooks) |
| **Recurly · Zuora · Maxio** | billing platform | co-drive/drive | ✅ implemented |
| **Shopify · WooCommerce** | e-commerce | co-drive | ✅ implemented (billing-attempt trigger, HMAC webhooks) |
| **BigCommerce · Kajabi · ThriveCart · SamCart** | e-commerce/creator | advisory | ✅ implemented (measure + prompt) |
| **Paddle** | merchant of record | advisory | skeleton (measure + prompt; MoR owns the token) |
| _+ 13 enterprise billing platforms_ | — | co-drive | skeleton (capability matrix real; API TODO) |

Every implemented adapter follows the same template: an **injectable `fetch`
transport** (so it's unit-tested against a fake), canonical decline mapping,
verified webhooks, and token/mandate-based charges (**never a PAN — SAQ-A**).

## The end-to-end flow

```
processor webhook ─▶ adapter.ingestWebhook (signature/HMAC verified)
   ─▶ canonical invoice.failed
      ─▶ shadow mode: record baseline observation → projected uplift + would-be fee
      ─▶ active mode: holdout assign → guardrail → (Phase 1) charge
   ─▶ hash-chained ledger  ─▶ mSPRT+CUPED lower-bound bill  ─▶ signed, CFO-reconcilable statement
```

## Prerequisites

- Node ≥ 20
- pnpm ≥ 9. If `corepack enable` can't write shims (e.g. Windows Program Files),
  invoke pnpm through corepack directly: `corepack pnpm <cmd>`.

## Commands

```bash
corepack pnpm install                         # install the whole workspace

corepack pnpm build                           # build every package/app in dep order
corepack pnpm -r run typecheck                # type-check everything
corepack pnpm --filter @ax10m/api run build    # NestJS build
corepack pnpm --filter @ax10m/dashboard run build   # Next.js build (statically prerenders)

# Tests — run the explicit filter list (NOT `pnpm -r test`: @ax10m/canonical has no
# test files, so vitest exits 1 and halts the recursive run). See CONTRIBUTING.md.
corepack pnpm --filter @ax10m/attribution --filter @ax10m/guardrail \
  --filter @ax10m/onboarding --filter @ax10m/poal --filter @ax10m/recovery-engine \
  --filter @ax10m/scheduler --filter @ax10m/protocol --filter @ax10m/api test

# Dev servers:
corepack pnpm --filter @ax10m/api dev          # NestJS on :4000
corepack pnpm --filter @ax10m/dashboard dev    # Next.js on :3000
```

**391 unit tests** across the packages (poal 220 · recovery-engine 40 · attribution 41 ·
persistence 7 · backtest 4 ·
scheduler 23 · api 21 · onboarding 18 · guardrail 13 · protocol 4), all green; the whole
workspace typechecks and both apps build. See [`docs/BASELINE.md`](docs/BASELINE.md) for
the authoritative verification snapshot.

### Webhook endpoints (apps/api)

`POST /webhooks/:processor/:connectionId` (per-merchant) and `POST /webhooks/:processor`
(single-tenant default) — the router resolves the merchant + credentials from the
connection, builds that merchant's adapter (`buildAdapter`), which verifies the
signature/auth, normalizes to canonical events, and feeds holdout assignment + shadow
measurement. Onboarding: `POST /onboarding/connect`,
`GET /onboarding/:merchantId/status`, `POST /onboarding/:merchantId/activate`.

## Environment

Copy `.env.example` → `.env` and fill in real values **locally only**. The example
contains placeholders exclusively — **never commit real secrets**. Processor keys
must be **restricted, least-privilege** keys (ARCHITECTURE.md §7).

## What's implemented vs. stubbed

**Implemented (real logic + unit tests):**
- Canonical schema + decline taxonomy (`isRetriable`, family mapping).
- Customer-clustered, stratified holdout assignment (stable, reproducible).
- **Billing-safe estimator**: CUPED + cluster-robust variance + mSPRT confidence
  sequence, billed on the lower bound; min-sample + SRM gating; monotone accrual.
- Append-only hash-chained ledger + `verifyChain`; monthly Uplift Statement.
- **CFO reconciliation**: `reconcileAgainstPayout` tie-out + Ed25519-signed export.
- Compliance guardrail `evaluate` (caps, hard-decline, quiet hours, consent).
- **~17 processor adapters end-to-end** incl. **Stripe**, Adyen, Braintree, PayPal,
  Checkout, Worldpay, TSYS, Elavon, Chargebee, Recurly, Zuora, Maxio, GoCardless,
  Shopify, WooCommerce (+ advisory BigCommerce/Kajabi/ThriveCart/SamCart): signed-webhook
  ingestion, token/mandate charges, reconciliation, decline mapping.
- **Per-merchant webhook routing**: `buildAdapter` factory + connection store + router.
- **Recovery engine**: trained (on a *synthetic* corpus) logistic recoverability model +
  online bandit + decline-code intelligence + network-aware **ARSE retry sequencer** +
  customer/issuer feature store (the flywheel) + ledger→corpus **retrain job** (champion/
  challenger gate).
- **Durable scheduler** (`@ax10m/scheduler`): adaptive + ARSE-sequenced sagas with a
  Temporal binding; exactly-once. *(Code exists; not deployed against a live cluster.)*
- **Shadow-first onboarding**: lifecycle + projection, wired to the webhook stream.
- Dashboard renders the real attribution + onboarding + reconciliation engines.

**Stubbed / not yet real (`TODO(ax10m)` markers):**
- **Live active charging.** The charge path + durable scheduler exist in code, but nothing
  runs them against a real processor — no live Temporal worker, no credentials. **Phase 0
  runs shadow mode — measures, never moves money.**
- **The engine is trained on synthetic data, not proven vs the incumbent** — see the
  honest-status block above; the backtest is what will test it.
- Persistence (`@ax10m/persistence`): Postgres via Drizzle — **restart-safe hash-chained
  ledger** (tested, incl. tamper-detection) + **per-merchant connections with credentials
  AES-256-GCM-encrypted at rest** + migrations + demo seed. The API's webhook router uses
  the DB-backed store when `DATABASE_URL` is set (else in-memory). *Remaining: the live
  `RecoveryCaseService` ledger is still in-memory (the async rewiring to the persisted
  repo is a follow-up); reconciler scheduling.*
- 13 enterprise billing-platform adapters are capability-accurate skeletons.
- Holdout-loss credit / certification-taper billing; live retention-value billing mode.

## Design invariants (do not break)

- **Never store or transmit a PAN.** Tokenization / mandates only (SAQ-A posture).
- **Exactly-once charging.** Every charge carries a deterministic idempotency key;
  the reconciler is the truth source.
- **Guardrail before execution.** The policy proposes; the guardrail disposes.
- **Bill the lower bound.** We deliberately under-claim; an unproven month bills $0.
- **The onboarding number is a projection, not the bill.** Only the live holdout
  produces a billable figure (`holdoutVerified: false` until active).
- **No real secrets in the repo, ever.**
```

## License

Proprietary — all rights reserved (pre-release).
