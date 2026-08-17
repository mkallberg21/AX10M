# AX10M Design-Partner Case Study — **TEMPLATE**

A fill-in template for publishing a design partner's results. The whole point of an AX10M case study
is that its numbers are **not** a vendor claim — they come from a **signed, holdout-verified Uplift
Statement the customer reconciled to their own processor payout**. That verifiability is the story.

> ## ⚠️ Honesty rules — read before filling a single number
>
> 1. **Every metric is a `[PLACEHOLDER]`.** Fill each one **only** from a real, signed, reconciled
>    Uplift Statement for this merchant. Never estimate, never round up, never carry over a number
>    from the backtest/demo, and never use a figure the merchant hasn't verified.
> 2. **Report the proven lower bound, not the point estimate.** We bill the lower bound; publish the
>    same number. If a point estimate is shown at all, label it clearly as an estimate, distinct
>    from what was proven.
> 3. **Net of reversals.** Use net recovered value (after refunds/chargebacks), matching the statement.
> 4. **Get written permission** from the merchant to use their name, logo, quote, and numbers before
>    publishing. Confirm the finance/legal owner signs off on the figures.
> 5. **No cherry-picking.** Report a representative certification period, not the best week. Disclose
>    the window length and the holdout design.
> 6. **A $0 or small result is still an honest case study** ("we proved we couldn't beat their
>    baseline, and they paid nothing") — it may not be one you publish, but never inflate it into one.
> 7. **Link the proof.** Where possible, let the reader verify: reference the signed statement + the
>    one-line verify command.
>
> If a claim can't be traced to a line on the signed statement or the merchant's own data, it
> doesn't go in.

---

## 1. Hero block (at a glance)

> ### [MERCHANT NAME] recovered `$[PROVEN LOWER-BOUND UPLIFT / period]` in payments its retries were missing — and paid only for what AX10M proved.
>
> | Metric | Value | Source |
> |---|---|---|
> | Proven incremental recovery (holdout lower bound) | **$[X] / [period]** | signed Uplift Statement |
> | Recovery-rate lift (treatment vs. control) | **+[X] pp** ([treatment]% vs. [control]%) | statement / holdout |
> | Attempts to recover it | **[X]% [fewer/comparable]** vs. baseline | merchant's processor data |
> | Time to proven lift | **[X] days** | certification window |
> | What they paid | **$[NET BILLED]** ([effective rate]% of value, holdout-credited) | statement |
> | Independently verified? | **Yes** — reconciled to [PROCESSOR] payout | verify script |

*(Only include rows you can fill from real, verified data. Delete the rest.)*

## 2. The merchant

- **Who:** [MERCHANT NAME], [what they do — e.g. "a subscription [category] business"], on [PROCESSOR(S)].
- **Scale / ICP fit:** ~[X] failed payments/month. *(This is why they cleared the pay-only-on-proof bar.)*
- **Champion:** [ROLE — e.g. Head of Payments/RevOps]. **Approver:** [ROLE — e.g. CFO/Controller].

## 3. The challenge

[1–2 short paragraphs, specific to this merchant. Frame the *involuntary churn* they already felt:
failed renewals their processor's retries weren't recovering — especially dead credentials (expired/
lost/closed cards) that a retry on the same number structurally can't fix. Note what they already
tried (Smart Retries / in-house dunning) so the *incremental* framing is clear. Use their words
where possible; no invented pain.]

## 4. The approach

- **Zero-code start.** [MERCHANT] connected [PROCESSOR] read-only; AX10M ran in **shadow mode** —
  measuring their true baseline, moving no money.
- **Randomized holdout.** A control group kept [MERCHANT]'s existing recovery untouched; the
  treatment group got the AX10M engine — so the difference is *causal*, not correlational.
- **Where the lift came from.** [Fill from what actually drove this merchant's result — e.g.
  dead-credential recovery via Account Updater + backup rails + intelligent dunning; cost/compliance-
  aware selectivity within network caps. Only claim mechanisms that materially contributed *here*.]
- **~[X]-day certification window**, then taper to a ≤2% permanent audit holdout.

## 5. The results *(fill only from the signed statement)*

[Lead with the proven lower-bound incremental recovery for a representative certification period.
Then the recovery-rate lift with its arms (treatment% vs control%). Then efficiency (attempts) if the
merchant's data supports it. State net-of-reversals. State what they paid (net billed after the
holdout credit) and the effective rate. Every figure traces to the statement or the merchant's
processor data.]

