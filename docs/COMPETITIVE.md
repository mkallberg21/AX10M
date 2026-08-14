# Lift — Competitive Teardown

> Companion to `ARCHITECTURE.md` and `ATTRIBUTION.md`. This document characterizes the failed-payment / involuntary-churn recovery field and derives a prioritized backlog that makes Lift strictly dominant.
> Document owner: founding eng / competitive intel. Status: v0.1. Date: 2026-08-14.

**Honesty conventions used throughout.** `[VERIFIED]` = claim backed by a cited source (vendor page or third-party). `[VENDOR-CLAIM]` = the vendor's own marketing number, not independently confirmed — treat as a ceiling, not a fact. `[INFERRED]` = our analytical read, not a stated fact. `[UNVERIFIED]` = we could not confirm the entity or the fact from public sources. Pricing is marked **not public** where no number is published. We do not invent pricing.

---

## 1. Executive summary

The entire category shares one structural weakness: **nobody measures their own counterfactual with a live, simultaneous, randomized control group.** Every "pay on recovery" or "pay on lift" vendor computes a *baseline* — "what you would have recovered without us" — and bills against it. That baseline is either (a) a pre-period / cohort estimate, (b) an ML forecast, or (c) simply the gross recovered amount with no counterfactual at all. In every case the number on the invoice is a *trust-me* number the merchant cannot reconstruct from the processor's own records.

This is not a theoretical gap. **Gravy has a documented, public attribution dispute**: a customer reported Gravy projected ~45% recovery, reported ~21% in month one, but the customer's own cohort analysis (how many recipients clicked the outreach, then actually updated a card) could only credibly attribute ~1.2% incremental recovery to Gravy — the rest would have recovered anyway. Gravy's contractual defense was that projections are "estimates, not guarantees" (G2 / third-party review analysis, 2026). That is the whole category's exposure in one anecdote: **without a randomized holdout, "incremental" is unfalsifiable, and a sophisticated CFO eventually notices.**

**Lift's wedge** is to make the counterfactual *measured, not modeled*:

1. **Live randomized holdout** (customer-clustered, stratified) runs baseline-only recovery *simultaneously* under identical conditions. The lift is a difference of arms, not a forecast.
2. **Always-valid mSPRT confidence sequence** lets us read results continuously and bill the **lower confidence bound** — structural under-claiming. An unproven month bills $0.
3. **Signed, hash-chained ledger + monthly Uplift Statement** a CFO can reconcile line-by-line against the processor's own payout report, and can *recompute* (we hand over the salt post-epoch).

No competitor offers a reconcilable, signed, holdout-verified lift statement. The AI is the engine; the auditable attribution is the moat; shadow-first onboarding is the distribution. This document proves the first claim competitor-by-competitor and lists exactly what we must build so the claim holds on *every* axis, not just attribution.

---

## 2. Per-competitor teardown

### Tier A — Direct recovery / "pay-on-outcome" competitors

These are our closest analogues: they position on recovering failed payments and (mostly) bill on outcome. They are where the "unauditable baseline" attack lands hardest.

#### Redux Payments — `reduxpayments.com`
- **What it does** `[VERIFIED]` AI failed-payment recovery for **Stripe** in two phases: "silent recovery" (automated retries) and "active recovery" (customer outreach + one-click card-update links). Verified Stripe partner / marketplace integration.
- **Pricing** `[VERIFIED]` Performance-based: "Redux only charges on the **lift above what we were already recovering**." No upfront cost, no contracts. **Exact % not public.**
- **Attribution / measurement** `[INFERRED, critical]` The pricing sentence *implies a baseline* — "what we were already recovering" — but there is **no mention of a live randomized holdout or control group** anywhere on the site. The baseline is a pre-period / cohort estimate that Redux computes. This is precisely the unauditable-baseline pattern.
- **Processors** Stripe only `[VERIFIED]`.
- **Comms / dunning** Recovery emails timed to customer local timezone; one-click frictionless card-update links `[VERIFIED]`.
- **Card updater / network tokens** Frictionless card-update links `[VERIFIED]`; **no explicit network-tokenization claim** `[INFERRED]`.
- **Notable strengths** Clean Stripe-native UX; strong case-study marketing (+27% vs Stripe, 10x ROI — all `[VENDOR-CLAIM]`); pay-on-lift framing is close to ours rhetorically.
- **Exploitable weaknesses** (1) Baseline is self-computed, not a simultaneous control — the exact thing Gravy got caught on. (2) Stripe-only — no multi-processor hedge. (3) No signed/reconcilable statement. (4) Coexistence with Smart Retries is muddy: if they bill on "lift above what we were recovering," is Smart-Retries revenue in or out of that baseline?
- **How Lift beats it** Same pay-on-lift promise, but our lift is a *randomized-holdout* difference, we bill the *lower bound*, and we hand the CFO a signed statement they can recompute against Stripe's payout export. We turn "trust our baseline" into "reconstruct our experiment."

