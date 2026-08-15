# AX10M — Strategy & Honest Positioning

> Written in response to a sharp critique that was correct. This document states the
> hard truths, the decisions that follow, and how the roadmap changes. It is the
> counterweight to the (deliberately confident) pitch and architecture docs.

## 0. The core correction: we built the pricing layer, not the product

AX10M today can **prove, with unusual rigor, how much it would recover** — a live
randomized holdout, mSPRT + CUPED, a signed reconcilable ledger. What it cannot yet
do is **recover a single payment better than the incumbent**, because the recovery
brain was stubbed.

That is now being corrected in code (`@ax10m/recovery-engine`): a real
recoverability model, retry-*timing* policy, method selection, and an expected-value
reward — with a `ContextualBanditPolicy` interface so a learned policy drops in. But
be honest about what that package is: a **grounded cold-start baseline**, not a
proven winner. The trap the critique names is exact —

> if our retry logic ends up no better than Stripe Smart Retries, we've built an
> exceptionally sophisticated machine for proving that we add nothing.

**Decision.** Measurement is the pricing model and the trust mechanism. It is *not*
the product. The product is the engine, and the only thing that makes it a product
is **measured incremental lift over the baseline**. Everything is reordered around
building and proving that lift. The measurement's job is to keep us honest about
whether we've succeeded — including telling us, early and cheaply, if we haven't.

> **Update — Phase 1 backtest (negative result, and that's the point).** The first
> honest test of the thesis — `packages/backtest`, engine vs a faithful Stripe Smart
> Retries baseline in a synthetic, source-grounded world, scored through the real
> `@ax10m/attribution` estimator — found the engine **does not beat the baseline; it
> underperforms it by ~19 pp on recovery rate**, and the sign is stable across a ±30%
> sensitivity sweep. The A/A test passed (the estimator does not manufacture lift). The
> cause is concrete and fixable: the engine's ARSE retry cadence is **front-loaded**
> (last attempt ~day 11) while real recovery onsets — paydays, ~3-week card reissues,
> diffuse do-not-honor — run 2–4 weeks, so the baseline's later attempts recover more.
> This cost ~a day and saved months: it says (a) the retry-timing policy needs to reach
> later before any live pilot, and (b) in a recovery-rate-only frame with no attempt
> cost, "reach later" beats "act early and suppress" — so the engine's suppression /
> compliance edge only pays off once attempt cost and network-cap risk are priced, or
> once the cross-merchant issuer flywheel is exercised (neither is in this backtest).
> The measurement did its job: it told us early that the engine is not yet a winner.
> See `packages/backtest/out/report.md`.

> **Update 2 — timing rework, and the deeper finding.** We fixed the front-loading (the
> ARSE cadences now reach into the 2-4 week recovery window). That closed the ~19 pp gap
> to roughly parity with Smart Retries' *default* reach. But a **fairness sweep** settled
> it: against a baseline that simply retries *as far as the engine*, the engine **loses**
> (-8 to -11 pp on recovery rate). The lesson is strategic, not a bug: **in a
> recovery-rate-only frame with no attempt cost, "retry everything, for longer" beats
> selective intelligence.** The engine's edge therefore cannot be raw recovery rate — it
> has to be the things the rate metric ignores: per-attempt cost, card-network retry-cap
> compliance (a maximally-persistent baseline would breach caps and incur fines), and the
> cross-merchant issuer flywheel. Proving that needs a cost/compliance-aware objective and
> a live holdout. Until then, the honest position stands: not yet a winner, bills $0.

> **Update 3 — the cost/compliance objective, built.** We priced it: net value =
> recovered − (attempts × per-attempt cost) − fines for retrying do-not-retry declines
> (hard/fraud, *not* expired) and for exceeding the excessive-retry cap. The result is
> genuinely mixed, and worth stating precisely. **Against the Smart Retries default (~day
> 18 — what merchants actually run), the engine wins on net value**: it recovers marginally
> more at **~22% fewer attempts** ($26.05 vs $24.91/invoice). That is a real, defensible
> edge — same-or-better outcome, materially cheaper. **But against a maximally-persistent
> baseline that retries to window-close, the engine loses** ($26.05 vs $32.59): the extra
> recovery from brute persistence outweighs its extra cost and fines, and the engine only
> overtakes it once the do-not-retry fine hits an **implausible ~$20/violation**. So the
> selectivity edge is real but bounded — it beats *good* retrying, not *maximal* retrying.
> The engine's full case still depends on the cross-merchant flywheel (not exercised here)
> and on real attempt costs / hard network caps being higher than modeled. The honest
> position is now sharper, not rosier: **a cheaper way to run recovery than the default,
> not (yet) a way to recover more than a determined baseline** — and it still bills $0
> until a live holdout proves incremental lift. See the "Net value" section of
> `packages/backtest/out/report.md`.

## 1. Lead with the ledger, not "we prove lift"

"We prove incremental lift" is no longer an unoccupied position — Slicker (and
others) already claim statistical proof of incrementality, five-minute setup, and
pay-for-success. Our mSPRT-and-CUPED rigor is almost certainly deeper, but **a buyer
cannot evaluate that gap** — it's a footnote, not a differentiator.

**Decision.** Lead with the one thing that is concrete, auditable, and unmatched:
the **signed, hash-chained ledger a CFO can reconcile penny-for-penny against the
processor's own payout** (`reconcileAgainstPayout` + Ed25519 statement). "Here is a
number you can tie to Stripe's payout export and recompute yourself" beats "we use
an always-valid confidence sequence" in every room. The statistics are the *how*;
the reconcilable proof is the *why-you-can-trust-it*.

## 2. The holdout has a price, and we must quote it

To measure incrementality we must let control-group payments fail — real money the
merchant forgoes for certainty. On a merchant with $1M/yr recoverable failures at a
30% baseline recovery, a 10% holdout forgoes ~$30K/yr of recovery. At a 12% fee on
~$270K of proven uplift (~$32K), **the holdout costs about as much as our fee** —
effective cost ~24%, while competitors recover 100% with no holdout. A sharp CFO
finds this in the first meeting.

**Decision — a three-part answer, encoded in the product:**
1. **Certification window, then taper.** Full (10%) holdout only during an initial
   ~90-day certification. Once lift is established at confidence across ≥2 epochs,
   taper to a thin permanent audit holdout (≤2%). The lifecycle already models a
   taper; this makes it policy.
2. **Credit the holdout loss.** Estimate the control-arm's forgone recovery
   (control recovery rate × control volume × value) and **credit it against the
   fee** during the certification window, so the merchant's *effective* rate stays
   ≈12%, not ~24%. This turns the objection into a fairness feature. (Roadmap:
   implement `holdoutLossCredit` in the billing worksheet.)
3. **Be explicit on the statement.** The Uplift Statement already shows "value not
   billed"; it must also show "estimated holdout cost" so the trade is transparent,
   never hidden.

## 3. Statistical power silently defines the market

mSPRT won't declare significance without volume. A merchant with 500 failed
payments/month at a 10% holdout has ~50 control observations — nowhere near enough
to detect a few-point difference. Under "unproven months bill $0," **that merchant
is free forever.** So we can realistically only *bill* larger merchants — who bring
long sales cycles, procurement, security review, and in-house payments teams.

**Decision.** Size the ICP deliberately instead of discovering it:
- **Billable ICP:** merchants with roughly **≥ 3,000–5,000 failed payments/month**
  (so a 10% holdout reaches significance in a certification window). Compute the
  MDE-vs-time curve per prospect at sales time (the engine has the inputs) and
  quote "time-to-proven-lift" up front — no surprises.
- **Sub-threshold merchants:** offer a clearly-labeled **flat / estimated tier**
  ("modeled uplift, not holdout-verified") or defer them — never let them sit on a
  $0 holdout-verified plan forever. Deciding this is a pricing call, not a bug.

## 4. Card-network compliance and processor ToS (was a real omission)

**Network retry limits.** In drive mode we initiate charges on the merchant's
account and take on card-network retry-cap risk (Visa/MC cap attempts and monitor
excessive retries; breaches carry fines and acquirer scrutiny). This was absent.
**Now fixed in code:** `@ax10m/guardrail` enforces per-network rolling-window
attempt caps and a minimum inter-attempt interval as inviolable hard constraints
(conservative placeholder numbers — the *exact* caps must be confirmed per
network/region/MCC, but the enforcement mechanism is real and tested). The recovery
engine also suppresses same-card retries on dead credentials rather than burning
attempts.

**Processor ToS.** Third parties initiating charges on a merchant's Stripe (or
other) connected account is a gray zone. **Action (gating, pre-GTM):** read each
processor's connected-account / partner terms before any procurement conversation,
and design the OAuth scopes + "advisory mode" fallback so we can operate compliantly
even where drive isn't permitted.

