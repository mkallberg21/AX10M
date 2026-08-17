# AX10M Design-Partner Outreach

How to recruit the first design-partner merchants — the ones who run a live
[certification window](CERTIFICATION-RUNBOOK.md) and produce the signed, reconcilable Uplift
Statement that closes the #1 gap (proven live lift). One real logo + one reconcilable statement
outweighs the entire methodology.

> **Honesty rules for anyone using these templates.** We have no published customer results yet —
> do not imply we do. Never cite a specific uplift number as *measured*; our modeled/backtest
> figures are honest but *unproven*, and the whole pitch is that the merchant's own holdout proves
> it on their data (and they pay **$0** if it doesn't). No fake urgency, no invented logos, no
> "companies like yours see X%." Bracketed `[PLACEHOLDERS]` must be filled with real specifics.

---

## 1. The offer, in one honest line

> AX10M is a zero-code overlay on your existing payments stack that recovers failed payments your
> processor's retries miss — and you pay **12% only of the recovery we can prove we caused**,
> measured against your own randomized holdout and reconcilable to your processor's payout file.
> If we can't prove it, you owe nothing.

What makes it credible without a case study: **the proof is reconcilable.** Every bill is backed by
a signed statement a CFO can recompute by hand and tie penny-for-penny to their payout report. We
lead with *verifiable honesty*, not "we also do statistics."

---

## 2. Who we're looking for (ICP)

The design partner must be able to clear the pay-only-on-proof bar inside the certification window.
Qualify with the **ICP quote** (`GET /billing/icp-quote`) — it's the real gate — plus:

- **Volume:** roughly **≥ 3–5k failed payments/month** (recurring/subscription or high-frequency).
- **Processor:** on a supported adapter (Stripe, Adyen, Braintree, PayPal, Checkout.com, GoCardless,
  and more). Stripe is the largest-TAM path.
- **Pain:** meaningful **involuntary churn** — dunning/failed-payment loss they already feel and
  ideally already try to fix (so the incremental-over-baseline framing lands).
- **Willing:** can accept a randomized holdout (we credit its cost) and give a least-privilege
  processor connection; has a champion *and* a finance approver.

Good fits: subscription SaaS, membership/creator platforms, D2C subscription, usage-billed B2B.

---

## 3. What's in it for the design partner

- **Pay only on proven lift**, and during the certification holdout the holdout credit makes the
  effective cost **≈ $0** — they prove the value on their own traffic before paying real money.
- **Zero engineering** to start (shadow mode needs only a read connection; no checkout changes).
- **A signed, reconcilable Uplift Statement** they own — a finance-grade artifact, not a vendor claim.
- **Roadmap influence** as an early partner, and preferential terms.
- **Recover involuntary churn** structurally — dead-credential recovery (Account Updater, backup
  rail, dunning) reaches cards a retry on the original number never can.

---

## 4. The two-audience motion

Land the **champion**, arm them for the **approver**. Different message, same honest core.

**Champion — payments / RevOps / growth.** Emotional hook: *recover more, zero code, pay only on
proof.*
- "You're leaving involuntary churn on the table that your processor's retries can't reach."
- "Turn it on in shadow mode with a read-only connection — no checkout changes, no risk."
- "You only pay if a randomized holdout on your own traffic proves we lifted recovery."

**Approver — finance / CFO.** Emotional hook: *provable, reconcilable, honest.*
- "Every invoice is 12% of a holdout-proven *lower bound* — we systematically under-claim."
- "The bill is backed by a signed statement you recompute yourself and tie to your payout file."
- "The holdout's cost is disclosed and credited, so the effective rate stays ~12%. Net-14."

---

## 5. Outreach assets

Fill every `[PLACEHOLDER]`. Keep it short; the reconcilable-proof angle is the differentiator.

### 5a. Cold email — champion

> **Subject:** recovering the failed payments [MERCHANT]'s retries miss — pay only if we prove it
>
> Hi [FIRST NAME],
>
> [ONE SPECIFIC LINE showing you understand their model — e.g. "You run monthly subscriptions on
> [PROCESSOR], so involuntary churn from failed renewals is real money."]
>
> AX10M is a zero-code overlay that recovers failed payments your processor's retries structurally
> can't reach — mainly **dead-credential recovery** (updated cards, backup rails, dunning). It runs
> alongside your current setup; no checkout changes.
>
> The part I think you'll care about: **you only pay 12% of the recovery we can *prove* we caused**,
> measured against a randomized holdout on your own traffic and reconcilable to your [PROCESSOR]
> payout file. If we can't prove it, you owe nothing.
>
> Worth a 20-minute call to see if you clear the bar? I can run our fit estimate on your rough
> failed-payment volume before we even talk.
>
> [NAME]

### 5b. Follow-up — for the finance approver (send after champion interest)

> **Subject:** how the AX10M bill reconciles to your payout file
>
> Hi [FINANCE CONTACT], [CHAMPION] asked me to share how billing works, since it's built for your
> team to verify, not just trust.
>
> - We bill **12% of the holdout-proven *lower bound*** of incremental recovery — never the point
>   estimate, so we under-claim by design. $0 in any month the holdout doesn't prove positive lift.
> - Every invoice is backed by an **Ed25519-signed Uplift Statement** you can recompute by hand and
>   reconcile penny-for-penny to your [PROCESSOR] payout report. We'll send the statement, the
>   transaction CSV, the hash-chained ledger, and a one-line verify command.
> - The randomized holdout has a real cost (recovery forgone on the control group). We **disclose
>   that estimate on every statement and credit it against the fee**, so the effective rate stays
>   ~12% — during the initial certification window it nets to ≈ $0.
> - Terms are net-14. No card data touches us (SAQ-A; tokens only).
>
> Happy to walk your team through a sample signed statement + reconciliation. [NAME]

### 5c. Short DM / LinkedIn

> [FIRST NAME] — we recover the failed payments [PROCESSOR]'s retries miss (dead cards, backup
> rails). Zero code to start, and you only pay 12% of what a holdout on your own traffic *proves* we
> recovered — $0 if it doesn't. Open to a 20-min fit check?

### 5d. Discovery-call script (20–30 min)

1. **Qualify (5m):** monthly failed-payment count? processor(s)? current recovery approach (Smart
   Retries / dunning / in-house)? who owns involuntary churn? Run the **ICP quote** live if you have
   the numbers.
2. **Frame the edge (5m):** we win where a blanket retry can't — dead-credential recovery + cost/
   compliance-aware selectivity, at fewer attempts and within network caps. It's an *overlay*, not a
   replacement for their processor.
3. **The honest deal (5m):** randomized holdout on their traffic → signed, reconcilable lower-bound
   statement → 12% of proven lift, holdout cost credited, $0 if unproven. Show a sample statement +
   the verify command.
4. **Certification ask (5m):** propose a ~90-day certification window (mostly shadow to start).
   Walk the [runbook](CERTIFICATION-RUNBOOK.md) phases at a high level.
5. **Next step (5m):** scoping call with their champion + a finance/security stakeholder; send the
   ICP-quote output + a sample statement afterward.

---

## 6. Objection handling (all honest)

| Objection | Honest response |
|---|---|
| "We already use Smart Retries / dunning." | We're an *overlay* on top, not a replacement. Our win is the recovery a blanket retry can't reach — dead credentials via Account Updater, backup rails, and intelligent dunning. The holdout measures the *incremental* lift over your current setup; if there's none, you owe nothing. |
| "A holdout costs us recovery." | True — and we're the only ones who *credit* it. We estimate the recovery forgone on the control group, disclose it on every statement, and credit it against the fee, so the effective rate stays ~12%. During certification it nets to ≈ $0. And we taper to a ≤2% audit holdout after proof. |
| "What uplift will we see?" | We won't quote a measured number we don't have on your data — that's the point. We can share a *modeled* range and, more usefully, run our fit estimate on your volume to size the opportunity and time-to-proof. The holdout produces the real number. |
| "Do you have customers / case studies?" | We're onboarding design partners now — you'd be early, with preferential terms and roadmap input. What we can show today is the reconcilable proof mechanism itself: a sample signed statement you can verify by hand. That verifiability is the point. |
| "Security / data?" | No card numbers ever touch us (SAQ-A; opaque processor tokens only). Connection is a least-privilege restricted key, encrypted at rest, never logged. Shadow mode moves no money. Happy to do a security review. |
| "Processor terms / who's allowed to charge?" | We operate under your authorization on your processor and de-conflict with its own retries; where a processor's terms don't allow driving, we run advisory/co-drive. We'll confirm this per processor up front. |
| "Sounds too good / where's the catch?" | The catch is the bar: it only works if you have enough failed-payment volume for the holdout to prove lift in a reasonable window. That's what the fit estimate checks before we both invest time. |

---

## 7. The ask & next step

The ask is small and reversible: **a scoping call, then a shadow-mode connection.** No money moves,
no code, no commitment until a holdout on their own traffic proves the lift.

1. 20–30 min fit call → run the **ICP quote**.
2. If it clears: scoping call with champion + finance/security → share a **sample signed statement**.
3. Sign the certification agreement (opt-in portal) → **Phase 1 shadow** connection.
4. Activate the certification holdout → in ~90 days, hand them a **signed statement on their logo**.

That statement is the asset. It converts "interesting" into "must-have" — for them, and (with their
written permission) for the next partner.

See also: [Certification-Window Runbook](CERTIFICATION-RUNBOOK.md) · [Strategy](STRATEGY.md) ·
[Competitive](COMPETITIVE.md) · [Compliance](COMPLIANCE.md).