#### Butter Payments — `butterpayments.com`
- **What it does** `[VERIFIED]` ML-driven failed-payment recovery; processes failed payments individually (not batch); models customized per business. Products: **PaymentScore** (recoverability), **Outreach** (retries + comms), **Dispute** (chargeback reduction).
- **Pricing** `[VERIFIED]` Revenue share; "only profits when it recovers"; no retainer. **Exact % not public.**
- **Attribution / measurement** `[INFERRED]` ML baseline; **no randomized holdout stated.** Bills on recovered revenue vs. an ML-estimated counterfactual.
- **Processors** Multi — Stripe named; integrates with Recharge and custom in-house billing `[VERIFIED]`. More multi-processor than Redux.
- **Comms / dunning** "Outreach" consolidates retries + comms; channels not detailed publicly `[INFERRED]`.
- **Card updater / network tokens** Not mentioned publicly `[UNVERIFIED]`.
- **Notable strengths** Genuine ML depth; enterprise-oriented; multi-platform; dispute/chargeback product is a real adjacent capability most peers lack.
- **Exploitable weaknesses** (1) Sales-led, opaque — no self-serve, no public pricing, no shadow-mode proof-before-pay. (2) ML baseline, not a control group. (3) No signed audit artifact. (4) "10%+ ARR" is a `[VENDOR-CLAIM]` with no reconcilable proof.
- **How Lift beats it** Match the ML depth (recoverability model + bandit) but add the one thing an ML baseline can never provide — a *measured* counterfactual — plus self-serve shadow-mode proof and a signed statement. We also ship a dispute/chargeback module (backlog) so Butter has no orphan advantage.

#### FlyCode — `flycode.com`
- **What it does** `[VERIFIED]` Failed-payment recovery for SaaS & eCom with a **multi-processor orchestration layer** that routes failed payments across providers to the highest-approval path; ML retry-timing decisioning on hundreds of datapoints; "adaptive backup cards."
- **Pricing** `[VERIFIED]` Outcome-based — "charges only on dollars it actually recovers"; ROI-framed (4–6x on recovery, 20x on net-new). **Exact % not public** (pricing page exists but number not confirmed here).
- **Attribution / measurement** `[INFERRED]` Charges on recovered dollars; **no randomized-holdout claim.** Comparison marketing ("25–40% better than legacy," "51%→66% in a month") is before/after or vs-competitor, not a live control.
- **Processors** Multi-processor by design — the orchestration/routing story is their core differentiator `[VERIFIED]`.
- **Comms / dunning** Retry + customer outreach `[INFERRED]`; less comms-forward than the dunning tools.
- **Card updater / network tokens** **Prefers network tokens** to eliminate CVV failures on recurring charges; backup/alternate payment methods `[VERIFIED]`. Strongest public network-token story in the field besides Stripe itself.
- **Notable strengths** Multi-processor routing + network tokens = genuinely closest to our POAL/processor-agnostic thesis on the *execution* side. Strong technical content marketing.
- **Exploitable weaknesses** (1) Still no measured counterfactual — outcome billing on gross recovered dollars silently includes what the native processor would have recovered for free. (2) No signed/reconcilable statement. (3) Attribution rigor is the gap even though execution is strong.
- **How Lift beats it** Concede nothing on execution — we also do multi-processor routing + network tokens (backlog) — and win decisively on attribution: FlyCode bills on recovered dollars; we bill only the holdout-proven *incremental* lower bound. Their own "51%→66%" number would, under our method, be split into "what baseline did" vs. "what we added," and we'd only bill the latter.

#### Vindicia (Retain) — `vindicia.com`
- **What it does** `[VERIFIED]` Enterprise AI/ML payment recovery; "20+ years of payments intelligence," trained on 1.8B+ transactions; recovers up to 50% of failed recurring payments `[VENDOR-CLAIM]`; submit failed transactions via API or UI. Publishing/media and SaaS verticals.
- **Pricing** `[VERIFIED]` Success-fee — "doesn't get paid unless it recovers." **Exact terms not public** (enterprise / sales-led). Capterra lists it as enterprise.
- **Attribution / measurement** `[INFERRED]` Success-fee on recovered transactions; **no randomized-holdout claim.** Classic gross-recovery attribution.
- **Processors** "Compatible with any billing system" `[VERIFIED]`; PCI-DSS Level 1 v4 `[VERIFIED]`.
- **Comms / dunning** Engages subscribers to resolve payment issues; collaborates with the payment provider `[VERIFIED]`; specifics thin publicly.
- **Card updater / network tokens** `[INFERRED]` Works with issuer/processor updater flows via provider collaboration; not spelled out publicly.
- **Notable strengths** Incumbent credibility, huge training corpus, enterprise compliance posture (PCI L1), billing-agnostic, long track record. This is the enterprise anchor tenant.
- **Exploitable weaknesses** (1) Legacy enterprise motion — slow, sales-led, no self-serve, no shadow-mode. (2) Gross-recovery attribution, no control group, no signed reconcilable statement. (3) Opaque pricing. (4) Innovation cadence slower than startups.
- **How Lift beats it** We match the compliance bar (SOC 2 / PCI SAQ-A posture — backlog) and billing-agnosticism (POAL), then out-trust them: a 1.8B-transaction model still produces a *modeled* baseline; we produce a *measured* one and a signed statement. Against a CFO, "reconstruct our randomized experiment" beats "trust our 20 years."

