# AX10M — Marketplace & Distribution Prioritization

Which app-marketplace / distribution channels to invest in, in what order, and — just as important —
which ones to **not** build yet. Distribution is a force multiplier on a proven product; it's a
liability on an unproven one.

> **Core principle: distribution follows proof.** A listing drives self-serve installs. Installs into
> a product with no proven results and no live merchants produce early churn, poor first reviews, and
> wasted app-review cycles you can't undo. Land 1–3 hand-picked design partners and a signed,
> reconcilable statement **first**; then open a channel — starting with the highest-TAM, best-fit one.

---

## How to score a channel

`Priority ≈ (TAM × Integration-fit) ÷ Build-effort`, then **gated** by prerequisites (a channel can
score high and still be "not yet" because a gate isn't met).

- **TAM** — how many ICP merchants (≥ ~3–5k failed payments/month) the channel reaches.
- **Integration fit** — AX10M's value by mode: **drive** (we re-attempt → full value) > **co-drive**
  (alongside the platform's own retries → partial) > **advisory** (platform owns the token → weakest).
- **Build effort** — is there a real installable app to build (OAuth app + UI extension + security/app
  review), or just a partner-directory listing?
- **Gate** — the hard prerequisites (charge authority, a shippable app, proof) that must clear first.

## The matrix

| Channel | Marketplace type | TAM | AX10M fit | Build effort | Hard gate(s) | Tier |
|---|---|---|---|---|---|---|
| **Stripe App Marketplace** | Installable apps, large | ★★★ | **drive** (best) | High — real Stripe App (OAuth/UI ext) + app review + security review | Live proof · charge authority confirmed · platform Stripe acct | **1 (primary)** |
| **Shopify App Store** | Installable apps, large | ★★☆ | co-drive (Shopify owns tokens + has its own subscription dunning) | High — Shopify app + review | Live proof · Shopify value validated | 2 (secondary) |
| **Chargebee / Recurly / Zuora / Maxio** | Partner *directories* / integration listings | ★☆☆ each | drive/co-drive | Low — a directory listing, not an app install | Live proof · a reference logo on that platform | 3 (opportunistic, low effort) |
| **WooCommerce (WordPress plugin)** | Plugin directory | ★☆☆ | co-drive | Medium — a maintained WP plugin | Live proof · demand signal | 3 (opportunistic) |
| **Adyen · Braintree · PayPal · Worldpay · TSYS · Elavon** | No consumer app marketplace | ★★☆ (Adyen) | drive | N/A — direct/partner sales, not a listing | Direct BD relationship | Direct sales, not a listing |
| **Paddle (true MoR)** | Marketplace exists | ★☆☆ | **advisory** (owns the token — weakest) | Medium | — | Skip / low value |

## What "build a real Stripe App" actually entails (so the effort is honest)

A listing is the *last* step. Before AX10M can appear on the Stripe App Marketplace:

1. A **Stripe App** — a UI extension (Stripe Dashboard surface) and/or a Connect OAuth application —
   requesting **exactly** the least-privilege scopes in [STRIPE-APP-LISTING.md §6](STRIPE-APP-LISTING.md).
2. A **read-only "shadow" install path** the merchant can try with no money movement.
3. **Stripe app review** — functionality, data-handling, and the coexistence-with-Smart-Retries /
   charge-authority posture (see [COMPLIANCE.md](COMPLIANCE.md)).
4. Live **privacy / terms / DPA / support** URLs and a **security review** (SIG/CAIQ, and increasingly
   SOC 2 as you scale — see [SECURITY-PROCUREMENT.md](SECURITY-PROCUREMENT.md)).
5. The listing content (done — [STRIPE-APP-LISTING.md](STRIPE-APP-LISTING.md) + the published visual).

## Phased rollout (tied to proof milestones)

- **M0 — now (no live merchant):** **No listings.** Keep the Stripe listing content + mockup ready;
  do not submit. Focus 100% on landing design partners (the [outreach kit](DESIGN-PARTNER-OUTREACH.md)).
- **M1 — 1–3 signed, reconciled statements + charge authority confirmed:** Build the **Stripe App**
  and submit the **one** Stripe listing. Add a permissioned case study ([template](CASE-STUDY-TEMPLATE.md)).
- **M2 — Stripe channel producing installs that certify + retain:** Add **Shopify App Store** *only if*
  the co-drive value is validated on a real Shopify merchant, and drop **lightweight directory
  listings** on the billing platforms where you have a reference logo.
- **Never (unless demand pulls):** the no-marketplace processors (direct/partner sales instead) and
  advisory-only MoRs.

## Decision rules

- **Don't open a channel you can't support.** Each live marketplace adds security scrutiny, review
  maintenance, and support surface. Open one, prove you can run it, then open the next.
- **Revisit quarterly**, or immediately when a milestone flips (first signed statement; charge
  authority resolved; a channel-specific reference logo).
- **One channel at a time.** Depth on Stripe beats breadth across ten directories with no installs.

*See also: [Stripe App listing](STRIPE-APP-LISTING.md) · [Go-live readiness](GO-LIVE-READINESS.md) ·
[Outreach](DESIGN-PARTNER-OUTREACH.md) · [Strategy](STRATEGY.md) · [Competitive](COMPETITIVE.md).*
