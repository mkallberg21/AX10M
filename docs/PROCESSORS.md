# Lift — Universal Processor Compatibility

> How Lift works as a plug-and-play recovery overlay on **any** payment processor
> or subscription-billing platform, not just Stripe. Companion to `ARCHITECTURE.md`
> §4.1 (the Payment Orchestration Abstraction Layer) and §8 (multi-processor).
> Status: v0.1. Date: 2026-08-14. Claims are sourced; anything not publicly
> documented is marked **verify-in-integration** rather than assumed.

---

## 1. The principle: one canonical core, an adapter per processor

Lift never speaks a processor's dialect in its decision core. Every processor is
wrapped by an **adapter** that normalizes into the canonical schema (`@lift/canonical`)
and advertises a **capability matrix**. The core drives recovery through the POAL
interface; the adapter translates. New processors are added by writing an adapter,
not by touching the engine.

Because processors differ in how much retry control they cede, every adapter
declares one of three **integration modes**:

- **Drive** — Lift programmatically re-attempts the charge against a stored
  token/mandate on its own optimized schedule. Full control.
- **Co-drive** — Lift drives some recovery but coordinates with the processor's
  own retry/dunning engine (which must be disabled, paused, or deconflicted to
  avoid double-charging).
- **Advisory** — Lift cannot trigger the charge (the platform owns the token and
  the retry loop). Lift **measures** failure/recovery via the platform's
  notifications and **recommends/prompts** out-of-band actions. Still holdout-
  measurable; the "action" is a comm, not a charge.

**Advisory mode is the guarantee that we are never *blocked* from measuring and
billing lift** — even where we can't drive the charge, we can run the experiment
on the comms we do control and prove incremental recovery.

> Universal reach, honestly stated: on card and bank-debit rails we **drive** or
> **co-drive**; on Merchant-of-Record and app-store rails (Paddle, Apple, Google)
> we are **advisory** because those platforms own the payment instrument by design.
> No competitor can drive those either — the difference is we say so up front and
> still measure them.

---

## 2. Master capability matrix

Legend: ✅ yes · ⚠️ partial / gated / verify · ❌ no / N/A. "Own dunning" = does the
platform run a retry/dunning engine Lift must disable or coexist with.