#### Gravy (Gravy Solutions) — `gravysolutions.io`
- **What it does** `[VERIFIED]` **Human-to-human** failed-payment recovery — retention specialists (not purely automated dunning) contact customers whose recurring payments failed. Atlanta-based; claims $500M+ recovered and up to 80% recovery `[VENDOR-CLAIM]`.
- **Pricing** `[VERIFIED]` Customized **flat fee**, explicitly "**no percentage of revenue**." Sales-led (pricing-quote flow).
- **Attribution / measurement** `[VERIFIED — this is the category's cautionary tale]` **Documented attribution dispute.** A customer reported Gravy projected ~45% recovery, delivered ~21% reported, but cohort analysis (click-through → card-update funnel) supported crediting Gravy with as little as ~1.2% *incremental* recovery; Gravy's defense was that projections are estimates, not guarantees. Reviews also cite "lackluster reporting" and delayed explanations (G2/Capterra/third-party review analysis, 2026).
- **Processors** Multi / billing-agnostic (works over recurring-revenue stacks incl. Stripe) `[VERIFIED]`.
- **Comms / dunning** Heavy human touch + branded outreach; the human model is the differentiator `[VERIFIED]`.
- **Card updater / network tokens** `[INFERRED]` Human-assisted card updates via customer contact; no network-token automation story. Partial at best.
- **Notable strengths** High-touch brand-aligned experience; premium/enterprise recurring-revenue and subscription-box fit; flat-fee removes the "you're taking a cut of my money" objection.
- **Exploitable weaknesses** (1) **The attribution dispute is public and specific** — our single best proof point that modeled baselines fail. (2) Human model doesn't scale and is expensive per recovery. (3) Reporting/transparency complaints. (4) Flat fee means the merchant carries all the attribution risk with none of the proof.
- **How Lift beats it** We are the direct antidote to the Gravy failure mode. Where Gravy said "trust our 45% projection," we run a live control group and bill 12% of the *proven lower bound* — so if the real incremental is 1.2%, our bill reflects 1.2%, and the merchant sees exactly that, signed. Gravy is our best sales story: "here's what happens without a holdout."

### Tier B — Dunning / retention tooling (SaaS-priced, comms-forward)

These bill on flat SaaS subscription (not on lift), so they don't compete on the attribution axis directly — but they compete for the same budget and often set the merchant's price anchor. Our attack here is capability + honest-billing, not baseline-debunking.

#### Churnkey — `churnkey.co`
- **What it does** `[VERIFIED]` Retention infrastructure: cancel flows (retain ~54% `[VENDOR-CLAIM]`), payment recovery (up to 89% `[VENDOR-CLAIM]`), "precision retries," **omnichannel dunning (email/SMS/in-app)**, payment-wall (gate access until card updated), Adaptive Offers, Feedback AI, Account Agent.
- **Pricing** Not public (quote-based) `[VERIFIED]`.
- **Attribution / measurement** `[INFERRED]` Dashboard recovery metrics; SaaS pricing means no lift-billing and thus no counterfactual obligation — but also no proof of incremental value.
- **Processors** Multi (Stripe + others) `[INFERRED from "integration-ready"]`.
- **Comms / dunning** Strongest omnichannel + cancel-flow story in the field; open-source React SDK, **Data API, webhooks, and an MCP server** for AI-agent integration `[VERIFIED]` — genuinely developer-grade.
- **Card updater / network tokens** Via processor `[INFERRED]`; payment-wall drives self-update.
- **Notable strengths** Best-in-class developer surface (SDK/API/MCP), broad retention suite beyond payments (voluntary churn too), fast integration (~35 min `[VENDOR-CLAIM]`).
- **Exploitable weaknesses** (1) No holdout / no proof-of-incrementality — they don't even claim it, but a CFO asking "what's the lift vs. doing nothing?" gets a dashboard, not an experiment. (2) SaaS fee is paid whether or not value is incremental. (3) Payment recovery is one module among many — less depth on retry/issuer intelligence than Butter/FlyCode.
- **How Lift beats it** We concede the voluntary-churn/cancel-flow breadth (not our fight) and win on: proof-of-lift, honest pay-on-proven-lift pricing, and equal-or-better developer surface (our own SDK/API + Stripe App). Against their MCP/SDK we must ship comparable developer-grade tooling (backlog) so they hold no orphan advantage.

#### Churn Buster — `churnbuster.io`
- **What it does** `[VERIFIED]` Failed-payment recovery (dunning) + cancel flows + testing; addresses both involuntary and voluntary churn.
- **Pricing** `[VERIFIED]` MRR-scaled SaaS, roughly **$149–$249+/mo** per third-party comparisons (2026); enterprise higher.
- **Attribution / measurement** Dashboard metrics; no holdout `[INFERRED]`.
- **Processors** Stripe, Braintree, Recharge `[VERIFIED, third-party]`.
- **Comms / dunning** Mature multichannel dunning workflows + A/B testing `[VERIFIED]`.
- **Card updater / network tokens** Via processor `[INFERRED]`.
- **Strengths** Established, trusted, Braintree/Recharge coverage (eCom subscription niche), testing tooling.
- **Weaknesses** Flat SaaS regardless of incremental value; no proof-of-lift; no signed statement; recovery is retry+comms, not issuer-intelligence-grade.
- **How Lift beats it** Proof-of-lift + pay-only-on-proven-lift vs. their fixed monthly; deeper AI retry policy; signed statement.

#### Stunning — `stunning.co`
- **What it does** `[VERIFIED]` Stripe-focused dunning: smart retries + lifecycle/failed-payment recovery emails. Also supports Foxy, Subbly.
- **Pricing** `[VERIFIED, third-party]` ~**$120/mo** tier for Stripe businesses; simple.
- **Attribution** Email/recovery dashboards; no holdout `[INFERRED]`.
- **Processors** Stripe-centric (+ Foxy, Subbly) `[VERIFIED]`.
- **Comms** Email lifecycle is the core competence; less omnichannel than Churnkey `[INFERRED]`.
- **Card updater / network tokens** Via Stripe `[INFERRED]`.
- **Strengths** Cheap, simple, good for <$10K MRR; long-standing.
- **Weaknesses** Email-only-ish; Stripe-bound; no AI depth; no lift proof.
- **How Lift beats it** Everything above the low end: multi-processor, AI policy, omnichannel, proof-of-lift. Stunning is a price anchor, not a capability threat.

