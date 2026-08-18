# AX10M · Processor / Platform Partnership Brochure

The copy for a one-page brochure aimed at **executives at payment processors and platforms** (a
partnership/channel pitch, not the merchant sale). A polished, print-ready visual version is
published as an Artifact. Fill the `[PLACEHOLDER]`s (founder, email, site) before sending.

> **Honesty:** design-partner stage, no fabricated merchant counts, logos, or recovery results.
> The intrigue is the *mechanism* (provable, reconcilable recovery) plus the processor-agnostic
> architecture plus the partnership, not invented proof. The stat strip cites **architecture facts**
> (adapters, registry, SAQ-A, verifiable billing), not performance claims.

---

**Eyebrow:** For payment processors & platforms · The trust layer for payment recovery

**Headline:** Every failed payment on your platform is volume *you lose too*. We recover it, and
prove exactly how much.

**Lede:** Involuntary churn (failed renewals, not cancellations) quietly bleeds authorized volume off
every processor. Most of it is **dead credentials** a blanket retry can never reach. AX10M is a
zero-code overlay that recovers it, and it's the **only** recovery layer that proves its lift with a
**cryptographically-signed, reconcilable holdout**, verifiable down to your own settlement file. And
it already speaks your API, and every other processor's.

### The opportunity
1. **The leak: recoverable, not lost.** Expired/lost/reissued/closed cards fail on renewal; retrying
   the same number can't fix a dead credential, so the volume silently churns.
2. **The recovery: reach the unreachable.** Account Updater, backup rails, and cap-compliant dunning
   recover charges a retry structurally can't, at fewer attempts and within network rules.
3. **The proof: prove, don't claim.** A randomized holdout measures the true incremental lift and
   signs it into a ledger anyone can reconcile to the payout.

### Why it matters to YOU (the processor)
- **More successful volume.** Every recovered charge is authorized volume that clears on your rails
  (more processing, more interchange).
- **Stickier, higher-LTV merchants.** Recovered involuntary churn keeps their subscribers and keeps
  them on you.
- **A value-add you don't build.** Offer provable recovery without staffing an ML + incrementality
  team; embed, co-market, or private-label.
- **ROI you can stand behind.** The signed, reconcilable holdout makes the lift defensible to
  merchants, finance, and compliance.

### Works with your stack, and everyone else's
One canonical core, an adapter per processor. AX10M isn't a competitor lock-in play. It's
infrastructure that speaks payment recovery across the whole ecosystem, zero code for your merchants.
**Your platform is already on the map.** Live adapters: Stripe · Adyen · Braintree · Checkout.com ·
Worldpay/FIS · TSYS/Global Payments · Elavon · PayPal · GoCardless · Deluxe · Chargebee · Recurly ·
Zuora · Maxio. Registry also covers Cybersource · Authorize.Net · Fiserv · Square · Nuvei · Mollie ·
and your platform. A new adapter is a well-worn template: days, not quarters.

### The differentiator
Every recovery statement is Ed25519-signed over an append-only, hash-chained ledger and reconciles
penny-for-penny to the settlement file. No card data ever touches AX10M (PCI SAQ-A). Verifiable
honesty is the moat, and the reason a processor can put its name next to it.
`verify → PASS statement hash · PASS Ed25519 signature · PASS ledger chain · reconciles to payout ✓`

### By the architecture (facts, not performance claims)
~17 live processor adapters · 40+ in the registry · 0 card numbers stored (SAQ-A) · 100% of billing
independently verifiable.

### Call to action
Let's put **provable recovery** in front of your merchants: a measured pilot on a handful of
accounts. **[Founder name] · [email] · [ax10m.com]**

*Footer:* Design-partner stage. Recovery figures are proven per-merchant by a live holdout, never
claimed in advance.

---

*See also: [Design-Partner Outreach](DESIGN-PARTNER-OUTREACH.md) · [Marketplace Prioritization](MARKETPLACE-PRIORITIZATION.md)
· [Security & Procurement](SECURITY-PROCUREMENT.md) · [Strategy](STRATEGY.md) · [Competitive](COMPETITIVE.md).*
