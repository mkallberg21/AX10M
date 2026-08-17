# AX10M — Pricing & Terms Summary

A plain-language, one-page summary for a champion to share internally and for finance to skim.

> **This is a summary, not the contract.** The binding terms are the AX10M Recovery Services
> Agreement ([draft](../packages/billing/TERMS.md), pending counsel review). Where this summary and
> the signed agreement differ, the signed agreement governs. Figures are in **USD** unless noted.

---

## The model in one line

> You pay **12% of the incremental recovery AX10M proves it caused** — measured against a randomized
> holdout on your own traffic and reconcilable to your processor's payout file. **$0 in any month it
> isn't proven.**

There is **no setup fee, no platform/seat fee, and no charge for unproven periods.** You pay only a
share of net-new money AX10M recovered that your existing setup wouldn't have.

---

## Pricing at a glance

| | |
|---|---|
| **Fee** | **12%** of proven incremental uplift |
| **Basis** | Holdout-verified **lower bound** of net incremental recovered value (we bill the floor, not the estimate) |
| **Net of reversals** | Refunds & chargebacks claw back the fee; a won chargeback re-accrues it |
| **Billing cadence** | Monthly, for the prior period |
| **Payment terms** | **Net-14** |
| **Late charge** | **1.5%/month** finance charge on undisputed overdue balances (a finance charge, not a penalty; the fee rate never changes) |
| **Holdout credit** | The recovery forgone on the control group is **estimated, disclosed, and credited** against the fee |
| **Minimum / unproven months** | **$0** — no minimum, nothing owed when lift isn't proven |
| **Setup / platform / seat fees** | **None** |

---

## How the bill is computed

1. A randomized **holdout** splits failed payments: a control group keeps your existing recovery
   (untouched), the treatment group gets AX10M.
2. We measure the incremental net recovered value with an always-valid sequential test and report a
   **lower bound** — so we systematically **under-claim**.
3. The fee is **12% × that proven lower bound**, **never re-billing** uplift proven in a prior period.
4. It's **net of reversals**, and reduced by the **holdout credit** (below).
5. Every bill is backed by an **Ed25519-signed statement** you can recompute and reconcile
   penny-for-penny to your processor payout report.

## The holdout credit (why the effective rate stays ~12%)

Running a holdout has a real cost: the recovery you forgo on the control group. AX10M is built to
**credit that back**, so you never pay more than ~12% of the value it creates, holdout and all:

- **During the ~90-day certification window (10% holdout):** the credit offsets the large majority
  of the fee → **net billed ≈ $0**. You prove the value on your own traffic before paying real money.
- **After taper to a ≤2% permanent audit holdout:** the credit is small, so you pay **≈ the full
  12%** of proven lift going forward.
- **All-in cost** (fee paid + recovery forgone to the holdout) stays **≈ 12%** of the value AX10M
  creates, throughout.

Every statement itemizes the gross fee, the estimated holdout cost, the credit, and the net owed.

## Illustrative arithmetic *(not a performance claim)*

*Hypothetical numbers to show the calculation only — your actual proven uplift comes from your
holdout.* If a month's holdout proves **$10,000** of incremental recovery (lower bound):

- Gross fee = 12% = **$1,200**.
- **During certification (10% holdout):** credit ≈ the fee → **net billed ≈ $0**.
- **Steady state (2% audit holdout):** small credit → **net billed ≈ $1,000–$1,020**.
- If the holdout proves **$0** of incremental recovery that month → you owe **$0**.

---

## How you pay

- **Auto-pay (default):** a card/bank method is saved via your processor (Stripe SetupIntent — the
  card number never touches AX10M); the monthly fee is charged off-session on the invoice date.
- **Invoice / net-14 (enterprise fallback):** an invoice goes to your accounts-payable contact,
  payable within 14 days by ACH/wire, with PO support.

## Fit & eligibility

The pay-only-on-proof model requires enough failed-payment volume for the holdout to prove lift in a
reasonable window — roughly **≥ 3–5k failed payments/month**. We run a **fit estimate** on your
volume up front (time-to-proven-lift + whether you clear the floor) before either side commits.

## Design-partner terms

Early design partners get **preferential terms** — [e.g. a reduced rate for an initial period and/or
an extended certification window — SPECIFY] — plus roadmap input. The certification window itself is
effectively **$0** (holdout-credited), so you prove value before paying.

## Verify it yourself

You never have to trust our billing. With each statement you get the signed statement, the
transaction CSV, the hash-chained ledger, and the public key, and can verify + reconcile in one
command (`scripts/verify-statement.mjs`). See the [Certification-Window Runbook](CERTIFICATION-RUNBOOK.md).

---

*Summarizes the draft [Recovery Services Agreement](../packages/billing/TERMS.md) (counsel review
pending). See also: [Design-Partner Outreach](DESIGN-PARTNER-OUTREACH.md) ·
[Security & Procurement](SECURITY-PROCUREMENT.md).*
