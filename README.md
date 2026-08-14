# Lift — AI-Native Failed-Payment Recovery

> Overlays Stripe Smart Retries and bills **12% of live-holdout-verified uplift**.
> The only recovery engine that proves its lift with a live randomized control
> group and a signed, reconcilable ledger. Full design in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

This repository is the **Phase 0 "proof engine"** scaffold (ARCHITECTURE.md §12):
Stripe adapter + canonical schema + POAL skeleton, the randomized-holdout
attribution engine with a hash-chained ledger and Uplift Statement, a compliance
guardrail, and a shadow-mode dashboard that shows *projected* uplift and the
would-be fee **before** a merchant activates.

## Monorepo layout

```
lift/
├─ docs/ARCHITECTURE.md          # source of truth
├─ packages/
│  ├─ canonical/                 # canonical entities + decline taxonomy (isRetriable)
│  ├─ poal/                      # Payment Orchestration Abstraction Layer
│  │  └─ stripe/                 # Stripe adapter skeleton (webhook→canonical, idem keys)
│  ├─ attribution/               # ★ holdout assignment · uplift · hash-chained ledger · statement
│  └─ guardrail/                 # compliance hard-constraint layer (caps, quiet hours, consent)
└─ apps/
   ├─ api/                       # NestJS: webhook ingress · reconciler · recovery-case service
   └─ dashboard/                 # Next.js shadow-mode dashboard (projected uplift + 12% fee)
```

### How the packages relate

```
              @lift/canonical  (shared vocabulary: entities + decline taxonomy)
                 ▲      ▲      ▲
                 │      │      │
      @lift/poal │  @lift/attribution │ @lift/guardrail
                 │      ▲              │
                 └──────┼──────────────┘
                        │
        apps/api  (RecoveryCaseService wires POAL + attribution + guardrail)
        apps/dashboard  (renders the attribution engine's Uplift Statement)
```

- **`@lift/canonical`** — the vocabulary everything speaks. `Merchant`, `Customer`,
  `PaymentMethod`, `Subscription`, `Invoice`, `ChargeAttempt`, `DeclineEvent`,
  `RecoveryCase`, plus the soft/hard/gray decline taxonomy and `isRetriable(code)`.
- **`@lift/poal`** — the `ProcessorAdapter` interface + `CapabilityMatrix` that make
  Lift processor-agnostic, deterministic idempotency keys (exactly-once), and the
  Stripe adapter skeleton.
- **`@lift/attribution`** — the crown jewel. Deterministic stratified holdout
  assignment, lower-bound uplift math + SRM check, an append-only hash-chained
  ledger (tamper-evident), and the monthly Uplift Statement.
- **`@lift/guardrail`** — a hard-constraint layer: `evaluate(action)` → allow /
  suppress + reason. Constraints (network caps, hard-decline suppression, quiet
  hours, consent/opt-out) always override the learned policy.

## Prerequisites

- Node ≥ 20
- pnpm ≥ 9 (`corepack enable` then `corepack prepare pnpm@latest --activate`)

## Commands

```bash
pnpm install                      # install the whole workspace

pnpm build                        # turbo: build every package/app in dep order
pnpm test                         # turbo: run all vitest suites
pnpm typecheck                    # turbo: type-check everything
pnpm dev                          # turbo: run dev servers (api + dashboard)

# Scoped to one package:
pnpm --filter @lift/attribution test        # run just the crown-jewel tests
pnpm --filter @lift/attribution build
pnpm --filter @lift/api dev                 # NestJS on :4000
pnpm --filter @lift/dashboard dev           # Next.js on :3000
```

> Windows note: these are the same under PowerShell. `pnpm` scripts are shell-agnostic.

## Environment

Copy `.env.example` → `.env` and fill in real values **locally only**. The example
contains placeholders exclusively — **never commit real secrets**. Stripe keys must
be **restricted, least-privilege** keys (ARCHITECTURE.md §7).

## What's implemented vs. stubbed (Phase 0)

**Implemented (real logic + unit tests):**
- Canonical schema + decline taxonomy (`isRetriable`, family mapping).
- Deterministic stratified holdout assignment (stable, reproducible).
- Lower-bound uplift computation, fee at 12%, min-sample gating, SRM check.
- Append-only hash-chained ledger + `verifyChain` tamper detection.
- Monthly Uplift Statement builder (per-stratum, summed, ledger-verified).
- Compliance guardrail `evaluate` (caps, hard-decline, quiet hours, consent, opt-out).
- Deterministic idempotency-key generation.
- Dashboard renders the **real** attribution engine over mocked cohort stats.

**Stubbed with `TODO(lift)` markers:**
- Stripe API calls + webhook signature verification + canonical normalization.
- Reconciler scheduling and gap detection.
- Recovery-case persistence (per-merchant ledgers → Postgres), Temporal saga.
- Active charging (Phase 0 runs **shadow mode** — measures, never moves money).
- ML models / bandits (out of scope for Phase 0).

## Design invariants (do not break)

- **Never store or transmit a PAN.** Tokenization only (SAQ-A posture).
- **Exactly-once charging.** Every charge carries a deterministic idempotency key;
  the reconciler is the truth source.
- **Guardrail before execution.** The learned policy proposes; the guardrail
  disposes. Suppressions are logged to the ledger with a reason.
- **Bill the lower bound.** We deliberately under-claim.
- **No real secrets in the repo, ever.**
