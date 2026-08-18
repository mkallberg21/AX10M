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
keep the bill honest. **The full loop — opt-in → holdout → signed statement →
holdout-credited billing → off-session charge → verify/reconcile — is built and
tested end to end.**

> ### Honest status (read `docs/STRATEGY.md`)
> The **product is the recovery engine** — the retry brain that must beat Stripe
> Smart Retries. The measurement (holdout + mSPRT + signed ledger) is the **pricing
> and trust mechanism**, not the product. **Current status: in the backtest the engine
> now BEATS a faithful Smart Retries baseline on recovery rate (+~13.8 pp) via a
> capability a blanket retry can't copy (dead-credential recovery), and wins on net
> value at every baseline reach (recovers more at ~22% fewer attempts). The magnitude
> is assumption-driven and unproven on a live merchant.** The honest journey to that
> result — it did NOT win at first — is preserved below.
>
> The first backtest (`packages/backtest`, Phase 1) found the engine **underperformed**
> Smart Retries by ~19 pp: its retry cadence was front-loaded (last attempt ~day 11)
> while real recovery onsets — paydays, card reissues — run 2–4 weeks. A decline-specific
> cadence rework closed the gap to ~parity with the default, but against a baseline that
> simply retries *as far as the engine* it **lost** (−8 to −11 pp): the apparent gain was
> a window-length artifact any baseline can copy. Pricing per-attempt cost + do-not-retry
> fines gave a **net-value** win over the Smart Retries **default** (~22% fewer attempts)
> but not over a maximally-persistent baseline. The breakthrough was **dead-credential
> recovery** — Account Updater (`card_refresh`), backup-rail fallback (`alternate_rail`),
> and dunning for expired/lost/stolen/closed cards a same-number retry structurally can't
> reach. The engine now **beats the default baseline by ~13.8 pp** (50.2% vs 36.4%),
> concentrated in credential codes (expired +56 pp), and the win **survives the fairness
> sweep** (narrows to ~parity only vs a maximally-persistent day-35 baseline — a longer
> retry catches up on soft declines but **never** on the dead-card book).
>
> **Update — the durable edge, built out.** The engine's edge over "just retry longer"
> is now realized in code: (1) a **cost/compliance-aware objective** that scores by net
> value and self-suppresses near-cap attempts before the guardrail must; (2) a
> **fully-learned LinUCB contextual-bandit policy** that learns per-action reward online
> and explores, grounded on the cost-aware objective at cold start; and (3) a **persisted,
> cross-merchant flywheel** that pools that learning across every merchant and survives
> restarts. All built + tested. HONEST CAVEATS: synthetic world, same author wrote the
> world dynamics and the engine capability, and the win's **magnitude** rests on the
> passive-vs-active coverage gap (labeled, swept) — a **live holdout is what proves it**.
> See [`packages/backtest/out/report.md`](packages/backtest/out/report.md) and
> [`docs/STRATEGY.md`](docs/STRATEGY.md).

