# Lift — AI-Native Failed-Payment Recovery

> Working codename: **Lift** (recovers involuntary churn, bills only on verified *uplift*).
> Alt names to consider: Reclaim, Recoup, Cadence, Salvage, Grace, Reflow.
> Document owner: founding eng. Status: architecture v0.1. Date: 2026-08-14.

---

## 0. One-line thesis

> **The only failed-payment recovery engine that proves its lift with a live randomized holdout and bills 12% of the statistically-verified lower bound — so the number on your invoice is one your auditor can reconcile.**

Everyone in this category ("pay on uplift") measures recovery against a *baseline they compute for you*. Redux, Butter, Gravy, Churnkey — all of them. None run a live, randomized control group, so "baseline" is a trust-me number. Gravy already has public attribution-dispute complaints. **Auditable attribution is the wedge; the AI is the engine; plug-and-play is the distribution.**

---

## 1. Competitive landscape (why we win)

| Player | Pricing | Attribution rigor | Multi-processor | Card Updater / network tokens | Omni-channel dunning | Retry AI | Setup |
|---|---|---|---|---|---|---|---|
| **Stripe Smart Retries** (native) | Free (part of Billing) | None (it *is* the baseline) | Stripe only | Yes (native) | Basic email | ML retry timing | On by default |
| **Redux** | % of recovery above baseline | Cohort baseline, **no live holdout** | Stripe only | Yes | Email + card-update link | "AI recovery agent" | 2-click Stripe |
| **Butter** | Revenue share | ML baseline, no public holdout | Multi (enterprise) | Yes | Pre-emptive, less comms | Strong ML timing | Sales-led |
| **Gravy** | Custom flat fee | **Attribution disputes reported** | Multi | Partial | Heavy human + comms | Some | Sales-led |
| **Churnkey** | Tiered SaaS + % | Self-reported +4–12% | Multi | Via processor | Email/SMS/in-app + paywall | ML "precision retries" | Medium |
| **Paddle/ProfitWell Retain** | % of recovered | Baseline, no holdout | Paddle-centric | Yes | Email | Some | Medium |
| **Lift (us)** | **12% of holdout-verified lower-bound uplift** | **Live randomized holdout + signed ledger** | **Adapter SDK, processor-agnostic** | **Yes + cross-merchant BIN intel** | **Email/SMS/WhatsApp/push/in-app, generative** | **Contextual-bandit / offline-RL + compliance guardrail** | **OAuth, 5-min, shadow-first** |

**Three ways we blow the field away:**
1. **Honest, auditable billing.** We bill the *lower confidence bound* of a live-holdout-measured uplift. We deliberately under-claim. A skeptical CFO becomes our best salesperson.
2. **We coexist with Stripe Smart Retries instead of asking you to turn it off.** Smart Retries stays on and becomes part of the measured baseline. We only bill the *incremental* lift on top of it. This is also what keeps Stripe a partner, not an adversary.
3. **Network-compliance as a first-class feature.** Naive retry tools get merchants fined by Visa/MC for over-retrying dead cards. Our guardrail engine makes that structurally impossible — a real enterprise-grade differentiator.

---

## 2. Domain reality — where recovery *actually* comes from

Retry timing is the smallest lever, yet it's what everyone markets. The real recovery stack, in rough order of $ impact:

1. **Card Account Updater + network tokenization** — a large share of failures are expired/reissued cards. Getting the *new* card number (Visa VAU, Mastercard ABU, Amex, or network tokens that auto-update) recovers more than any retry-timing cleverness. This must be table stakes.
2. **Customer self-update via frictionless comms** — one-click, no-login hosted card-update page delivered on the right channel at the right time.
3. **Retry timing & method optimization** — *when* to retry, and *which* payment method/rail to use, conditioned on decline code + issuer behavior + customer context.
4. **Processor / network routing** — for multi-rail merchants, retry down the path most likely to approve.
5. **Partial / negotiated capture** — recover something rather than nothing.

### Decline taxonomy (the core control signal)
- **Soft declines** (retriable): insufficient funds, issuer temporarily unavailable, velocity/limit, do-not-honor-with-retry. → schedule intelligent retry.
- **Hard declines** (NOT retriable): lost/stolen, closed account, invalid card, pickup card. → **suppress retries**, go straight to card-update comms. Retrying these wastes attempts and **triggers card-network penalties**.
- **Gray zone**: "do not honor" (05) — issuer-and-context dependent; the recoverability model earns its keep here.

