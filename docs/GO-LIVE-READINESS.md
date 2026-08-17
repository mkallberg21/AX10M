# AX10M — First-Merchant Go-Live Readiness Checklist

The ordered set of business, legal, and technical gates from **"we have a signed design partner"** to
**"we've collected a verified fee."** It exists so nothing surprises you mid-deal. Many gates are
**non-code** and only you/counsel/Stripe can clear them — they're on the critical path all the same.

> **Golden rule:** *no real money moves until every hard gate in [Phase 0](#phase-0--the-hard-gates-block-everything)
> is green.* The product is safe-by-default (all `AX10M_LIVE_*` flags off); keeping it that way until
> the gates clear is the whole point.

**Owner legend:** 🧑‍💼 you/founder · ⚖️ counsel · 💳 Stripe/processor · 🛠️ eng/ops.

---

## Phase 0 — The hard gates (block everything)

These must be **green before any live charging or billing.** Most are non-code.

| # | Gate | Owner | Why it blocks |
|---|---|---|---|
| 0.1 | **Charge authority confirmed** — Stripe (and/or the merchant's processor) permits AX10M to *drive* charges on the merchant's account under the merchant's authorization | ⚖️💳 | If not, drive mode → advisory and the value prop collapses. See [COMPLIANCE.md §2](COMPLIANCE.md). **The #1 gate.** |
| 0.2 | **AX10M platform Stripe account** live (AX10M's *own* account, distinct from merchant accounts) | 🧑‍💼💳 | The billing charger + SetupIntent (`AX10M_BILLING_STRIPE_SECRET_KEY`) can't collect the fee without it |
| 0.3 | **Legal entity + business banking** | 🧑‍💼 | Required to hold the Stripe account, sign contracts, and receive fees |
| 0.4 | **`TERMS.md` + `DPA-TEMPLATE.md` counsel-reviewed and finalized** | ⚖️ | Both are marked DRAFT; a real merchant can't sign a draft |
| 0.5 | **Money-transmission / licensing posture confirmed** (likely not a transmitter since you charge on the merchant's processor under their authority — but confirm) | ⚖️ | Regulatory risk if wrong |
| 0.6 | **Production signing key** (`AX10M_BILLING_SIGNING_KEY`, KMS/HSM-managed) | 🛠️ | Statements must be verifiable across runs, not signed with an ephemeral dev key |
| 0.7 | **Encryption key management** (KMS-wrapped `AX10M_ENCRYPTION_KEY`) + a real `DATABASE_URL` (shared Postgres) | 🛠️ | Credentials-at-rest + the shared ledger/flywheel need production key mgmt + a real DB (pglite is single-process) |

## Phase 1 — Partner scoping & agreement

| # | Step | Owner | Reference |
|---|---|---|---|
| 1.1 | Run the **ICP / time-to-proven-lift quote** on the partner's volume | 🧑‍💼 | `GET /billing/icp-quote` · [Runbook §1](CERTIFICATION-RUNBOOK.md) |
| 1.2 | Security review (they'll ask): send the questionnaire + DPA + a **sample signed statement** | 🧑‍💼⚖️ | [SIG/CAIQ](SIG-CAIQ-PREFILL.md) · [Security one-pager](SECURITY-PROCUREMENT.md) |
| 1.3 | Sign the certification agreement; merchant **opts in** (signed clickwrap acceptance recorded) | ⚖️🧑‍💼 | `POST /billing/opt-in` · [TERMS](../packages/billing/TERMS.md) |
| 1.4 | Set payer track: **auto-pay** (SetupIntent) or **invoice/net-14** | 🧑‍💼 | `POST /billing/setup-intent` |

## Phase 2 — Connect & shadow (no money moves)

| # | Step | Owner | Reference |
|---|---|---|---|
| 2.1 | Merchant connects with a **least-privilege restricted key** (read-only for shadow) | 🛠️🧑‍💼 | ARCHITECTURE.md §7 |
| 2.2 | Verify ingestion: webhooks normalize; `verifyChain` passes on the ledger | 🛠️ | [Runbook §4](CERTIFICATION-RUNBOOK.md) |
| 2.3 | Confirm all `AX10M_LIVE_*` flags are **OFF**; guardrail enforcing (caps/quiet-hours/consent) | 🛠️ | |
| 2.4 | Watch the **shadow projection** (labeled not-holdout-verified); calibrate expectations | 🧑‍💼 | dashboard `/pnl` |

## Phase 3 — Technical go-live enablement (before flipping live)

| # | Step | Owner |
|---|---|---|
| 3.1 | **Observability + alerting** wired: an **SRM-breach auto-pause/alert**, charge-error alerting, ledger-integrity check on load | 🛠️ |
| 3.2 | **Backups + a tested restore** on the production DB; RTO/RPO agreed | 🛠️ |
| 3.3 | **Exactly-once verified in the prod topology** (API + worker sharing one ledger; idempotency keys stable) | 🛠️ |
| 3.4 | Durable worker on a **real Temporal cluster** (if using `AX10M_DURABLE_RECOVERY`) | 🛠️ |
| 3.5 | Decide the **flip plan**: who enables `AX10M_LIVE_CHARGING`, on which host, at which moment, with rollback | 🧑‍💼🛠️ |
| 3.6 | *(Optional)* enable `AX10M_BANDIT_POLICY` once there's enough live volume to feed it; note the flush row-lock follow-up | 🛠️ |

## Phase 4 — Activate the certification holdout (live charging on)

| # | Step | Owner | Reference |
|---|---|---|---|
| 4.1 | Set holdout: `AX10M_HOLDOUT_CONTROL_FRACTION=0.10`, stable `AX10M_HOLDOUT_SALT` | 🛠️ | [Runbook §5](CERTIFICATION-RUNBOOK.md) |
| 4.2 | Enable **`AX10M_LIVE_CHARGING=true`** on a credentialed host — treatment arm now charges live | 🛠️ | |
| 4.3 | *(Optional)* enable `AX10M_LIVE_COMMS=true` once dunning copy + consent are signed off | 🧑‍💼🛠️ | |
| 4.4 | Monitor the **SRM check** daily; if breached, pause and investigate before trusting any statement | 🛠️ | |
| 4.5 | Do **not** change holdout fraction/salt/engine mid-window without recording it | 🛠️ | |

## Phase 5 — First billing cycle (collect a verified fee)

| # | Step | Owner | Reference |
|---|---|---|---|
| 5.1 | Run **`run bill`** — signed Uplift Statement per merchant, holdout credit applied | 🛠️ | |
| 5.2 | Deliver the statement bundle; the merchant's finance team **verifies + reconciles to their Stripe payout** | 🧑‍💼 | `scripts/verify-statement.mjs` · [Runbook §8](CERTIFICATION-RUNBOOK.md) |
| 5.3 | If proven ($ lower bound > 0, SRM ok, reconciles): enable **`AX10M_LIVE_BILLING=true`** and collect (off-session on auto-pay, or invoice net-14 + `run dun`) | 🧑‍💼🛠️ | |
| 5.4 | If **not** proven: merchant owes **$0** — state it plainly; decide extend/investigate/part ways | 🧑‍💼 | [Runbook §10](CERTIFICATION-RUNBOOK.md) |

## Phase 6 — Steady state

| # | Step | Owner |
|---|---|---|
| 6.1 | **Taper** the holdout 10% → ≤2% audit; steady-state monthly `bill` + `dun` | 🛠️ |
| 6.2 | Each period: signed statement → merchant can always re-verify (never an unverifiable number) | 🛠️ |
| 6.3 | **Case study** with the real, verified numbers — **written permission** first | 🧑‍💼 | [Case-study template](CASE-STUDY-TEMPLATE.md) |
| 6.4 | Feed the win into the roadmap and the [marketplace milestone](MARKETPLACE-PRIORITIZATION.md) (M1 → build the Stripe App) | 🧑‍💼 |

---

## "Do NOT enable live money until…" (the non-negotiables)

- [ ] Charge authority confirmed with Stripe/counsel (0.1)
- [ ] AX10M platform Stripe account + entity + banking live (0.2–0.3)
- [ ] TERMS + DPA counsel-finalized and signed by the merchant (0.4, 1.3)
- [ ] Production KMS-managed signing + encryption keys; real shared DB (0.6–0.7)
- [ ] SRM auto-pause/alerting + backups/restore verified (3.1–3.2)
- [ ] The flip plan (who/where/when/rollback) agreed (3.5)

If any box is unchecked, stay in shadow. The product defaults there for exactly this reason.

*See also: [Certification-Window Runbook](CERTIFICATION-RUNBOOK.md) (the in-window ops) ·
[Marketplace Prioritization](MARKETPLACE-PRIORITIZATION.md) · [Security & Procurement](SECURITY-PROCUREMENT.md)
· [Compliance](COMPLIANCE.md) · [Pricing](PRICING-SUMMARY.md).*
