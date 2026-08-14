# Lift — AI-Native Failed-Payment Recovery

> Overlays Stripe Smart Retries (and any processor) and bills **12% of
> live-holdout-verified uplift** — the lower bound of a real randomized experiment,
> recorded in a signed, reconcilable ledger. The only recovery engine that proves
> its lift with a live control group instead of a trust-me baseline.

The end-to-end proof engine: a merchant connects (OAuth, zero code), Lift measures
their true baseline in **shadow mode** for 14 days and shows the *projected* uplift
and would-be fee **before** activation, then — once live — runs a stratified
randomized holdout, bills only the statistically-proven lower bound, and hands the
CFO a signed statement they can reconcile penny-for-penny against the processor's
own payout report.

**Design & specs:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md) (the mSPRT + CUPED math) ·
[`docs/PROCESSORS.md`](docs/PROCESSORS.md) (per-processor capability matrix) ·
[`docs/COMPETITIVE.md`](docs/COMPETITIVE.md) (teardown) · `docs/pitch.html`.

## Monorepo layout

```
lift/
├─ docs/                          # ARCHITECTURE · ATTRIBUTION · PROCESSORS · COMPETITIVE · pitch
├─ packages/
│  ├─ canonical/                  # canonical entities + decline taxonomy (isRetriable)
│  ├─ poal/                       # Payment Orchestration Abstraction Layer + adapters
│  │  ├─ stripe/                  # Stripe adapter (reference skeleton)
│  │  └─ adapters/                # adyen · braintree · chargebee · gocardless · paddle · registry
│  ├─ attribution/               # ★ holdout · mSPRT+CUPED uplift · hash-chained ledger · statement · CFO reconciliation
│  ├─ guardrail/                  # compliance hard-constraint layer (caps, quiet hours, consent)
│  └─ onboarding/                 # shadow-first lifecycle + projection ("see the money before you pay")
└─ apps/
   ├─ api/                        # NestJS: webhook ingress (5 processors) · reconciler · recovery · onboarding
   └─ dashboard/                  # Next.js: shadow banner + projected uplift + cohort table + CFO reconciliation panel
```

### The packages

- **`@lift/canonical`** — the vocabulary everything speaks: `Merchant`, `Customer`,
  `PaymentMethod`, `Subscription`, `Invoice`, `ChargeAttempt`, `DeclineEvent`,
  `RecoveryCase`, `CanonicalEvent`, plus the soft/hard/gray decline taxonomy and
  `isRetriable(code)`.
- **`@lift/poal`** — the `ProcessorAdapter` interface + `CapabilityMatrix`
  (`integrationMode: drive | co-drive | advisory`) that make Lift processor-agnostic,
  deterministic idempotency keys (exactly-once), a **registry** of 24 processors,
  and the adapters (see coverage table).
- **`@lift/attribution`** — the crown jewel. Deterministic customer-clustered,
  stratified holdout assignment; the **billing-safe estimator** (CUPED variance
  reduction + cluster-robust variance + an always-valid **mSPRT confidence
  sequence**, billed on the lower bound); an append-only **hash-chained ledger**
  (tamper-evident); the monthly **Uplift Statement**; and the **CFO reconciliation
  export** (`reconcileAgainstPayout` + Ed25519-signed statement).
- **`@lift/guardrail`** — a hard-constraint layer: `evaluate(action)` → allow /
  suppress + reason. Network caps, hard-decline suppression, quiet hours, and
  consent always override the learned policy.
- **`@lift/onboarding`** — the shadow-first lifecycle (`connect → shadow → active`)
  and the projection engine that estimates uplift from baseline-only observation
  (conservative per-decline-code priors, only over invoices the baseline missed,
  clearly labeled `holdoutVerified: false`).

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
| **Stripe** | card gateway | drive | reference skeleton (capability matrix real; API TODO) |
| **Paddle** | merchant of record | advisory | skeleton (measure + prompt; MoR owns the token) |
| _+ 18 more_ | — | — | mapped in the registry (`docs/PROCESSORS.md`) |

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
corepack pnpm --filter @lift/api run build    # NestJS build
corepack pnpm --filter @lift/dashboard run build   # Next.js build (statically prerenders)

# Tests (build @lift/canonical once first so the bare @lift/canonical import resolves):
corepack pnpm --filter @lift/canonical run build
corepack pnpm --filter @lift/attribution --filter @lift/poal --filter @lift/guardrail --filter @lift/onboarding test

# Dev servers:
corepack pnpm --filter @lift/api dev          # NestJS on :4000
corepack pnpm --filter @lift/dashboard dev    # Next.js on :3000
```

Roughly **113 unit tests** across the packages (attribution 41 · poal 46 ·
onboarding 18 · guardrail 8), all green; the whole workspace typechecks and both
apps build.

### Webhook endpoints (apps/api)

`POST /webhooks/{stripe,chargebee,adyen,braintree,gocardless}` — each verifies the
processor's signature/auth in its adapter, normalizes to canonical events, and feeds
holdout assignment + shadow measurement. Onboarding: `POST /onboarding/connect`,
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
- **Four processor adapters end-to-end** (Chargebee, Adyen, Braintree, GoCardless):
  signed-webhook ingestion, token/mandate charges, reconciliation, decline mapping.
- **Shadow-first onboarding**: lifecycle + projection, wired to the webhook stream.
- Dashboard renders the real attribution + onboarding + reconciliation engines.

**Stubbed with `TODO(lift)` markers:**
- Stripe adapter API calls / normalization (the other adapters are real).
- Per-merchant adapter resolution + persistence (in-memory today → Postgres).
- Reconciler scheduling; Temporal saga for durable, exactly-once **active charging**
  (Phase 0 runs **shadow mode** — measures, never moves money).
- ML models / bandits; live retention-value billing mode.

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
