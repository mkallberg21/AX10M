# AX10M — Verification Baseline

_Recorded at the start of the phased build plan (Phase 0). This is the authoritative
snapshot of what actually builds, typechecks, and passes today — not what any older
doc claims._

## Environment
- Node v24.15.0 (plan requires ≥ 20 ✅)
- pnpm via `corepack pnpm` (Windows; `corepack enable` can't write shims here)
- Commit at baseline: `3f89871`

## Result: GREEN across the board

| Check | Command | Result |
|---|---|---|
| Install | `corepack pnpm install` | ✅ clean (already up to date) |
| Build (all) | `corepack pnpm -r build` | ✅ 8 packages + 2 apps build (`tsc -b` also typechecks) |
| Typecheck | `corepack pnpm -r run typecheck` | ✅ every package + both apps `tsc --noEmit` clean |
| Tests | per-package (see below) | ✅ **380 passed, 0 failed** |

Nothing was broken at baseline; no fixes were required before proceeding.

### Test counts (per package)

| Package | Test files | Tests |
|---|---|---|
| `@ax10m/attribution` | 5 | 41 |
| `@ax10m/guardrail` | 1 | 13 |
| `@ax10m/onboarding` | 2 | 18 |
| `@ax10m/poal` | 22 | 220 |
| `@ax10m/recovery-engine` | 4 | 40 |
| `@ax10m/scheduler` | 3 | 23 |
| `@ax10m/protocol` | 1 | 4 |
| `@ax10m/api` | 4 | 21 |
| **Total** | **42** | **380** |

### Known caveats
- **`@ax10m/canonical` has no test files.** `corepack pnpm -r test` therefore halts on it
  (vitest exits 1 with "No test files found"). Run tests via the explicit `--filter` list
  above, not `-r test`. (Logged in BACKLOG: either add a trivial canonical test or set
  `passWithNoTests`.)
- `@ax10m/recovery-engine` tests take ~25s (gradient-descent training runs). Everything
  else is sub-6s.
- Line-ending warnings (LF→CRLF) appear on Windows git operations; cosmetic.

## Honest deltas: the repo is AHEAD of what this build plan assumes

The plan was written against an earlier repo state. Recording the differences plainly
(per the plan's "report reality" rule) so no later phase re-does finished work:

- **Stripe adapter is already implemented end-to-end** (client + `Stripe-Signature`
  verification + `/invoices/{id}/pay` token charge + reconciliation poll + 9 tests),
  at parity with Chargebee/Adyen/Braintree/GoCardless. The plan's **Phase 3 premise
  ("Stripe is the only major adapter still a skeleton") is no longer true.** Phase 3's
  remaining value is its *compliance* sub-tasks (COMPLIANCE.md, network-cap
  verification with citations, connected-account ToS) — those are NOT done.
- **Two packages the plan's layout omits now exist:** `@ax10m/scheduler` (durable
  charge scheduler + ARSE sequenced saga + Temporal binding) and `@ax10m/protocol`
  (the AXP message spec).
- **Adapter coverage is far beyond "4 + Stripe skeleton":** ~17 webhook-capable
  adapters implemented (Stripe, Adyen, Braintree, PayPal, Checkout, Worldpay, TSYS,
  Elavon, Chargebee, Recurly, Zuora, Maxio, GoCardless, Shopify, WooCommerce +
  BigCommerce/Kajabi/ThriveCart/SamCart advisory) plus 13 enterprise skeletons.
- **Per-merchant webhook routing exists** (`buildAdapter` factory + connection store +
  `WebhookRouterService` + `/webhooks/:processor/:connectionId`).
- **The recovery engine is no longer a bare heuristic:** it now has a trained logistic
  recoverability model (fit on a **synthetic** bootstrap corpus), an online bandit, a
  ledger→corpus retraining job with a champion/challenger gate, a customer/issuer
  feature store (the flywheel), a decline-code intelligence classifier, and the ARSE
  retry-sequence planner.

## What is STILL true (the honesty that matters)

- **The engine is NOT proven to beat Stripe Smart Retries.** Its trained weights were
  fit on a *synthetic* data-generating process, not real outcomes. Beating a faithful
  baseline on realistic data is exactly what **Phase 1 (the backtest)** exists to test —
  and it has not been run. The README honest-status block stands.
- **No real money moves.** Phase 0 is shadow mode. The active charge path exists in code
  but is not deployed/run — there is no live Temporal worker and no processor credentials.
- **No live design partner, no real ledger.** Every lift claim remains a hypothesis until
  the backtest and then a real merchant say otherwise.