**Design & specs:** [`docs/STRATEGY.md`](docs/STRATEGY.md) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md) (mSPRT + CUPED) · [`docs/PROCESSORS.md`](docs/PROCESSORS.md) ·
[`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) · [`docs/STANDARD.md`](docs/STANDARD.md) (VIS) ·
[`docs/COMPETITIVE.md`](docs/COMPETITIVE.md) · [`docs/DEPLOY.md`](docs/DEPLOY.md) · [`docs/AXP.md`](docs/AXP.md).

**Go-to-market, legal & procurement** (the non-code handoff for landing a design partner):
[Outreach](docs/DESIGN-PARTNER-OUTREACH.md) · [Certification runbook](docs/CERTIFICATION-RUNBOOK.md) ·
[Pricing summary](docs/PRICING-SUMMARY.md) · [Security & procurement](docs/SECURITY-PROCUREMENT.md) ·
[SIG/CAIQ pre-fill](docs/SIG-CAIQ-PREFILL.md) · [DPA template](docs/DPA-TEMPLATE.md) *(draft — counsel review)* ·
[Case-study template](docs/CASE-STUDY-TEMPLATE.md) · [Stripe App listing](docs/STRIPE-APP-LISTING.md) ·
[Marketplace prioritization](docs/MARKETPLACE-PRIORITIZATION.md) · [Go-live readiness](docs/GO-LIVE-READINESS.md) ·
[Terms](packages/billing/TERMS.md) *(draft — counsel review)*.

## Monorepo layout

```
lift/
├─ docs/                          # architecture/attribution/compliance + the GTM/legal/procurement set
├─ packages/                      # 12 packages
│  ├─ canonical/                  # canonical entities + decline taxonomy (isRetriable)
│  ├─ poal/                       # Payment Orchestration Abstraction Layer + ~17 adapters + registry
│  ├─ recovery-engine/           # ★ the recovery brain: recoverability (trained) · timing · decline-intel · ARSE ·
│  │                              #   cost/compliance objective · LinUCB contextual bandit · feature store + retrain
│  ├─ attribution/               # holdout · mSPRT+CUPED uplift · hash-chained ledger · signed statement · reconciliation
│  ├─ billing/                   # ★ opt-in accounts · versioned terms · signed acceptance · invoice + finance charge ·
│  │                              #   dunning stages · holdout economics (taper + credit) · ICP quote
│  ├─ comms/                      # dunning composer + validated LLM agent + send transport (Postmark/Twilio)
│  ├─ guardrail/                  # compliance hard-constraints (network caps, quiet hours, consent, opt-out)
│  ├─ onboarding/                 # shadow-first lifecycle + projection ("see the money before you pay")
│  ├─ scheduler/                  # durable charge scheduler: adaptive + ARSE-sequenced sagas + Temporal binding
│  ├─ protocol/                   # the AX10M Protocol (AXP-01..06) typed message spec
│  ├─ persistence/               # Postgres (Drizzle): restart-safe ledger · encrypted creds · bandit flywheel state
│  └─ backtest/                   # engine-vs-Smart-Retries backtest (Phase 1) + demo-data generator
└─ apps/
   ├─ api/                        # NestJS: webhook ingress · reconciler · recovery · onboarding · analytics · billing
   │   └─ scripts: run worker · run retrain · run bill · run dun
   └─ dashboard/                  # Next.js: shadow projection · live P&L (/pnl) · merchant opt-in portal (/opt-in)
```

### The packages

- **`@ax10m/canonical`** — the shared vocabulary: `Merchant`, `Customer`, `PaymentMethod`,
  `Invoice`, `DeclineEvent`, `CanonicalEvent`, `ReversalPayload`/reinstatement, the decline
  taxonomy + `isRetriable(code)`, and money types.
- **`@ax10m/poal`** — the `ProcessorAdapter` interface + `CapabilityMatrix` making AX10M
  processor-agnostic, deterministic idempotency (exactly-once), a **registry** of processors,
  and the adapters (coverage table below). Also exports a hand-rolled `StripeClient`.
- **`@ax10m/recovery-engine`** — the product core. Decides WHETHER to retry, WHEN
  (decline-aware timing), WITH WHICH credential, or route to card-update comms — scored by a
  **cost/compliance-aware net-value objective** (`CostAwarePolicy`, the default) and, when
  enabled, a **fully-learned `LinUcbBanditPolicy`** that learns per-action reward online +
  explores, grounded on the objective at cold start and **pooled across merchants** via a
  serializable, mergeable flywheel state. Plus the trained logistic recoverability model,
  decline-code intelligence, the network-aware **ARSE** retry sequencer, the customer/issuer
  **feature store**, and the ledger→corpus **retrain job** (champion/challenger gate). The
  engine PROPOSES; the guardrail DISPOSES.
- **`@ax10m/attribution`** — measurement + billing math. Customer-clustered, stratified holdout
  assignment; the **billing-safe estimator** (CUPED + cluster-robust variance + an always-valid
  **mSPRT** confidence sequence, billed on the lower bound); an append-only **hash-chained
  ledger**; the monthly **Uplift Statement**; the **CFO reconciliation** export + Ed25519 signer.
- **`@ax10m/billing`** — the monetization domain (pure). Opt-in `BillingAccount` (+ validation,
  no-PAN rule); versioned **terms** + hash; **Ed25519-signed clickwrap acceptance**; the
  **invoice** from a signed statement + finance-charge math (net-14, 1.5%/mo); **dunning stages**
  (issued → due-soon → overdue → final); **holdout economics** (certification→audit taper +
  holdout-loss credit so the effective rate stays ~12%); and the **ICP / time-to-proven-lift**
  quote.
- **`@ax10m/comms`** — dunning-copy composition (deterministic template + a validated LLM agent,
  no PAN, opt-out enforced, template fallback) and the **send transport** (Postmark email / Twilio
  SMS) behind a dry-run-default seam with retry + idempotency.
- **`@ax10m/guardrail`** — the hard-constraint layer: `evaluate(action)` → allow/suppress + reason.
  Network caps, hard-decline suppression, quiet hours, and consent always override the policy.
- **`@ax10m/onboarding`** — the shadow-first lifecycle (`connect → shadow → active`) and the
  conservative projection engine (labeled `holdoutVerified: false`).
- **`@ax10m/scheduler`** — the durable charge scheduler. A runtime-agnostic recovery saga (plan →
  sleep-until-`retryAt` → execute → loop) + an ARSE **sequenced** saga, hosted by Temporal
  (durable, replay-safe sleeps). Exactly-once via a saga-owned `attemptNumber`.
- **`@ax10m/protocol`** — the **AX10M Protocol (AXP)**: typed, versioned messages (AXP-01..06).
- **`@ax10m/persistence`** — Postgres via Drizzle. Restart-safe **hash-chained ledger**,
  **AES-256-GCM-encrypted per-merchant credentials**, versioned model store, credential + dunning
  idempotency stores, the **billing** tables (accounts/acceptances/invoices), and the
  **bandit flywheel state** — all migration-managed and shared across the API + worker.
- **`@ax10m/backtest`** — the Phase-1 world model + engine-vs-baseline harness + demo generator.

## The recovery brain (the durable edge)

The engine's case doesn't rest on recovery rate alone (a "just retry longer" baseline can match
that). It rests on what rate doesn't price, all now in code:

- **Dead-credential recovery** — Account Updater refresh, backup-rail fallback, and dunning reach
  cards a same-number retry never can. This is the source of the backtest win.
- **Cost/compliance-aware objective** — ranks actions by **net value** (expected recovery − attempt
  fee − expected near-cap fine cost), so the engine backs off *before* the guardrail's hard block.
- **Fully-learned contextual bandit** (LinUCB) — learns each action's reward per context from live
  outcomes and explores; grounded on the cost-aware objective at cold start (day-one behavior
  unchanged), then improves. Opt-in via `AX10M_BANDIT_POLICY=true`.
- **Cross-merchant flywheel** — the bandit's sufficient statistics are additive, so learning pools
  across every merchant into one persisted, restart-safe model (new merchants inherit fleet
  learning). Verified: two processes' contributions merge to exactly a single model that saw all.

## Billing & monetization (the honest fee loop)

The 12%-of-proven-uplift fee is fully productized — safe-by-default, verifiable, merchant-friendly:

- **Opt-in portal** — `POST /billing/opt-in` (+ the `/opt-in` dashboard page) captures the legal
  entity, AP contact, PO policy, and payer track, and signs an Ed25519 **clickwrap acceptance** of
  versioned terms. **Auto-pay** via `POST /billing/setup-intent` (Stripe SetupIntent — the card
  never touches AX10M) or **invoice/net-14**.
- **Autonomous monthly billing** (`run bill`) — computes each merchant's signed Uplift Statement
  (12% of the mSPRT-proven **lower bound**), applies the **holdout credit**, and (only when
  `AX10M_LIVE_BILLING=true`) collects via the **Stripe off-session charger** (idempotent, honest
  card-decline handling). `$0` in any month lift isn't proven.
- **Invoice delivery + dunning** (`run dun`) — emails invoices + net-14→finance-charge reminders to
  the AP inbox via the guardrail-fenced comms transport; dry-run unless live; exactly-once per
  (invoice, stage).
- **Holdout economics** — a certification window (90d @ 10% control) tapering to a ≤2% audit
  holdout, with the estimated holdout cost **credited against the fee** (net ≈ $0 during
  certification), disclosed on every statement.
- **Read-only views** — `GET /analytics/pnl` (live P&L), `GET /analytics/billing/preview`,
  `GET /billing/icp-quote` (fit + time-to-proven-lift).

## Processor coverage

One canonical core, an adapter per processor. `drive` = we re-attempt the charge; `co-drive` = we
recover alongside the processor's own retries; `advisory` = the platform owns the token, we measure
+ prompt. Full matrix in `docs/PROCESSORS.md`.

| Processor | Segment | Mode | Status |
|---|---|---|---|
| **Stripe** | card gateway | drive | ✅ charge, signed webhooks, refunds/disputes → net-recovery reversals, won-dispute re-credit |
| **Adyen · Braintree · Checkout.com · PayPal · GoCardless** | card / bank | drive/co-drive | ✅ implemented incl. refund/chargeback + won-dispute ingestion |
| **Worldpay · TSYS · Elavon** | card gateway | drive | ✅ implemented |
| **Chargebee · Recurly · Zuora · Maxio** | billing platform | drive/co-drive | ✅ implemented |
| **Shopify · WooCommerce** | e-commerce | co-drive | ✅ implemented |
| **BigCommerce · Kajabi · ThriveCart · SamCart** | e-commerce/creator | advisory | ✅ implemented (measure + prompt) |
| **Deluxe Merchant Services** (Deluxe Connect) | card gateway | drive | 🟡 skeleton (real drive API; field-level spec TODO — portal not fetchable) |
| **Cybersource · Authorize.Net · Fiserv · Global Payments · Square · Mollie · Nuvei · Razorpay · Stripe Billing · Vindicia · PayU · Apple/Google IAP** | card / billing / app-store | drive/co-drive/advisory | 🟡 skeleton (capability matrix real; field-level API TODO) |
| _+ 13 enterprise billing platforms_ | — | co-drive | skeleton (capability matrix real; API TODO) |

The **registry now has 0 `planned` entries**: every one of the 47 processors has a first-class
adapter (19 wired live end-to-end, 28 capability-accurate scaffolds ready for a mechanical fill-in).

Every implemented adapter follows the same template: an **injectable `fetch` transport** (unit-tested
against a fake), canonical decline mapping, verified webhooks, and token/mandate charges
(**never a PAN — SAQ-A**). Net-recovery accounting (refunds/chargebacks claw back the fee; won
disputes re-accrue it) is wired across every adapter with a reliable invoice mapping.

## The end-to-end flow

```
processor webhook ─▶ adapter.ingestWebhook (signature/HMAC verified)
   ─▶ canonical invoice.failed
      ─▶ shadow mode: baseline observation → projected uplift + would-be fee
      ─▶ active mode: holdout assign → cost/compliance policy (or bandit) → guardrail → charge
   ─▶ hash-chained ledger  ─▶ mSPRT+CUPED lower-bound  ─▶ holdout-credited signed statement
      ─▶ opt-in? → invoice/auto-pay charge → dunning → CFO reconciles to payout
```

## Prerequisites

- Node ≥ 20
- pnpm ≥ 9. If `corepack enable` can't write shims (e.g. Windows Program Files), invoke pnpm through
  corepack directly: `corepack pnpm <cmd>`.

## Commands

```bash
corepack pnpm install                 # install the whole workspace
corepack pnpm build                   # build every package/app in dep order
corepack pnpm -r run typecheck        # type-check everything
corepack pnpm -r test                 # run all tests (canonical passes with --passWithNoTests)

# Apps
corepack pnpm --filter @ax10m/api dev          # NestJS on :4000
corepack pnpm --filter @ax10m/dashboard dev    # Next.js on :3000  (/pnl, /opt-in)

# Scheduled jobs (apps/api dist)
corepack pnpm --filter @ax10m/api run worker    # durable recovery worker (Temporal)
corepack pnpm --filter @ax10m/api run retrain    # ledger→corpus retrain (champion/challenger)
corepack pnpm --filter @ax10m/api run bill        # monthly Uplift Statement + (live) collect
corepack pnpm --filter @ax10m/api run dun         # daily invoice delivery + dunning sweep
```

**~710 unit + e2e tests** across the 12 packages + api (poal 346 · recovery-engine 68 · api 104 ·
attribution 41 · comms 38 · billing 33 · scheduler 25 · onboarding 18 · guardrail 14 · persistence 11 ·
backtest 10 · protocol 4; canonical is types-only). All green **except** one pre-existing flaky
scheduler Temporal time-skipping e2e (`worker.e2e.test.ts`), which fails intermittently independent
of app logic. See [`docs/BASELINE.md`](docs/BASELINE.md).

### Webhook + API endpoints (apps/api)

- **Webhooks:** `POST /webhooks/:processor/:connectionId` (per-merchant) and
  `POST /webhooks/:processor` (single-tenant). The router resolves the merchant + credentials, builds
  that merchant's adapter, verifies the signature, and feeds holdout assignment + measurement.
- **Onboarding:** `POST /onboarding/connect`, `GET /onboarding/:merchantId/status`,
  `POST /onboarding/:merchantId/activate`.
- **Analytics:** `GET /analytics/pnl`, `POST /analytics/seed-demo` (flag-gated),
  `GET /analytics/billing/preview`.
- **Billing:** `GET /billing/terms`, `POST /billing/setup-intent`, `POST /billing/opt-in`,
  `GET /billing/account/:merchantId`, `GET /billing/invoices/:merchantId`,
  `GET /billing/invoice/:n`, `POST /billing/invoice/:n/send`, `POST /billing/invoice/:n/forward-ap`,
  `POST /billing/dunning/run`, `GET /billing/icp-quote`.

## Environment

Copy `.env.example` → `.env` and fill in real values **locally only** — it contains placeholders
exclusively; **never commit real secrets**. Processor keys must be **restricted, least-privilege**
keys (ARCHITECTURE.md §7). Key safety gates (all default-OFF): `AX10M_LIVE_CHARGING`,
`AX10M_LIVE_COMMS`, `AX10M_LIVE_BILLING`; optional `AX10M_BANDIT_POLICY`,
`AX10M_BILLING_STRIPE_SECRET_KEY`, `AX10M_BILLING_SIGNING_KEY`.

## What's implemented vs. stubbed

**Implemented (real logic + tests):** canonical schema + decline taxonomy · clustered/stratified
holdout · CUPED + cluster-robust + mSPRT lower-bound estimator with SRM gating · hash-chained ledger
+ `verifyChain` · signed Uplift Statement + CFO reconciliation · guardrail `evaluate` · ~17 processor
adapters (charges, signed webhooks, decline mapping, net-recovery reversals + won-dispute re-credit) ·
per-merchant webhook routing · the recovery brain (trained model + decline-intel + ARSE +
cost/compliance objective + LinUCB bandit + persisted cross-merchant flywheel + retrain job) · durable
scheduler + runnable worker (proven vs a real Temporal server) · **the full billing loop** (opt-in
portal + signed terms acceptance + SetupIntent + monthly signed statements + holdout-credited net
billing + Stripe off-session charger + invoice delivery/dunning + ICP quote) · shadow-first onboarding
· persistence (restart-safe ledger, encrypted creds, billing + flywheel state) · dashboard (shadow
projection, live P&L, opt-in portal).

**Stubbed / gated / not yet real:**
- **No real money moves from this repo.** Live charging + billing collection are flag-gated
  (`AX10M_LIVE_CHARGING` / `AX10M_LIVE_BILLING`, both off) and need operator credentials + a cluster.
  **Default is shadow mode — measures, never moves money.**
- **The engine is trained/measured on synthetic data, not proven vs the incumbent** — see honest
  status; a **live design-partner holdout is the one remaining gate** (the GTM/procurement docs above
  are the handoff to land it).
- 13 enterprise billing-platform adapters are capability-accurate skeletons.
- Both legal drafts (`TERMS.md`, `docs/DPA-TEMPLATE.md`) need counsel review before real use.
- Follow-ups: production KMS signing key; bandit-flush row-lock under true concurrency; comms-arm
  reward attribution; reconciler scheduling.

## Design invariants (do not break)

- **Never store or transmit a PAN.** Tokenization / mandates only (SAQ-A posture).
- **Exactly-once charging.** Every charge carries a deterministic idempotency key; the reconciler is
  the truth source.
- **Guardrail before execution.** The policy proposes; the guardrail disposes.
- **Bill the lower bound.** We deliberately under-claim; an unproven month bills $0.
- **The onboarding number is a projection, not the bill.** Only the live holdout produces a billable
  figure (`holdoutVerified: false` until active).
- **LLMs in comms + analytics only — never the charge-decision path.**
- **No real secrets in the repo, ever.**

## License

Proprietary — all rights reserved (pre-release).
