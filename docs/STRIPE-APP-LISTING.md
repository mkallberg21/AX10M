# AX10M — Stripe App Marketplace Listing

The complete listing content + submission spec for AX10M's Stripe App. This is the versioned source
of truth for the copy, permissions, data-handling disclosures, and assets. A visual preview of the
listing is published as an artifact (see [§9](#9-visual-preview)).

> **Boundary (honest).** Publishing a live listing requires a real Stripe App / Connect application
> and passing Stripe's app review — that needs your Stripe org and credentials, which I can't do.
> This document is the ready-to-submit content + a submission checklist. **Honesty rules:** no
> fabricated merchant counts, ratings, "trusted by" logos, or uplift numbers presented as results.
> AX10M is design-partner stage; the pitch stands on the *honest, verifiable* value prop, not fake
> social proof. Fill every `[PLACEHOLDER]` with real values before submitting.

---

## 1. Identity

| Field | Value |
|---|---|
| **App name** | AX10M — Proven Payment Recovery |
| **Tagline** (≤ ~60 chars) | Recover failed payments. Pay only for what we prove. |
| **Categories** | Revenue & retention · Dunning / recovery · Reporting & analytics |
| **Icon** | `[512×512 AX10M mark, transparent PNG]` — see §8 assets |
| **Website** | `[https://ax10m.com]` |
| **Support** | `[support@ax10m.com]` · Docs: `[https://ax10m.com/docs]` |
| **Privacy policy / Terms** | `[/privacy]` · `[/terms]` — and the [DPA](DPA-TEMPLATE.md) on request |

## 2. Short description (one line)

> An overlay that recovers the failed payments Stripe's retries miss — and bills 12% only of the
> recovery it can **prove** it caused, measured by a randomized holdout and reconcilable to your
> Stripe payout.

## 3. Long description

**Recover more involuntary churn — and only pay for the recovery you can verify.**

AX10M runs alongside Stripe (and Smart Retries), not instead of it. It targets the failed payments a
blanket retry structurally can't recover — **dead credentials** (expired, lost, closed cards) — using
Account Updater refreshes, backup payment rails, and intelligent, guardrail-compliant dunning. Every
attempt respects card-network retry caps, quiet hours, and consent.

What makes AX10M different isn't "we also do stats." It's **verifiable honesty**:

- A **randomized holdout** on your own traffic measures the *incremental* recovery AX10M caused —
  not correlation, not a projection.
- You're billed **12% of the holdout-proven lower bound** (we bill the floor, never the estimate),
  net of refunds and chargebacks, and **$0 in any month it isn't proven**.
- Every bill is backed by an **Ed25519-signed Uplift Statement** your finance team can recompute by
  hand and reconcile **penny-for-penny to your Stripe payout report** — then verify the signature in
  one command. You never have to trust our number; you can prove it.

**Zero code to start.** Connect read-only and run in **shadow mode** first: AX10M measures your true
baseline and shows the projected opportunity while **moving no money**. Turn on live recovery when
you're ready. No card data ever touches AX10M (SAQ-A; tokens only).

## 4. Key features

- **Dead-credential recovery** — Account Updater + backup-rail fallback + dunning recovers cards a
  same-number retry can't reach.
- **Pay only on proven lift** — 12% of the holdout-verified lower bound; $0 when unproven.
- **Reconcilable, signed billing** — every statement is cryptographically signed and ties to your
  Stripe payout, line for line.
- **Randomized holdout, done honestly** — always-valid measurement (mSPRT), net of reversals, with
  an estimated-holdout-cost credit so your effective rate stays ~12%.
- **Compliance built in** — network retry caps, quiet hours, consent, and opt-out enforced before
  any attempt; a cost/compliance-aware engine that backs off before the cap.
- **Zero-code shadow mode** — see the opportunity before you enable anything; no checkout changes.
- **Coexists with Smart Retries** — an overlay, not a replacement.

## 5. Pricing (displayed)

- **12%** of proven incremental recovery (holdout-verified lower bound), net of reversals.
- **$0** in any month lift isn't proven. **No setup, platform, or seat fees.**
- The certification-window holdout is credited to **≈ $0** while you prove the value.
- Net-14 for invoiced merchants; auto-pay available. See [Pricing Summary](PRICING-SUMMARY.md).

## 6. Permissions & data (least-privilege, honest)

AX10M requests only what each mode needs. **Shadow mode is read-only.**

| Access | Why | Mode |
|---|---|---|
| Read `charges`, `payment_intents`, `invoices`, `customers`, `events` | Detect failed payments; measure baseline + treatment recovery | Shadow + Live |
| Read `payouts`, `balance_transactions` | Reconcile recovered transactions to your payout report | Shadow + Live |
| Read `payment_methods` (metadata only) | Route dead-credential recovery (issuer/BIN attributes — **never the PAN**) | Shadow + Live |
| Write `payment_intents` (create/confirm) | Drive compliant recovery attempts | **Live only** |
| Read `disputes`, `refunds` | Net recovered value of reversals (fee clawback / re-accrual) | Shadow + Live |

**Data handling.** AX10M never receives, stores, or transmits card numbers, CVV, or track data
(**PCI SAQ-A**). It stores failed-payment event metadata, opaque tokens, issuer/BIN-derived
attributes, and dunning contact fields. Credentials are encrypted (AES-256-GCM) at rest and never
logged. Money movement and outbound comms are **default-off** and gated. See
[Security & Procurement](SECURITY-PROCUREMENT.md), [SIG/CAIQ](SIG-CAIQ-PREFILL.md), and the
[DPA](DPA-TEMPLATE.md).

## 7. Setup / onboarding steps (shown in the listing)

1. **Install** the AX10M app on your Stripe account (grants read-only access to start).
2. **Shadow mode** runs automatically — AX10M measures your baseline and shows the projected
   opportunity. No money moves; no code.
3. **Review** the projection + your fit estimate (time-to-proven-lift).
4. **Activate** the certification holdout when ready (enables live recovery on the treatment arm).
5. **Get your signed statement** — verify it and reconcile to your payout. Pay only for proven lift.

## 8. Assets checklist (for submission)

- [ ] App icon — 512×512 transparent PNG (AX10M mark)
- [ ] 3–6 screenshots — shadow-mode projection, the live P&L, a signed Uplift Statement + verify
      command, the cohort/holdout breakdown, the compliance guardrail view *(use real UI, no
      fabricated numbers — the demo/shadow views are labeled synthetic)*
- [ ] Short demo video/GIF (optional) — connect → shadow → signed statement
- [ ] Privacy policy, Terms, and DPA URLs live
- [ ] Support email + docs URL live

## 9. Visual preview

A polished, theme-aware HTML preview of this listing is published as an Artifact (design concept;
labeled a listing preview, not a live Stripe page). Share it with design/marketing and use it to
brief the real Stripe App submission.

## 10. Submission checklist (Stripe app review)

- [ ] Stripe App built (UI extension and/or a Connect OAuth app) with the least-privilege scopes above
- [ ] OAuth scopes match §6 exactly; no unused permissions requested
- [ ] Data-handling + PCI SAQ-A disclosures accurate; DPA available
- [ ] No misleading claims; no fabricated metrics/logos/reviews; pricing accurate
- [ ] Test-mode install + happy path verified for Stripe's reviewers
- [ ] Support, privacy, terms, DPA URLs resolve
- [ ] Coexistence-with-Smart-Retries + processor-authority posture documented (`docs/COMPLIANCE.md`)

---

*See also: [Design-Partner Outreach](DESIGN-PARTNER-OUTREACH.md) · [Pricing Summary](PRICING-SUMMARY.md)
· [Security & Procurement](SECURITY-PROCUREMENT.md) · [Certification Runbook](CERTIFICATION-RUNBOOK.md).*