| Processor / platform | Ext. retry API | Failure webhooks | Account Updater | Network tokens | Tokenized re-charge (SAQ-A) | Partial capture | Multi-cur FX report | Own dunning | **Mode** |
|---|---|---|---|---|---|---|---|---|---|
| **Stripe** | ✅ PaymentIntent confirm | ✅ `invoice.payment_failed`, `charge.failed` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Smart Retries | **Drive** (co-drive on Billing) |
| **Adyen** | ✅ `/payments` + token | ✅ `AUTHORISATION success=false` | ✅ | ✅ | ✅ | ✅ | ✅ strong | ⚠️ network-retry only | **Drive** |
| **Braintree (PayPal)** | ✅ Vault sale | ✅ declined statuses, `ACCOUNT_UPDATER_DAILY_REPORT` | ✅ | ✅ auto | ✅ | ✅ multi | ✅ | ✅ Subscriptions | **Drive** / co-drive on Subs |
| **Checkout.com** | ✅ Request-a-Payment + token | ✅ `payment_declined` | ✅ RTAU | ✅ | ✅ | ✅ | ✅ | ❌ | **Drive** |
| **Cybersource (Visa)** | ✅ Payments API | ⚠️ sync-response; thin webhook catalog | ✅ V/MC/Amex | ✅ TMS | ✅ TMS | ✅ | ⚠️ verify | ❌ | **Drive** |
| **Authorize.Net** | ✅ `createTransactionRequest` | ✅ Webhooks | ⚠️ V/MC, US-only | ⚠️ unknown | ✅ CIM | ✅ | ⚠️ weak | ❌ | **Drive** |
| **Worldpay / FIS** | ✅ Access Payments | ✅ `refusedPayment` | ✅ | ✅ V/MC | ✅ Tokens API | ✅ multi | ✅ | ❌ | **Drive** |
| **Fiserv (Commerce Hub/CardPointe)** | ✅ Charges API | ⚠️ fragmented/weak | ✅ CardPointe | ✅ Commerce Hub | ✅ Profiles/tokens | ✅ delayed | ⚠️ verify | ❌ | **Co-drive** |
| **Global Payments** | ✅ GP API | ✅ webhooks | ✅ VAU/ABU | ✅ | ✅ | ✅ partial auth | ✅ | ❌ | **Drive** |
| **Square** | ✅ CreatePayment (idempotent) | ✅ `payment.updated` | ✅ auto | ✅ auto | ✅ `card_id` | ⚠️ delayed only | ⚠️ single-cur/acct | ✅ Invoices/Subs | **Drive** (raw) |
| **Mollie** | ✅ mandate + recurring | ✅ payment `failed`/`expired` | ⚠️ verify | ⚠️ verify | ✅ mandateId | ✅ holds | ✅ | ✅ Subscriptions (5×) | **Co-drive** |
| **Nuvei** | ✅ Rebilling + MIT | ✅ Payment DMNs | ✅ VAU+ABU | ✅ | ✅ buyerToken | ✅ | ✅ global | ⚠️ flexible | **Drive** |
| **Razorpay (India)** | ⚠️ mandate-bounded | ✅ `payment.failed`, `subscription.halted` | ⚠️ token framework | ✅ TokenHQ | ✅ RBI-mandated | ⚠️ verify | ⚠️ INR core | ✅ Subscriptions | **Co-drive** (RBI-constrained) |
| **PayU (India)** | ⚠️ SI, pre-debit-gated | ✅ webhooks + verify_payment | ⚠️ verify | ✅ RBI | ✅ RBI | ⚠️ verify | ⚠️ INR | ✅ SI + bank | **Advisory → co-drive** |
| **Chargebee** | ✅ `collect` (doesn't consume dunning attempts) | ✅ `payment_failed` | ✅ (via gateway) | ✅ | ✅ `payment_source_id` | ✅ | ✅ | ⚠️ disableable | **Drive** |
| **Recurly** | ✅ invoice `collect` | ✅ `failed_payment`, `new_dunning_event` | ✅ V/MC/Amex/Disc | ✅ | ✅ | ⚠️ verify | ✅ 140+ | ⚠️ pausable | **Co-drive → drive** |
| **Zuora** | ✅ payment run / execute-invoice-payment | ✅ callouts | ✅ PMU | ✅ native | ✅ | ⚠️ verify | ✅ strong | ✅ CPR (entangled) | **Co-drive** |
| **Maxio (Chargify/SaaSOptics)** | ✅ Retry Subscription | ✅ `payment_failure` | ⚠️ gateway-dep | ⚠️ verify | ✅ | ⚠️ verify | ⚠️ limited | ⚠️ disableable | **Drive / co-drive** |
| **Stripe Billing** | ✅ `invoices/pay` | ✅ `invoice.payment_failed` | ✅ real-time | ✅ | ✅ | ✅ Multicapture | ✅ | ✅ Smart Retries (disableable) | **Co-drive → drive** |
| **Paddle (+ Retain)** | ❌ MoR owns token | ✅ `transaction.payment_failed` | ✅ (Paddle-owned) | ✅ (owned) | ❌ | ❌ | ✅ (owned) | ✅ Retain (competitor) | **Advisory** |
| **Vindicia (Retain)** | ❌ Vindicia drives | ✅ status events | ✅ native | ⚠️ verify | ❌ | ⚠️ verify | ✅ | ✅ *is* the engine | **Advisory / competitor** |
| **GoCardless** (ACH/SEPA/BACS…) | ✅ `POST /payments/:id/actions/retry` | ✅ rich (`failed`, `late_failure_settled`, mandate events) | ❌ N/A (bank debit) | ❌ N/A | ✅ mandateId (no PAN) | ⚠️ new payment | ✅ multi-scheme | ⚠️ Success+ (opt-in, NSF-only) | **Co-drive** |
| **Apple App Store IAP** | ❌ Apple owns retry | ✅ ASSN v2 (`DID_FAIL_TO_RENEW`…) | ❌ | ❌ | ❌ | ❌ | ✅ (reported) | ✅ Apple, fully | **Advisory** |
| **Google Play IAP** | ❌ Google owns retry | ✅ RTDN (`IN_GRACE_PERIOD`…) | ❌ | ❌ | ❌ | ❌ | ✅ (reported) | ✅ Google, fully | **Advisory** |

---

## 3. Per-processor adapter notes

### Full-stack gateways (cleanest **drive** targets)
- **Stripe** — ingress on `invoice.payment_failed`/`charge.failed`/`payment_intent.payment_failed`; retry by confirming a new PaymentIntent against the stored PaymentMethod. Account Updater + network tokens automatic. The one nuance: on Stripe **Billing**, disable Smart Retries (or operate on raw PaymentIntents) so we don't double-retry — the coexistence measurement still counts Smart Retries as part of the baseline.
- **Adyen** — ingress on `AUTHORISATION` webhook with `success:false` (read `reason`); retry via `/payments` with `storedPaymentMethodId` + `shopperReference`. No competing merchant-facing dunning → cleanest drive. Strong settlement-details reporting for reconciliation.
- **Braintree** — retry via `Transaction.sale` on the vault `payment_method_token`; network tokens auto-provisioned; `ACCOUNT_UPDATER_DAILY_REPORT` webhook surfaces refreshed cards. Co-drive when the merchant uses Braintree Subscriptions (its engine triggers Account Updater on the 2nd decline).
- **Checkout.com** — ingress `payment_declined`; retry via Request-a-Payment on the stored source id; RTAU + network tokens. No merchant dunning engine.

### Enterprise acquirers
- **Cybersource, Worldpay/FIS, Global Payments** — all **drive**: Payments API retry + TMS/Tokens network tokenization + Account Updater + tokenized re-charge (SAQ-A). Failure *detection* is the variable: Worldpay has a clean `refusedPayment` event and Global Payments has webhooks, while **Cybersource leans on synchronous decline reason codes** — so the adapter's ingress must support both a webhook path and a poll/sync-response path.
- **Authorize.Net** — **drive** with the best failure-webhook story of this group; but Account Updater is V/MC US-only and network tokenization is undocumented — design around those gaps.
- **Fiserv** — **co-drive**: all mechanical pieces exist (Commerce Hub / CardPointe), but stack fragmentation (Payeezy vs CardPointe vs Commerce Hub) and inconsistent lifecycle webhooks mean per-account verification; drive the retry, co-drive the (largely sync-response) failure detection.

### International / SMB
- **Square** — **drive** on the raw Payments API (`CreatePayment` with `card_id`, idempotent); network tokens + updater are automatic and Square-run. Key off `payment.updated` at the payment level (Invoices don't emit a failure webhook). Single-currency per account.
- **Mollie** — **co-drive** via mandates (`sequenceType: recurring` + `mandateId`); Mollie Subscriptions imposes a fixed 5-retry dunning and exposes no card VAU/ABU. SEPA Direct Debit dominates and fails on a different timeline than cards.
- **Nuvei** — **drive**: Rebilling Service + MIT, VAU/ABU, network tokens, DMN decline webhooks. Strong global multi-currency — a good non-US drive target.
- **Razorpay / PayU (India)** — **co-drive / advisory**, hard-constrained by RBI: mandatory tokenization, Additional Factor of Authentication at mandate creation and for debits > ₹15,000, and a **24-hour pre-debit notification before every recurring debit**. Lift cannot freely re-time card retries here; it operates inside the e-mandate/SI framework and adds most value on comms + non-card rails (UPI Autopay).

### Subscription-billing platforms
- **Chargebee** — **drive**, best-in-class: `collect` API on a stored `payment_source_id`, partial amounts, and manual collects **don't consume native dunning attempts** (clean coexistence). Dunning is disableable.
- **Recurly** — **co-drive → drive**: on-demand `collect`, rich `failed_payment`/`new_dunning_event` webhooks, native Account Updater (V/MC/Amex/Discover), per-invoice "Stop Dunning."
- **Zuora** — **co-drive**: powerful APIs (payment runs, execute-invoice-payment, tokenized methods, gateway reconciliation) but retry is the callout-driven **Configurable Payment Retry** engine with auto-pay-flag side effects to coordinate around. Enterprise integration effort.
- **Maxio** — **drive/co-drive**: explicit **Retry Subscription** + Pause API, `payment_failure` webhook, disableable dunning; network-token/multi-currency are gateway-dependent.
- **Stripe Billing** — **co-drive → drive**: `invoices/pay` on the stored method; friction is behavioral (customers love Smart Retries), not technical.
- **Paddle** and **Vindicia** — **advisory / competitive**. Paddle is Merchant-of-Record (owns token, payment, and Retain dunning — no third-party retry API); Vindicia Retain *is* a recovery engine you submit failures to. We integrate as a measurement/advisory layer and compete on attribution honesty; we don't drive.

### Bank debit & app stores
- **GoCardless** — **co-drive**: retry via `POST /payments/:id/actions/retry` (mandate must be active); rich webhooks including the bank-debit-specific `late_failure_settled` (post-payout clawback) that our attribution/reconciliation must handle. No card constructs — the credential is the **mandate** (favorable, near-zero PCI card scope). **Guardrail:** always honor the `will_attempt_retry` flag on the `failed` webhook so we never double-collect against GoCardless's own Success+ (NSF-only) engine. Distinct value over Success+: recovering non-NSF failures, dead-mandate re-authorization, and out-of-band comms.
- **Apple App Store / Google Play IAP** — **advisory only**. The platform owns the card, retries (Apple Billing Retry up to 60 days; Google grace + account hold), and the dunning UX end to end. Lift's only levers: (1) **measure** via App Store Server Notifications v2 (`DID_FAIL_TO_RENEW`, `GRACE_PERIOD_EXPIRED`, `EXPIRED/BILLING_RETRY`, `DID_RENEW`) and Google RTDN (`SUBSCRIPTION_IN_GRACE_PERIOD`, `ON_HOLD`, `RECOVERED`, `EXPIRED`); (2) **prompt** the user in-app/email to fix their payment method in their own store account (deep-link to `manageSubscriptions`). Position this to customers explicitly — never imply we recharge IAP.

---

## 4. Adapter rollout order

Prioritized by market share × ease × capability completeness:

1. **Stripe** — reference adapter *skeleton* (capability matrix real; API calls TODO). Largest SaaS footprint; drive; the coexistence-with-Smart-Retries story.
2. **Adyen** — ✅ **implemented end-to-end** (Checkout `/payments` idempotent token retries, HMAC-verified notification ingestion, stored-method listing). Clean drive, no competing dunning.
3. **Braintree/PayPal** — ✅ **implemented end-to-end** (classic-gateway `sale` on a vault token, HMAC-SHA1-signed webhook ingestion, vaulted-card listing). Huge footprint, auto network tokens.
4. **Chargebee** — ✅ **implemented end-to-end** (`collect_payment` on a stored token, webhook Basic-auth verify, reconciliation poll). Best billing-platform drive surface.
5. **Recurly** — rich webhooks + native updater.
6. **Checkout.com / Cybersource** — enterprise acquirers, drive.
7. **GoCardless** — ✅ **implemented end-to-end** (retry-action co-drive with `will_attempt_retry`/Success+ deconfliction, HMAC-SHA256-signed webhooks, real failed-payment reconciliation poll, mandate listing). Opens bank-debit (EU/UK/ANZ) recovery, a segment most card-only competitors ignore.
8. **Zuora / Stripe Billing** — enterprise co-drive.
9. **Square / Nuvei / Global Payments / Worldpay** — breadth.
10. **Advisory tier** (Paddle, Apple, Google, Vindicia, PayU) — measurement + prompt integrations; ship after the drive tier proves the engine.

---

## 5. Cross-cutting concerns (every adapter)

- **Failure detection has two paths.** Not every processor emits a rich decline webhook (Cybersource, Fiserv lean on synchronous reason codes). Every adapter implements **both** a webhook path and a polling reconciler (the truth source), so we never miss or double-count a failure.
- **Card-network retry-cap compliance.** Visa/Mastercard/Amex attempt caps and non-retryable reason codes are enforced in the guardrail (`@lift/guardrail`) regardless of processor — the adapter maps processor decline codes into the canonical taxonomy so the guardrail speaks one language.
- **Exactly-once charging across processors.** Every `attemptCharge` carries a deterministic idempotency key; the reconciler is the source of truth. Bank debit adds the `will_attempt_retry`/Success+ deconfliction; app stores are advisory (no charge at all).
- **PCI scope minimization everywhere.** Every drive/co-drive adapter re-charges a **token/mandate**, never a PAN → SAQ-A posture across the board. Bank debit (GoCardless) and IAP have effectively zero card scope.
- **Reconciliation via the processor's own payout report.** Each adapter exposes the processor's settlement/payout export keyed by transaction id so the Uplift Statement (ATTRIBUTION.md §8.4) ties out penny-for-penny against the processor's own records — the CFO never has to trust Lift's dashboard.
- **Currency.** All dollar math uses the processor's settled FX from the payout record, never our own rate (ATTRIBUTION.md §9.4).