> Example structure (replace all bracketed values with verified numbers):
> "Over a [X]-day certification window, AX10M proved **$[LOWER BOUND]** of incremental net recovery
> for [MERCHANT] — a **[treatment]% vs. [control]%** recovery rate on held-out failed payments —
> using **[X]% fewer/comparable** charge attempts. [MERCHANT] paid **$[NET BILLED]** for it (the 10%
> certification holdout credited to ≈ $0 during proof)."

## 6. Proof, not promises *(the differentiator)*

> Every dollar above is backed by an **Ed25519-signed Uplift Statement** whose hash covers the
> tamper-evident ledger it was computed from. [MERCHANT]'s finance team **recomputed the fee by hand
> and reconciled the recovered transactions penny-for-penny to their [PROCESSOR] payout report** —
> then verified the signature and ledger chain in one command:
>
> ```
> node scripts/verify-statement.mjs uplift-statement.json <pubkey>.pem uplift-ledger.json
> # → PASS statement hash · PASS Ed25519 signature · PASS ledger chain
> ```
>
> This is the difference between a vendor telling you a number and you *proving* it yourself.

## 7. In their words

> "[REAL QUOTE from the champion or finance approver — obtained and approved in writing. Do not
> paraphrase into a stronger claim than they made.]"
> — **[NAME, TITLE, MERCHANT]**

## 8. What's next

[Steady-state: the ≤2% audit holdout keeps producing a signed statement each period, so [MERCHANT]
never has to trust an unverifiable number. Note any expansion — more processors, more geographies.]

---

## Metric source map — where each number comes from

Fill placeholders **only** from these sources; if a source doesn't exist for a metric, drop the metric.

| Placeholder | Source (verified) |
|---|---|
| Proven incremental recovery (lower bound) | Uplift Statement — the billed lower-bound dollars |
| Recovery-rate lift / treatment vs control | Statement holdout arms (treatment vs control recovery rate) |
| Confidence / statistical status | Statement — always-valid (mSPRT) status; SRM passed |
| Attempts (fewer/comparable) | Merchant's processor data (treatment vs control attempt counts) — **not** the backtest figure |
| Net of reversals | Statement — recovered net of refunds/chargebacks |
| What they paid / effective rate | Statement — net billed after holdout credit |
| Time to proven lift | Certification window length to first cleared lower bound |
| Reconciliation | Merchant tied recovered transactions to their processor payout file |

## Honest reporting — do / don't

| Do | Don't |
|---|---|
| Report the **proven lower bound** | Publish the point estimate as if it were proven |
| Use **net** recovered (after reversals) | Quote gross recovery |
| Show a **representative** certification period | Cherry-pick the best week |
| Attribute lift to mechanisms that **materially** drove *this* result | Recite the generic feature list as if all applied |
| Cite **this merchant's** verified numbers | Reuse backtest/demo/other-merchant figures |
| Get **written permission** for name/logo/quote/numbers | Publish before finance + legal sign-off |
| Let the reader **verify** (signed statement) | Ask the reader to "trust us" |

## Pre-publication checklist

- [ ] Every number traces to the signed statement or the merchant's own processor data
- [ ] Lower bound (not point estimate); net of reversals; representative period disclosed
- [ ] Holdout design + window length stated; effective rate reflects the holdout credit
- [ ] Quote is real, in writing, and not strengthened beyond what was said
- [ ] Merchant name/logo/quote/numbers approved **in writing** (marketing + finance + legal)
- [ ] Signed statement + verify command referenced (or available on request)
- [ ] Reviewed against these honesty rules end to end

---

## Short version (social / one-liner)

> **[MERCHANT]** recovered **$[LOWER BOUND]/[period]** in failed payments their retries missed — proven
> by a randomized holdout, signed, and reconciled to their own [PROCESSOR] payout. They paid only for
> what we proved. *(Numbers from a verified Uplift Statement, published with permission.)*

*See also: [Design-Partner Outreach](DESIGN-PARTNER-OUTREACH.md) ·
[Certification-Window Runbook](CERTIFICATION-RUNBOOK.md) · [Pricing Summary](PRICING-SUMMARY.md).*