## 5. Stripe-first — the GTM inversion

Four adapters are real (Chargebee, Adyen, Braintree, GoCardless); **the Stripe
adapter — covering the largest share of the target market — is the skeleton.** That
is backwards for go-to-market.

**Decision.** Promote the real Stripe adapter to the **next build priority**,
including the coexist-with-Smart-Retries drive path and the Stripe App marketplace
route. The breadth of other adapters proved the POAL pattern; now go deep where the
buyers are.

## 6. Our adapters are our competitors

Chargebee, Recurly, and Paddle all sell their own dunning/recovery; building on them
means depending on companies with an incentive to squeeze us (Paddle is already
advisory-only by MoR design). **Decision.** Anchor on the **processor/gateway**
layer (Stripe, Adyen, Braintree) where recovery is *not* the host's product, and
treat billing-platform adapters as reach, not foundation. Keep the advisory fallback
so a hostile platform can't fully lock us out of measurement.

## 7. Who actually buys

CFO reconciliation implies a finance buyer, but **CFOs don't buy point solutions** —
payments, RevOps, or growth teams buy, and finance approves. Different buyer,
different pitch, different proof.
**Decision — a two-audience motion:**
- **Champion (payments/RevOps/growth):** "recover more than Smart Retries, zero-code
  in an afternoon, pay only on proven lift." The engine + shadow-first onboarding.
- **Approver (finance):** the reconcilable ledger and the honest-billing guarantees.
The champion runs it; finance signs because the bill is auditable.

## 8. The missing thing that beats every paragraph: a design partner

Nothing here references a live merchant. Butter names MasterClass, The Athletic,
Athena Club. **One real logo with a signed uplift statement outweighs the entire
methodology in this repo.** This is the #1 non-code priority: land one design partner
in the billable ICP, run the certification window at cost (or free, crediting the
holdout), and publish the signed statement. Until then, every claim here is a
hypothesis.

## 9. The reordered roadmap

The `ARCHITECTURE.md` phases are re-prioritized accordingly:

1. **Recovery engine → real** — turn `@ax10m/recovery-engine` from cold-start
   heuristic into a policy trained on real outcomes; instrument the reward.
2. **Stripe adapter → real** + the "take control" charge path in a durable
   (Temporal) activity with exactly-once semantics (still stubbed).
3. **Holdout economics** — certification taper + holdout-loss credit in billing.
4. **One design partner**, certification window, published signed statement.
5. Then breadth (more adapters, marketplace, SOC 2) and ML depth (bandit/RL,
   cross-merchant issuer model).

Measurement rigor is already ahead of the field. It is a moat only if there is a
recovery engine worth measuring. Build that.
