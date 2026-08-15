# AX10M — Compliance notes (drive mode)

Two compliance surfaces matter the moment AX10M *drives* a charge on a merchant's
account: **card-network retry limits** and **third-party charge authority**. This
document is deliberately honest about what is verified in code, what is structurally
true about the rules, and what must be confirmed with the networks, the acquirer,
Stripe, and legal counsel before production.

> **This is not legal advice.** Specific numeric limits and permissions below are
> flagged where they are unverified. Do not treat a placeholder as authoritative.

---

## 1. Card-network retry-cap compliance

### 1.1 What AX10M enforces today (verified in code + tests)

The compliance guardrail (`@ax10m/guardrail` `evaluate`) is a **hard-constraint layer**,
not a warning: it returns `{ allow: false, reason }` and the recovery path never
charges on a suppression (`apps/api` `attemptRecovery` records `action.suppressed` and
returns without calling the adapter). This is covered by tests in
`packages/guardrail/src/guardrail.test.ts`:

- **Hard-family declines** (lost/stolen/closed/invalid/pickup/…) → suppressed, no retry.
- **Non-retriable codes** (`expired_card` same-card, `fraudulent`) → suppressed.
- **Global fallback attempt cap** (default 8) → suppressed once reached.
- **Per-network rolling-window caps + a minimum inter-attempt interval** →
  `network_window_cap_reached` / `min_interval_not_elapsed`, both hard suppressions.
  Tests assert Visa 15 and the *tighter* Mastercard 10 cap both suppress, and that a
  retry under the cap is allowed.
- Unknown action kinds **fail closed**.

Default caps (`DEFAULT_GUARDRAIL_POLICY.networkCaps`), all a 30-day window / ≥60 min
between attempts:

| Network | Max attempts / window | Status |
|---|---|---|
| Visa | 15 / 30d | **placeholder — confirm** |
| Mastercard | 10 / 30d | **placeholder — confirm** |
| Amex | 10 / 30d | **placeholder — confirm** |
| Discover | 10 / 30d | **placeholder — confirm** |
| other | 8 / 30d | conservative default |
| global fallback | 8 (all-time, any network) | conservative default |

### 1.2 What is structurally true about network retry rules (directionally confident)

- Both **Visa** and **Mastercard** run programs that limit reattempts on declined
  transactions and penalize *excessive* authorization/decline activity; both define
  decline responses that **prohibit retry outright**.
- **Mastercard uses Merchant Advice Codes (MAC)** — a code returned on a decline that
  instructs the merchant whether/when to retry (functionally: "do not try again",
  "no reason to retry", "retry after N days"). Retrying against a do-not-retry MAC
  risks fines.
- **Visa** defines reattempt rules and do-not-honor / do-not-retry response categories,
  and its integrity/monitoring programs flag excessive authorization attempts.
- Categorically, "dead credential" declines (lost/stolen/closed/invalid) are
  do-not-retry; insufficient-funds and transient issuer errors are retriable **within
  limits**. AX10M's hard-decline suppression aligns with this.

### 1.3 What I could NOT verify (flagged — do not rely on the numbers)

- **The exact current numeric caps** (attempts per window, window length, minimum
  interval) per **network × region × MCC**. The guardrail values are conservative
  **placeholders**. The Visa 15/30-day figure reflects a *commonly-cited* number for
  reattempts on the same transaction, but I have **not** verified it against the current
  rulebook and it may be stale or region-specific.
- I have deliberately **not** cited a specific rulebook section or number *as fact*,
  because a wrong number here creates real fine exposure. Every cap above is
  **"to be confirmed"** against, at minimum:
  - **Visa Core Rules and Visa Product and Service Rules** (current edition).
  - **Mastercard Transaction Processing Rules** + the **Merchant Advice Code /
    account-level-management** specifications.
  - **Your acquirer's** implementation guide (acquirers may apply stricter limits).

### 1.4 Recommended hardening (open items → `docs/BACKLOG.md`)

- **Honor the authoritative response/advice code, not just the inferred canonical
  family.** Today the guardrail infers retriability from the mapped canonical
  `DeclineCode`. The *authoritative* signal is the issuer response code + network advice
  code (Mastercard MAC, Visa reattempt category), which the adapter currently discards
  after mapping. Adapters should capture the **raw** advice/response code, and the
  guardrail should enforce an explicit "do not retry" / "retry after N days" when
  present, overriding inference. **This is a real gap.**
- Source the caps from a **maintained per-network/region/MCC table**, not one default.
- Confirm window/interval **semantics** (per-card vs per-transaction vs per-merchant)
  with the acquirer.

---

## 2. Third-party charge authority (Stripe Connect / platform terms)

### 2.1 The question

In drive mode AX10M initiates charge retries on a merchant's **own** Stripe account —
a third party moving money on the merchant's behalf. Whether, and under what terms,
this is permitted is a **legal + partnerships question, not a code question.**

### 2.2 What is documented / knowable

- Stripe supports third-party access via (a) **restricted API keys** the merchant
  issues, and (b) **Stripe Connect OAuth**, where a platform/app acts on connected
  accounts within granted scopes; **Stripe App Marketplace** apps undergo review and
  operate under the merchant's authorization + granted scopes.
- Re-attempting a failed charge on a stored PaymentMethod is *technically* an ordinary
  API operation (`/invoices/{id}/pay`, PaymentIntents). But whether an **overlay** third
  party may do so — and how it interacts with Stripe's own Smart Retries / dunning —
  is governed by the **Connect / platform / services agreements** and app review, not
  by the API surface alone.

### 2.3 The ambiguity (flagged — for counsel + Stripe)

Genuine open questions that require Stripe's partnerships team and legal counsel:

1. Under which model (restricted keys vs Connect OAuth vs App Marketplace) is a
   third-party overlay permitted to initiate retries, and under what scopes?
2. Does operating alongside/over Stripe Smart Retries violate any terms (e.g.,
   interfering with Stripe's dunning), or require coexistence disclosure?
3. Liability + chargeback / network-fine allocation when the overlay initiates the
   attempt.
4. Data-processing / PCI posture — AX10M is **SAQ-A, token-only, never a PAN** —
   confirmed acceptable under the DPA.

**This is not resolvable in code.** AX10M's design mitigates by: (a) never handling a
PAN (token/mandate only); (b) requiring the merchant's explicit authorization
(restricted keys / OAuth scopes); and (c) providing an **advisory-mode fallback**
(measure + prompt, no third-party charge) for processors/terms where drive is not
permitted.

### 2.4 Recommendation

Before any procurement conversation or live drive on Stripe: obtain **written
confirmation from Stripe** on the permitted integration model + scopes, and a **legal
review** of the Connect/platform terms. Default to **advisory mode** wherever drive
authority is unconfirmed.

---

## Status summary

| Item | Status |
|---|---|
| Retry caps — enforcement mechanism | ✅ hard suppression, tested |
| Retry caps — the specific numbers | ⚠️ unverified placeholders, flagged (§1.3) |
| Response/advice-code (MAC) enforcement | ❌ gap — inferred from family, not the raw code (§1.4) |
| Third-party charge authority (Stripe) | ⚠️ genuinely ambiguous — escalated to counsel + Stripe, not resolved in code (§2) |
| Stripe adapter parity | ✅ implemented end-to-end (client, `Stripe-Signature`, `/invoices/{id}/pay`, reconciler, 9 tests) |