### Card-network retry rules (hard constraints, not suggestions)
Visa, Mastercard, and Amex cap authorization retries and forbid retrying certain reason codes. Exceeding caps → fines and merchant-level penalties. **These are encoded as an inviolable constraint layer that overrides any learned policy.** This is where most competitors quietly expose merchants to risk.

---

## 3. The Uplift Attribution Engine (the crown jewel)

If we get one thing world-class, it's this. It's the reason we can charge honestly and win trust.

### 3.1 Randomized holdout
- At the unit of a **failed invoice** (assignment keyed on a stable hash of customer+invoice so re-processing is deterministic), route a configurable **control fraction** (default 5–10%) to **baseline-only** recovery (the merchant's existing Stripe Smart Retries / native dunning). The rest — **treatment** — gets Lift's engine.
- Assignment is **stratified** by MRR tier, decline code family, and issuer region so control and treatment are comparable.
- **Incremental uplift = (treatment recovery rate − control recovery rate) × treated failed volume**, in recovered $ and in retained-subscription $.

### 3.2 Statistical rigor
- **Sequential testing** (always-valid p-values / mSPRT) so we can read results continuously without p-hacking.
- **CUPED / regression adjustment** using pre-failure covariates to cut variance → tighter bounds, faster time-to-significance.
- We bill on the **lower bound of the confidence interval**, not the point estimate. Structural under-claiming.
- **Guardrails**: minimum sample sizes before billing; automatic pause + alert on assignment imbalance (SRM check) or metric anomalies.

### 3.3 Auditability — the "Uplift Statement"
- Every recovery decision, its counterfactual bucket, every attempt, decline code, and outcome is written to an **append-only, hash-chained ledger** (tamper-evident).
- Monthly **Uplift Statement**: a CFO/auditor can reconcile it line-by-line against the processor's own payout/transaction reports. Cryptographically signed, exportable (CSV/PDF/API).
- This artifact *is* the product's trust moat. No competitor offers a reconcilable, signed lift statement.

### 3.4 Why this beats "baseline"
Redux's own case study ("45% baseline → 50%, bill the difference") relies on *their* estimate of your counterfactual. Ours is measured by a live control group running *simultaneously* under *identical* conditions. When a customer asks "how do I know this lift is real?", we hand them a randomized experiment, not a spreadsheet.

---

## 4. System architecture

```
                         ┌──────────────────────────────────────────────┐
   Processors            │                 LIFT PLATFORM                 │
 ┌───────────┐  webhooks │  ┌────────────┐   ┌────────────────────────┐  │
 │ Stripe    ├──────────►│  │  Ingress / │   │  Decision Core         │  │
 │ Adyen     │  + poll   │  │  Adapters  ├──►│  1 Recoverability model│  │
 │ Braintree ├──────────►│  │  (POAL)    │   │  2 Retry-timing policy │  │
 │ Chargebee │           │  │ normalize  │   │  3 Comms policy        │  │
 │ Recurly   │           │  │ →canonical │   │  4 Compliance guardrail│  │
 │ Zuora ... │           │  └─────┬──────┘   └───────────┬────────────┘  │
 └─────▲─────┘           │        │                      │               │
       │ attempt_charge  │        ▼                      ▼               │
       │ update_pm       │   ┌──────────┐        ┌───────────────┐       │
       └─────────────────┼───┤ Recovery │◄───────┤ Temporal saga │       │
                         │   │ Executor │        │ (durable, idem)│      │
                         │   └────┬─────┘        └───────────────┘       │
                         │        │                                      │
   Customers             │   ┌────▼─────┐  ┌──────────────┐ ┌─────────┐  │
 ┌───────────┐  omni-ch. │   │ Comms    │  │ Attribution/ │ │ Feature │  │
 │ email/SMS ◄┼──────────┤   │ + hosted │  │ Holdout +    │ │ store   │  │
 │ WhatsApp  │           │   │ card page│  │ signed ledger│ │(on/off) │  │
 │ push/app  │           │   └──────────┘  └──────┬───────┘ └─────────┘  │
 └───────────┘           │                        ▼                      │
                         │   Event bus (Kafka) → warehouse/ClickHouse    │
                         │   Control plane: Next.js dashboard, billing   │
                         └──────────────────────────────────────────────┘
```

### 4.1 Ingress & the Payment Orchestration Abstraction Layer (POAL)
The single most important architectural decision for "works with any billing system."
- **Adapter per processor** implementing a narrow interface. Everything upstream speaks a **canonical schema**, so the decision core never knows which processor it's driving.
- **Canonical entities**: `Merchant`, `Customer`, `PaymentMethod`, `Subscription`, `Invoice`, `ChargeAttempt`, `DeclineEvent`, `RecoveryCase`.
- **Adapter interface** (capability-gated):
  ```
  interface ProcessorAdapter {
    ingestWebhook(raw): CanonicalEvent[]        // normalize
    listOpenFailures(cursor): Invoice[]         // reconciliation poll
    attemptCharge(invoice, method, idemKey): ChargeResult
    fetchUpdatedCard(method): PaymentMethod | null   // Account Updater / network token
    listPaymentMethods(customer): PaymentMethod[]
    pauseNativeDunning(subscription): void      // take control
    capabilities(): CapabilityMatrix            // what this processor supports
  }
  ```
- **Capability matrix + graceful degradation**: not every processor supports external retry control, Account Updater, or partial capture. Adapters advertise capabilities; the core degrades to "advisory mode" (recommend, merchant/processor executes) when it can't drive directly.
- **Dual ingestion**: webhooks (real-time) **and** a polling reconciler (truth source). Webhooks lie/drop; reconciliation guarantees we never miss or double-count a failure.

### 4.2 Decision Core (four cooperating components)
1. **Recoverability model** — gradient-boosted / neural classifier. Features: decline code, issuer BIN behavior (cross-merchant, aggregated), amount, currency, MRR tier, customer tenure, prior-recovery history, time features, payday proximity, retry attempt #, method age. Output: P(recover | action) and expected value.
2. **Retry-timing / method policy** — **contextual bandit (Thompson sampling)** online, bootstrapped from **offline RL** on historical logs. Action space: *when* (next window) × *which method* × *which rail*. Reward: recovered value − attempt cost − **fine risk** − **downstream churn/annoyance cost** (retention-aware — over-dunning a good customer has a real cost).
3. **Comms policy** — separate bandit over *channel × template × timing*. Feeds the generative dunning system.
4. **Compliance guardrail engine** — a **hard-constraint layer** applied *after* the policy proposes an action. Encodes network attempt caps, hard-decline suppression, quiet hours, consent/opt-out, per-issuer velocity. **Constraints always override the learned policy.** Every suppression is logged with a reason.

### 4.3 Execution — durable recovery saga
- Each `RecoveryCase` is a **Temporal workflow**: timers for scheduled retries, activities for charge attempts and comms, automatic retries on infra failure, and — critically — **idempotency + exactly-once charge semantics**. We must *never* double-charge. Every `attemptCharge` carries a deterministic idempotency key; a reconciliation pass catches any ambiguity.
- Circuit breakers per processor; backpressure; dead-letter queues; poison-message isolation.

### 4.4 Comms & hosted card-update
- Omni-channel: email, SMS, WhatsApp, push, in-app.
- **Frictionless hosted card-update page**: no login, one-click, PCI-minimal (tokenization via the processor's elements/SDK — **we never touch the PAN**).
- **Generative personalization** (LLM): localized, brand-voiced dunning copy, tone-matched to the customer segment. Guardrails: LLM writes *copy*, never touches the *charge decision*.

### 4.5 Data platform
- **Event bus**: Kafka/Redpanda. **OLAP**: ClickHouse. **Ledger/OLTP**: Postgres (append-only, hash-chained). **Online features**: Redis. **Feature store**: Feast (online+offline parity). **Warehouse**: for analytics + model training.
- Strict **tenant isolation** and per-merchant encryption keys.

---

## 5. AI/ML deep dive

### 5.1 The data flywheel (the durable moat)
More merchants → more decline/recovery outcomes across **shared issuers and BINs** → better *cross-merchant issuer-behavior priors* (privacy-safe, aggregated, no PII leakage between tenants) → better cold-start and better timing for *everyone*, especially small merchants who could never learn this alone. This is a genuine network effect the incumbents' single-tenant framing can't match. Consider a **federated / differentially-private** issuer model so we can share intelligence without sharing data.

### 5.2 Cold start
Bootstrap new merchants with heuristics + industry/issuer priors; the bandit explores *safely* within compliance constraints. Shadow mode (below) means we're learning before we're ever billing.

### 5.3 Offline policy evaluation before rollout
Never ship a policy blind. Use **inverse-propensity / doubly-robust** offline evaluation on logged data, then **shadow mode** (decisions computed, not executed), then **canary**, then full. Drift detection on decline distributions and issuer behavior.

### 5.4 Explainability
SHAP per decision; every recovery action carries a human-readable rationale ("retried Tue 02:00 local: issuer approval odds peak post-midnight for insufficient-funds on this BIN; within network caps") surfaced in the dashboard and the audit ledger.

### 5.5 Where LLMs belong (and don't)
- **Yes**: generative dunning copy, localization, natural-language analytics ("why did November recovery dip?"), an ops copilot, summarizing uplift statements. Use Claude (latest Opus/Sonnet) for these.
- **No**: the charge/retry *decision path*. That stays deterministic, audited, and reproducible. LLM non-determinism has no place where money moves.

---

## 6. Plug-and-play onboarding (the distribution moat)

**Design principle: prove value before the customer pays or risks anything.**

- **Path A — zero-code (target: 5 minutes).** Stripe OAuth (Connect) → we auto-register webhooks, read subscription/dunning config, and enter **shadow mode**: for 14 days we *measure the merchant's true baseline* and compute **projected uplift** without touching a single charge. Then one toggle flips to active. Restricted-key, least-privilege scopes only.
- **Path B — SDK (1 line).** Lightweight SDKs (Node/Python/Ruby/Go/PHP) + REST for homegrown billing. `lift.track(failedInvoice)` and we do the rest.
- **Path C — billing platforms.** Native integrations/apps for Chargebee, Recurly, Zuora, Braintree, Adyen, Paddle.

**The killer move: shadow-first.** The dashboard shows *projected monthly uplift and what our fee would have been* before activation. The merchant activates having already seen the money. No competitor leads with "here's the proof, then decide."

---

## 7. Stripe certified-partner path

- **Build a Stripe App** (Stripe Apps SDK + UI extensions) listed on the **Stripe App Marketplace**; auth via **Stripe Connect OAuth** with **restricted API keys** and least-privilege scopes.
- **Coexist with Smart Retries** — this matters for partnership. We *enhance* Stripe's native recovery and bill only incremental lift; we don't ask merchants to rip out Stripe Billing. Stripe favors apps that deepen platform usage, not ones that route around it.
- **Certification requirements to design for from day one**:
  - **PCI-DSS scope minimization** — tokenization only, **never store or transmit PAN** (target SAQ-A posture). Card updates go through Stripe Elements / network tokens.
  - **Security review** for marketplace listing; **SOC 2 Type II** and ideally **ISO 27001**.
  - Data-handling, branding, support-SLA, and uptime requirements per Stripe's app-review guidelines.
  - Least-privilege OAuth scopes; clear data-deletion and residency handling (GDPR/CCPA).
- **Partner tiers / co-sell**: get listed → verified → pursue co-sell. A clean, coexisting, security-reviewed app is the fast path.

---

## 8. Multi-processor / billing-agnostic strategy

- The **POAL + canonical schema** (§4.1) is what makes us processor-agnostic. Ship Stripe first, then Adyen/Braintree/Chargebee/Recurly/Zuora as adapters.
- **Advisory mode** for processors that own their own dunning and won't cede retry control: we compute the optimal action and expose it via API/webhook for the processor or merchant to execute — still measurable, still billable on lift.
- Publish the **Adapter SDK spec** so partners/merchants can add processors themselves.

---

## 9. Security, compliance, reliability (financial-grade)

- **PCI scope minimization**: no PAN storage, tokenization only, KMS/HSM-backed keys, field-level encryption, per-tenant key isolation.
- **Exactly-once charging**: deterministic idempotency keys, reconciliation reconciler as source of truth, no double-charge under any partition/retry scenario. This is the correctness bar that makes or breaks a payments company.
- **Reliability**: multi-region, durable Temporal workflows, DLQs, circuit breakers per processor, chaos testing on the recovery saga.
- **Compliance**: SOC 2 Type II, ISO 27001, GDPR/CCPA, consent/opt-out enforcement in the guardrail layer, immutable audit log.

---

## 10. Recommended tech stack

- **Core services**: TypeScript (NestJS) for API/adapters; **Go** for the high-throughput ingester/executor if needed. **Python** for ML.
- **Workflows**: **Temporal**. **Bus**: Kafka/Redpanda. **OLTP/ledger**: Postgres. **OLAP**: ClickHouse. **Cache/online features**: Redis. **Feature store**: Feast.
- **ML**: PyTorch + XGBoost for models; **River / Vowpal Wabbit** for online bandits; MLflow for tracking; offline OPE tooling.
- **LLM**: Claude (comms + analytics + ops copilot only).
- **Frontend**: Next.js dashboard + hosted card-update page.
- **Infra**: Kubernetes, Terraform, multi-region, per-tenant isolation.
- **Repo**: monorepo (Turborepo/Nx) — `adapters/`, `core/`, `attribution/`, `comms/`, `dashboard/`, `sdk/`, `infra/`.

---

## 11. Pricing & business model

- **12% of holdout-verified, lower-bound incremental uplift.** Recovered $ *and* retained-subscription value both count toward lift, but only the part the control group proves is incremental.
- Contrast we lead the sales conversation with: competitors charge 20–30% of *gross* recovery — which silently includes the money Stripe Smart Retries would have recovered for free. Our effective take on truly-incremental dollars is both **honest and lower**. We win on trust and on math.
- Optional enterprise tier: platform fee + reduced % for very high volume; SLА and dedicated model.

---

## 12. Phased roadmap

**Phase 0 — "Proof engine" (weeks 1–6).** *This alone is sellable.*
- Stripe adapter (webhook + reconciler), canonical schema, POAL skeleton.
- Randomized-holdout attribution engine + hash-chained ledger + Uplift Statement.
- Shadow mode: measure baseline, show *projected* uplift, compute would-be fee.
- Heuristic + basic timing-model retry policy.
- Dashboard: projected uplift, cohort view, signed billing statement.

**Phase 1 — Take control.**
- Active retries (Temporal saga, exactly-once), omni-channel dunning + hosted card-update page, Card Account Updater / network tokens, compliance guardrail engine.

**Phase 2 — Intelligence.**
- Contextual-bandit / offline-RL policy, cross-merchant issuer intelligence, SHAP explainability, retention-aware reward.

**Phase 3 — Scale & moat.**
- Multi-processor adapters (Adyen/Braintree/Chargebee/Recurly/Zuora), Stripe App Marketplace listing, SOC 2 Type II, enterprise.

---

## 13. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| Attribution disputes | Live randomized holdout + signed, reconcilable ledger; bill the lower bound |
| Double-charge / financial bug | Exactly-once semantics, idempotency keys, reconciliation as source of truth, heavy testing |
| Network fines from over-retry | Compliance guardrail as an inviolable hard-constraint layer |
| Stripe is both dependency and competitor | Coexist + become a certified partner; POAL hedges with multi-processor |
| Cold start on a new merchant | Heuristics + cross-merchant issuer priors + shadow-mode learning before billing |
| Over-dunning churns good customers | Retention-aware reward that prices in annoyance/churn cost |

---

## 14. Open decisions (need founder input)

1. **Name** — Lift, or one of the alternates?
2. **First beachhead** — SaaS subscriptions, or higher-volume consumer subscriptions (streaming/box)? Changes model priors and comms mix.
3. **Build language for core** — all-TypeScript for speed, or Go for the hot path? (Recommend TS-first, extract Go later if throughput demands.)
4. **Holdout default %** — 5% (faster to "no meaningful control cost" story) vs 10% (tighter, faster significance)? Recommend 10% during onboarding, taper to 5% once the model is proven per merchant.
5. **Do we want the pitch/marketing artifact** (investor + Stripe-partner one-pager) generated from this doc?