#### Baremetrics Recover — `baremetrics.com`
- **What it does** `[VERIFIED]` Dunning module bundled inside the Baremetrics **analytics** platform — retries + dunning emails + recovery tracking.
- **Pricing** `[VERIFIED, third-party]` ~**$129–$169/mo**; **cannot be bought standalone** — you buy the analytics suite.
- **Attribution** Recovery reporting within analytics; no holdout `[INFERRED]`.
- **Processors** Stripe-centric (Baremetrics' analytics roots) `[INFERRED]`.
- **Comms** Email dunning `[VERIFIED]`.
- **Strengths** Nice if you already use Baremetrics analytics; unified dashboard.
- **Weaknesses** Bundling tax (pay for analytics you may not want); recovery is basic; no lift proof.
- **How Lift beats it** Unbundled, recovery-first, proof-of-lift, deeper policy.

#### Revova — `revova.io` *(one of the four named targets)*
- **What it does** `[VERIFIED]` AI-personalized failed-payment recovery emails; "Lost Revenue Finder" scans 30 days–12 months of history; 5-email sequences personalized by failure reason; daily smart retry up to 30 days; pre-dunning alerts for expiring cards; winback + in-app cancel flow (Pro).
- **Pricing** `[VERIFIED]` **Starter $29/mo** (≤50 recoveries/mo), **Pro $79/mo** (unlimited). 14-day trial, 30-day money-back, **no commission on recovered revenue.** The clearest, cheapest transparent pricing in the field.
- **Attribution / measurement** `[VERIFIED]` Weekly recovery digests, open/click analytics, revenue forecasting — **no holdout, no counterfactual.** Flat SaaS so no lift obligation.
- **Processors** `[VERIFIED]` Stripe, Paddle, Braintree, Chargebee, Recurly — **read-only** access, no card-data storage. Notably multi-processor for a low-cost tool.
- **Comms / dunning** `[VERIFIED]` AI-generated (non-templated) emails at 8:30 AM customer-local; 8-language support; SMS on Pro; Slack/Telegram alerts.
- **Card updater / network tokens** `[INFERRED]` Pre-dunning for expiring cards + customer self-update; **no network-token or VAU/ABU automation claim** — relies on the customer to re-enter.
- **Notable strengths** Transparent low price, multi-processor read integration, decent LLM-personalized comms, self-serve. A credible SMB self-serve competitor.
- **Exploitable weaknesses** (1) Read-only / comms-only — it doesn't *drive* retries at the processor, it nudges the customer. (2) No proof-of-lift. (3) No account-updater/network-token automation. (4) No compliance guardrail (over-emailing risk). (5) No signed statement.
- **How Lift beats it** We do everything Revova does (multi-processor, AI comms, self-serve) and add the whole execution + attribution stack: driven retries, network tokens/updater, compliance guardrail, and a holdout-verified signed bill. Revova is a comms layer; Lift is a recovery *system* with proof.

#### ChurnShield — `getchurnshield.com` *(one of the four named targets)*
- **What it does** `[VERIFIED]` Stripe-only recovery: smart retry (timing by card network + failure reason), AI dunning emails, "Smart Save" cancel-intercept widget, risk scoring, revenue dashboard, win-back. Claims failure detection within 90 seconds and a **94% recovery rate** `[VENDOR-CLAIM — implausibly high, treat skeptically]`.
- **Pricing** `[VERIFIED]` Subscriber-tiered: **Starter $49/mo** (≤100 subs), **Lite $99/mo** (≤500), **Growth $199/mo** (≤2,500), **Scale custom.** "2x ROI guarantee or money back."
- **Attribution / measurement** `[VERIFIED]` Real-time dashboard (recovered revenue, recovery rate, failure classification); **no holdout.** The "94% recovery rate" is a gross-rate claim with no counterfactual — exactly the kind of number our method exposes.
- **Processors** **Stripe only** (OAuth, no API keys stored) `[VERIFIED]`.
- **Comms / dunning** `[VERIFIED]` Email, SMS (Twilio included), Slack, in-app.
- **Card updater / network tokens** `[INFERRED]` Not claimed; relies on retries + customer self-update via cancel/dunning flows.
- **Notable strengths** Fast Stripe self-serve onboarding (<2 min OAuth), decent omnichannel for the price, cancel-intercept widget, ROI guarantee.
- **Exploitable weaknesses** (1) Stripe-only. (2) Headline "94% recovery" is unaudited and conflates baseline with lift. (3) No network tokens/updater automation. (4) No compliance guardrail. (5) No signed/reconcilable proof. (6) ~2,400-customer / SMB positioning `[VENDOR-CLAIM]`.
- **How Lift beats it** Multi-processor, network tokens/updater, compliance guardrail, and — the killer — we replace an unaudited 94% with a signed lower-bound lift the CFO can reconcile. Same fast OAuth onboarding, but shadow-first so they see the money before paying.

#### Recover.ai *(one of the four named targets)* — **COULD NOT VERIFY**
- **Status** `[UNVERIFIED]` We could not confirm a company operating as "Recover.ai" in failed-payment / involuntary-churn recovery via public search (Aug 2026). Searches for the exact term surfaced only adjacent, differently-named entities:
  - **Recover Payments** (`recoverpayments.com`) — a **done-for-you agency/service** (sync your processor + comms tools, a human recovery team runs campaigns; claims recovering ≥50% of monthly lost revenue). Pricing **not public** (book-a-call). This is a service, not "Recover.ai."
  - **Baremetrics Recover** — the Baremetrics dunning module (covered above).
  - **Stripe Revenue Recovery** — Stripe's native suite (covered below).
  - **Revatto Recover** — a product named "Recover" by Revatto (not confirmed further).
- **Conclusion** Either "Recover.ai" is very new / stealth / renamed, or the name was approximate. **We are not fabricating features or pricing for it.** If the founder has a specific URL, we will re-run the teardown. Best current guess `[INFERRED]`: if it exists, it is another Stripe-first AI-dunning entrant with the same structural gap (no holdout) — the backlog below neutralizes that archetype regardless.

### Tier C — Native processor / billing-platform features (the "free" baseline)

These are what our holdout *measures as the control arm*. We coexist with them and bill only the incremental lift on top. They are not "beaten" — they are the baseline we prove ourselves against.

#### Stripe Revenue Recovery / Smart Retries — `stripe.com`
- **What it does** `[VERIFIED]` A suite inside Stripe Billing: **Smart Retries** (ML retry timing from Stripe-network signals), **card account updater** (auto-refresh expired/reissued PANs), **network tokens**, **Adaptive Acceptance** (token-vs-PAN decisioning), Enhanced Issuer Network, and dunning emails. Dashboard for failure/recovery analytics.
- **Pricing** `[VERIFIED]` Bundled with Stripe Billing (no separate lift fee — effectively "free" to Billing users). Stripe claims **$9.39 recovered per $1 spent on Billing** and **$6.5B recovered for merchants in 2024** `[VENDOR-CLAIM]`.
- **Attribution / measurement** `[VERIFIED, structural]` **It is the baseline.** Stripe reports gross recovered revenue; there is no merchant-facing randomized holdout isolating Smart Retries' incremental contribution.
- **Processors** Stripe only.
- **Card updater / network tokens** `[VERIFIED]` Best-in-class native — vault of PANs, token/PAN selection, VAU/ABU-backed updater. This is the bar FlyCode and we must match/exceed off-Stripe.
- **Strengths** Free, native, on-by-default, deep network data, world-class updater/tokens.
- **Weaknesses (as an opportunity)** Retry timing only goes so far; no omnichannel generative comms depth; no cross-merchant intelligence beyond Stripe's own; single-processor; no proof-of-*incremental* value to the merchant.
- **How Lift relates** We **coexist** — Smart Retries stays on and becomes the control arm. We bill only lift *on top of* it. This keeps Stripe a partner (Stripe App Marketplace path) and reframes our fee as honest: we never charge for what Stripe did for free.

#### Paddle Retain (formerly ProfitWell Retain) — `paddle.com`
- **What it does** `[VERIFIED]` Built-in dunning + cancel flows + term optimization inside Paddle Billing; proactive dunning for expired cards; auto-translation/localization. Claims cutting churn 25–30% `[VENDOR-CLAIM]`.
- **Pricing** `[VERIFIED]` Included with Paddle Billing (no extra cost). Historically ProfitWell Retain used a **performance / % of recovered** model for non-Paddle users; today it is primarily a Paddle-native inclusion `[INFERRED]`.
- **Attribution** `[INFERRED]` Recovery reporting; the ProfitWell heritage marketed "you only pay for recovered revenue," but **no live randomized holdout** — the historical model was a recovered-revenue attribution.
- **Processors** Paddle-centric (Paddle is a Merchant-of-Record).
- **Card updater / network tokens** `[INFERRED]` Handled within Paddle's MoR rails.
- **Strengths** Free inside Paddle; strong for Paddle/MoR merchants; good localization.
- **Weaknesses** Paddle-bound; not a fit for Stripe/Adyen/Braintree-native merchants; no holdout proof; less relevant outside the Paddle ecosystem.
- **How Lift relates** For Paddle merchants, Retain is the baseline. For everyone else, it's irrelevant. Our POAL lets us serve the 90% of the market not on Paddle.

#### Chargebee (dunning + RevenueStory) — `chargebee.com`
- **What it does** `[VERIFIED]` Integrated dunning inside the Chargebee billing platform: configurable retry schedules by decline code, automated email sequences, in-app payment-update portals; RevenueStory analytics.
- **Pricing** Part of the Chargebee subscription platform (billing-platform pricing) `[INFERRED]`.
- **Attribution** Dashboard/analytics; no holdout `[INFERRED]`.
- **Processors** Chargebee sits over many gateways (billing-agnostic in that sense).
- **Card updater / network tokens** `[VERIFIED via account-updater integrations]` Pulls updated cards via Visa/MC updater services.
- **Strengths** Deep billing flexibility; most control over dunning branching logic; already in the merchant's stack.
- **Weaknesses** Rules-based, not ML-optimized; recovery is a feature of a billing platform, not a dedicated engine; no proof-of-lift.
- **How Lift relates** Chargebee is both a *host* (we ship a Chargebee adapter — Path C) and a baseline (its native dunning is the control). We add ML policy + holdout proof on top.

#### Recurly (Revenue Optimization Engine) — `recurly.com`
- **What it does** `[VERIFIED]` Billing platform with built-in "Intelligent/Revenue Optimization" dunning: ML retry timing by decline code / subscription type / processor behavior; account updater (Visa/MC). Claims **28% more revenue than fixed retry schedules** `[VENDOR-CLAIM]`.
- **Pricing** Part of Recurly's platform pricing `[INFERRED]`.
- **Attribution** Benchmark comparisons vs. fixed schedules; no live holdout `[INFERRED]`.
- **Processors** Multi-gateway (billing-agnostic).
- **Card updater / network tokens** `[VERIFIED]` Native Visa/MC account updater.
- **Strengths** Purpose-built recovery engine among billing platforms; measurably beats naive schedules; account updater native.
- **Weaknesses** Recovery tied to using Recurly as your billing platform; "28%" is vs fixed schedules, not vs a randomized control; no signed proof.
- **How Lift relates** Adapter host (Path C) and a strong baseline. Our lift is measured *on top of* Recurly's engine — we only bill what we add beyond it.

---

## 3. Feature matrix

Legend: **Y** = yes (verified), **y** = partial / claimed / inferred, **N** = no / absent, **?** = unknown / not public, **native** = provided by the underlying processor. Attribution rigor scale: **Holdout** (live randomized control) > **ML-baseline** > **Gross** (recovered $ only) > **SaaS** (flat fee, no lift claim).

| Capability | **Lift** | Redux | Butter | FlyCode | Vindicia | Gravy | Churnkey | ChurnBuster | Stunning | Baremetrics | Revova | ChurnShield | Stripe SR | Paddle Retain | Chargebee | Recurly |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Attribution method | **Holdout** | ML-base | ML-base | Gross | Gross | Gross/est | SaaS | SaaS | SaaS | SaaS | SaaS | Gross-claim | native/gross | Gross | SaaS | Gross |
| Live randomized holdout | **Y** | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N |
| Bills lower-bound / under-claims | **Y** | N | N | N | N | N | n/a | n/a | n/a | n/a | n/a | N | n/a | N | n/a | n/a |
| Multi-processor / billing-agnostic | **Y** | N (Stripe) | y | **Y** | y | y | y | y (3) | N (Stripe) | N | y (5) | N (Stripe) | N | N (Paddle) | y | y |
| Card account updater (VAU/ABU) | **Y**(planned) | ? | ? | y | y | y(human) | native | native | native | native | N | N | **Y** | native | **Y** | **Y** |
| Network tokens | **Y**(planned) | ? | ? | **Y** | y | N | native | native | native | native | N | N | **Y** | native | y | y |
| Omni-channel comms (email/SMS/WA/push/in-app) | **Y** | y(email) | ? | y | y | y(human) | **Y** | y | y(email) | y(email) | y(email+SMS) | y | y(email) | y | y(email/portal) | y |
| Generative / AI comms copy | **Y** | y | y | y | y | N(human) | y | y | y | ? | **Y** | **Y** | N | y | N | N |
| AI retry policy (ML/bandit) | **Y**(bandit) | y | **Y** | **Y** | **Y** | N(human) | y | y | y | y | y | y | **Y** | y | N(rules) | **Y** |
| Retention-aware reward (over-dunning cost) | **Y** | N | N | N | N | N | y | N | N | N | N | N | N | N | N | N |
| Compliance / network-fine guardrail | **Y** | ? | ? | ? | y | N | ? | ? | N | N | N | N | native | native | y | y |
| Real-time explainability (per-decision) | **Y**(SHAP) | N | ? | N | N | N | N | N | N | N | N | N | N | N | N | N |
| Cross-merchant BIN/issuer intelligence | **Y** | N | y(own) | y | **Y**(1.8B) | N | N | N | N | N | N | N | **Y**(own) | y | N | y |
| Signed audit ledger / reconcilable statement | **Y** | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N |
| Dispute / chargeback intelligence | **Y**(planned) | N | **Y** | y | ? | N | N | y | N | N | N | N | native | y | N | N |
| Self-serve onboarding (OAuth, minutes) | **Y** | **Y** | N | y | ? | N | **Y** | y | **Y** | y | **Y** | **Y** | on-by-default | native | native | native |
| Shadow-mode / proof-before-pay | **Y** | N | N | N | N | N | N | N | N | N | y(history scan) | N | N | N | N | N |
| Developer SDK / API / MCP | **Y**(planned) | ? | ? | y | ? | N | **Y**(SDK+MCP) | y | ? | y | ? | y(webhooks) | **Y** | y | **Y** | **Y** |
| Pricing model | **12% proven lift** | %lift(?) | rev-share | %recovered | success-fee | flat fee | SaaS(?) | SaaS $149–249 | SaaS ~$120 | SaaS $129–169 | SaaS $29–79 | SaaS $49–199 | free(Billing) | free(Paddle) | platform | platform |
| Pricing public | **Y** | N | N | y | N | N | N | y | y | y | **Y** | **Y** | **Y** | **Y** | y | y |

Reading the matrix: **the "live randomized holdout" and "signed audit ledger" rows are all-N except Lift.** That is the moat. The rows where we currently show `(planned)` are the backlog — the capabilities we must ship so competitors hold *no* orphan advantage on execution while we keep our exclusive attribution rows.

---

## 4. The dominance backlog

Goal: beat **every** competitor on **every** row. Prioritized by (moat-protection × market-reach ÷ effort). Effort: **S** ≤ ~2 wks, **M** ~1–2 mo, **L** ~quarter+. Each item tags the competitor(s) it neutralizes.

### P0 — Protect and weaponize the moat (already core; must ship first)
1. **Randomized-holdout attribution engine + signed hash-chained ledger + monthly Uplift Statement.** `[Effort: L]` Neutralizes: **every competitor** (all-N on holdout + signed statement). This is the product. Ship the conservative recovered-$ mode first (per `ATTRIBUTION.md`). Without it we are just another dunning tool.
2. **Shadow-first onboarding (measure baseline 14 days, show projected uplift + would-be fee before activation).** `[Effort: M]` Neutralizes: **Redux, Butter, Gravy, Vindicia, ChurnShield, Revova** — none lead with "see the proven money first, then decide." Turns the holdout from a cost into the #1 sales asset.
3. **CFO-grade reconciliation export (recovered txns ↔ processor payout CSV, salt reveal for recomputation).** `[Effort: M]` Neutralizes: **Gravy** (the documented dispute), **Redux/Butter/Vindicia** (self-computed baselines). This is the literal answer to "how do I know the lift is real?"

### P1 — Reach parity on execution so no competitor has an orphan advantage
4. **Card Account Updater (Visa VAU / Mastercard ABU / Amex) + network tokenization across processors.** `[Effort: L]` Neutralizes: **Stripe SR, Recurly, Chargebee, FlyCode** (native/strong updater+tokens) and closes our biggest current gap — per `ARCHITECTURE.md §2`, updater/tokens recover more than any retry cleverness. Table stakes.
5. **Universal processor coverage via POAL adapters (Adyen, Braintree, Chargebee, Recurly, Zuora, Paddle) beyond Stripe.** `[Effort: L]` Neutralizes: **Redux, Stunning, ChurnShield** (Stripe-only) and **Paddle Retain** (Paddle-only). Our multi-processor thesis vs. FlyCode/Butter/Vindicia; makes us the only holdout-verified engine that is *also* processor-agnostic.
6. **Multi-processor / multi-rail retry routing (highest-approval path).** `[Effort: M]` Neutralizes: **FlyCode** (their core differentiator), **Butter**. Pairs with #5.
7. **Compliance / network-fine guardrail engine (attempt caps, hard-decline suppression, quiet hours, consent, per-issuer velocity) as an inviolable hard-constraint layer.** `[Effort: M]` Neutralizes: **Revova, ChurnShield, Stunning, Baremetrics, Redux, Gravy** — none advertise a fine-prevention guardrail. Real enterprise differentiator and a genuine merchant-risk reducer.
8. **Generative + omni-channel comms (email/SMS/WhatsApp/push/in-app) with hosted, PCI-minimal one-click card-update page.** `[Effort: M]` Neutralizes: **Churnkey** (omnichannel), **Revova/ChurnShield** (generative email + SMS), **Redux** (card-update links). LLM writes copy only, never the charge decision.

### P2 — AI depth that compounds into a data-flywheel moat
9. **Contextual-bandit / offline-RL retry+comms policy with retention-aware reward (prices in over-dunning/annoyance cost).** `[Effort: L]` Neutralizes: **Butter, FlyCode, Vindicia, Recurly** (ML retry) and beats all of them on the *retention-aware* reward — nobody else prices the churn cost of over-dunning a good customer.
10. **Cross-merchant BIN / issuer-behavior intelligence (privacy-safe, aggregated; consider federated / differentially-private).** `[Effort: L]` Neutralizes: **Vindicia** (1.8B-txn corpus), **Stripe SR** (network data). Our network effect: every merchant improves cold-start for the next, especially small merchants. This is the durable moat beyond attribution.
11. **Real-time per-decision explainability (SHAP rationale surfaced in dashboard + ledger).** `[Effort: M]` Neutralizes: **everyone** (all-N). "Retried Tue 02:00 local; issuer approval peaks post-midnight for NSF on this BIN; within network caps." No competitor explains individual decisions.
12. **Dispute / chargeback intelligence module (recovery that charges back is a bad recovery; feed the reward).** `[Effort: M]` Neutralizes: **Butter** (their Dispute product), **Churn Buster, Stripe/Paddle** (native dispute tooling). Removes Butter's one orphan advantage.

### P3 — Distribution, trust posture, and price transparency
13. **Developer-grade API/SDK (Node/Python/Ruby/Go/PHP) + webhooks + MCP server.** `[Effort: M]` Neutralizes: **Churnkey** (SDK+MCP), **Recurly/Chargebee/Stripe** (dev surface). One-line `lift.track(failedInvoice)` for homegrown billing (Path B).
14. **Stripe App + Marketplace listing (coexist with Smart Retries, restricted-key OAuth, least-privilege).** `[Effort: M]` Neutralizes: **Redux** (their verified-Stripe-partner edge) and turns Stripe from adversary into distribution channel. Coexistence framing is what keeps Stripe a partner.
15. **SOC 2 Type II + PCI SAQ-A posture (tokenization only, never touch PAN) + ISO 27001.** `[Effort: L]` Neutralizes: **Vindicia** (PCI L1 enterprise credibility). Required to win mid-market/enterprise and to pass Stripe app review.
16. **Free proof-mode / "measured but not yet billable" onboarding tier.** `[Effort: S]` Neutralizes: **Revova/ChurnShield/Stunning** (cheap self-serve) and **Gravy/Vindicia** (sales-led). We give away the *measurement*; we only charge on proven lift. Nobody can match "free until proven."
17. **Transparent published pricing (12% of holdout-verified lower bound) with a public ROI/uplift calculator.** `[Effort: S]` Neutralizes: **Redux, Butter, Vindicia, Gravy, Churnkey** (all pricing not-public). Price transparency is itself a trust signal in a category full of "book a call."
18. **Revenue-assurance reporting suite (dunning-effectiveness, cohort retention, forecast, per-stratum lift).** `[Effort: M]` Neutralizes: **Baremetrics/Chargebee RevenueStory** (analytics), and answers Gravy's "lackluster reporting" complaint directly.

**Top 5 to build first (highest moat-per-effort):** #1 holdout + signed ledger, #2 shadow-first onboarding, #3 CFO reconciliation export, #4 account updater + network tokens, #5 universal processor adapters. The first three make the moat *sellable*; #4–5 close the only execution gaps where incumbents currently out-feature us.

---

## 5. Positioning & messaging — claims no competitor can honestly match

1. **"We're the only recovery engine that proves its lift with a live randomized control group."** Every competitor computes a baseline; we *run* one, simultaneously, under identical conditions. `[Defensible: all-N on the holdout row.]`

2. **"You can reconcile our invoice against Stripe's own payout report, line by line — and recompute it yourself."** Signed, hash-chained ledger + salt reveal. The direct antidote to the Gravy attribution dispute. `[Defensible: all-N on signed statement.]`

3. **"We bill the lower bound, so we deliberately under-charge. If the lift isn't proven, your fee is $0."** Redux/Butter/FlyCode/Vindicia bill on point estimates or gross recovered dollars (which silently includes what your processor recovered for free). `[Defensible: nobody else bills a statistical lower bound.]`

4. **"We coexist with Stripe Smart Retries instead of asking you to turn it off — and we never bill for what Stripe did for free."** Smart Retries becomes our control arm; we only charge the incremental lift on top. `[Defensible: competitors either replace native dunning or fold it silently into their baseline.]`

5. **"Over-retrying dead cards gets you fined by Visa/Mastercard. Our guardrail makes that structurally impossible."** A hard-constraint compliance layer that overrides any learned policy. `[Defensible: no self-serve competitor advertises network-fine prevention; it's a latent risk in naive retry tools.]`

*(Bonus, once the flywheel exists)* **"Every merchant we add makes recovery smarter for the next one — cross-merchant issuer intelligence no single-tenant tool can build."** `[Defensible against single-tenant framing; Vindicia/Stripe have scale but not cross-*merchant*, privacy-safe sharing as a product.]`

---

## Appendix — verification status of the four named target companies

| Company | Verified? | Real URL | Summary |
|---|---|---|---|
| **Revova** | **Yes** `[VERIFIED]` | revova.io | Real. AI-dunning email tool, $29–79/mo flat, multi-processor read-only (Stripe/Paddle/Braintree/Chargebee/Recurly), comms-only, no holdout, no updater/tokens. |
| **ChurnShield** | **Yes** `[VERIFIED]` | getchurnshield.com | Real. Stripe-only recovery, $49–199/mo tiered, smart retry + AI dunning + cancel widget + SMS/Slack, claims 94% recovery (unaudited), no holdout. |
| **Gravy (Solutions)** | **Yes** `[VERIFIED]` | gravysolutions.io | Real, established. Human-to-human recovery, flat fee, $500M+ recovered claim. **Documented public attribution dispute** (projected ~45%, customer-credible incremental ~1.2%) — our best proof point. |
| **Recover.ai** | **No** `[UNVERIFIED]` | — | Could not confirm any company by this exact name in the space (Aug 2026). Nearest real entities: Recover Payments (recoverpayments.com, done-for-you agency), Baremetrics Recover, Stripe Revenue Recovery, Revatto Recover. **No features/pricing invented.** Need a URL from the founder to proceed. |

---

## Sources

- Revova — https://revova.io , https://revova.io/blog , https://revova.io/blog/what-is-dunning
- ChurnShield — https://getchurnshield.com/
- Gravy Solutions — https://www.gravysolutions.io/ , https://www.gravysolutions.io/about ; reviews/dispute analysis via https://www.g2.com/products/gravy-solutions-gravy/reviews , https://www.capterra.com/p/180563/Gravy/
- Recover Payments (not "Recover.ai") — https://recoverpayments.com/
- Redux Payments — https://www.reduxpayments.com/
- Butter Payments — https://www.butterpayments.com/ , https://www.butterpayments.com/guides/disputes-chargebacks-guides/involuntary-churn/
- FlyCode — https://www.flycode.com/ , https://www.flycode.com/pricing , https://www.flycode.com/blog/top-payment-recovery-platforms-2026-comparison-chart-success-rate-stats , https://www.flycode.com/products/recover/adaptive-backup-cards
- Vindicia — https://vindicia.com/retain/overview/ , https://vindicia.com/technical-center/faq/vindicia-retain-faq/ , https://www.capterra.com/p/236809/Vindicia-CashBox/
- Churnkey — https://churnkey.co/ , https://churnkey.co/blog/stripe-smart-retries
- Churn Buster — https://churnbuster.io/ , https://churnbuster.io/articles/best-dunning-management-software/
- Stunning — https://stunning.co/
- Baremetrics Recover — https://baremetrics.com/blog/recover-failed-payments-save-lost-revenue
- Stripe Revenue Recovery / Smart Retries — https://stripe.com/blog/how-we-built-it-smart-retries , https://stripe.com/newsroom/news/network-tokens-card-account-updater , https://stripe.com/authorization-boost
- Paddle Retain — https://www.paddle.com/retain
- Chargebee — https://www.chargebee.com/resources/guides/involuntary-churn-payment-failed/ , https://www.chargebee.com/blog/dunning-management-for-saas-business/
- Recurly — comparison data via https://www.selecthub.com/subscription-management-software/chargebee-vs-recurly/
- Third-party comparisons (pricing anchors) — https://www.rebounce.dev/blog/best-dunning-tools-2026 , https://fungies.io/best-dunning-software-saas/ , https://www.slickerhq.com/resources/blog/best-revenue-recovery-tools-stripe-subscription-businesses

> Caveat on sources: vendor pages and third-party "best dunning tools 2026" listicles are marketing-adjacent; recovery-rate and ROI figures are `[VENDOR-CLAIM]` unless independently reproduced. Pricing from third-party comparison sites (Churn Buster, Stunning, Baremetrics) should be reconfirmed on the vendors' own pricing pages before use in sales collateral.
