# AX10M — Security & Procurement One-Pager

For the security, IT, and procurement teams reviewing AX10M during a design-partner engagement.
It states plainly **what is built into the product and verified in code**, what is **deployment-
dependent** (confirmed per engagement), and what is **on the roadmap** (not yet true). We will not
claim a certification we don't hold.

> **Maturity disclosure (read first).** AX10M is at design-partner stage. It is **not currently SOC 2
> or ISO 27001 certified**; formal third-party attestation is on the roadmap. The architecture is
> deliberately built to *minimize* the security surface (no card data, safe-by-default money
> movement, tamper-evident records). We will complete your security questionnaire, sign a DPA, and
> support a penetration test on request.

---

## Vendor snapshot

| | |
|---|---|
| **Product** | Zero-code overlay that recovers failed payments alongside the merchant's existing processor(s). |
| **Integration** | Read-only "shadow" connection to start; a least-privilege restricted processor key. No checkout changes. |
| **Cardholder data** | **None.** AX10M never receives, stores, or transmits a PAN. Opaque processor tokens only → **PCI SAQ-A** scope. |
| **Money movement** | Safe-by-default: OFF unless explicitly enabled per environment (see gates). Exactly-once; hard-constraint guardrail before any charge. |
| **Auditability** | Append-only, hash-chained ledger; **Ed25519-signed** monthly statements the customer can verify independently. |
| **AI/LLM use** | Optional, and fenced to **comms + analytics only — never the charge decision.** Off unless a key is configured. |
| **Certifications** | SAQ-A by design. SOC 2 / ISO 27001 on roadmap (not yet certified). |

---

## 1. Data handling & minimization

- **No PAN, ever.** Card collection happens on the processor's side (e.g. Stripe Elements via a
  SetupIntent); AX10M receives only an **opaque token** (`pm_…`, `cus_…`). This keeps AX10M in **PCI
  DSS SAQ-A** scope and keeps card data out of our systems entirely.
- **What we store:** merchant + connection metadata, encrypted processor credentials, the recovery
  event ledger, contact fields used for dunning (email / E.164 phone — never a PAN), and billing
  records. Contact fields are used only to recover the merchant's own customers' payments.
- **What we don't store:** card numbers, CVV, full magnetic/track data, or any cardholder
  authentication data.

## 2. Encryption

- **At rest:** processor credentials are encrypted with **AES-256-GCM** (authenticated) before they
  touch the database; ciphertext is never logged and plaintext exists only transiently in memory
  while a webhook is handled.
- **In transit:** all API and processor traffic is over TLS/HTTPS.
- **Key management:** the encryption key is **externally supplied and never committed** to source.
  Production is designed for **KMS/HSM-managed** keys (envelope encryption); the statement-signing
  key is likewise KMS/HSM-managed in production (the reference implementation uses an externally-
  supplied Ed25519 key). *Deployment-dependent — confirmed per engagement.*

## 3. Access control & credential isolation

- **Least privilege:** processor connections use a **restricted key** scoped to the minimum needed
  (see `docs/ARCHITECTURE.md §7`). Shadow mode needs only read access.
- **Per-merchant isolation:** each merchant's credentials are stored and resolved separately
  (per-connection), encrypted at rest, and never written to logs.
- **Secrets discipline:** secrets are kept out of source control; example config ships with
  placeholders only; a pre-push scan guards against leakage.

## 4. Integrity & independent auditability (a differentiator)

- **Tamper-evident ledger:** every recovery decision and outcome is appended to a **hash-chained,
  append-only** ledger. Any modification breaks the chain and is detected by `verifyChain`.
- **Signed, verifiable billing:** each monthly **Uplift Statement is Ed25519-signed** over a hash
  that covers the ledger range. The customer receives the statement, the transaction CSV, the
  hash-chained ledger, and the public key, and can **recompute the bill by hand and reconcile it
  penny-for-penny** to their processor payout report:
  ```
  node scripts/verify-statement.mjs uplift-statement.json <pubkey>.pem uplift-ledger.json
  ```
  This means the customer never has to *trust* our billing — they can *verify* it.

## 5. Safe money movement

- **Safe-by-default gates** (all default **OFF**; enabled only on a credentialed host with explicit
  intent):
  - `AX10M_LIVE_CHARGING` — off → the engine plans and measures but **moves no money** (shadow).
  - `AX10M_LIVE_COMMS` — off → dunning is **dry-run** (composed, not sent).
  - `AX10M_LIVE_BILLING` — off → fee statements are recorded but **not collected**.
- **Hard-constraint guardrail** runs *before* any charge and cannot be bypassed: card-network retry
  caps, minimum inter-attempt spacing, quiet hours, consent, and global opt-out. The cost/compliance
  objective additionally prices in near-cap fine risk and backs off early.
- **Exactly-once charging:** attempts carry a stable idempotency key so a retried/replayed operation
  never double-charges (the processor de-dupes server-side).
- **No destructive operations** on customer data as part of normal operation; the ledger is
  append-only by design.

## 6. AI / LLM governance

- LLMs are used **only** for optional dunning-copy personalization and analytics — **never in the
  charge-decision path**, which is deterministic and fully explainable.
- LLM output is **validated** before use (must contain the card-update link + an opt-out, must
  contain no PAN-like sequence, length-bounded) and **falls back to a deterministic template** on
  anything off.
- LLM personalization is **off unless an API key is configured**; the default path uses no third-
  party AI service and no network. The provider (Anthropic) is a sub-processor only when enabled.

## 7. Sub-processors

| Sub-processor | Purpose | When |
|---|---|---|
| Merchant's payment processor(s) (Stripe, Adyen, Braintree, PayPal, Checkout.com, GoCardless, …) | Payment recovery + tokenized methods | Always (the merchant's own accounts) |
| Postmark / Twilio | Dunning email / SMS delivery | Only if the merchant enables live comms |
| Anthropic | Optional dunning-copy personalization | Only if an API key is configured |
| Hosting / database provider | Application + encrypted persistence | Per deployment (operator-chosen) |

The concrete hosting, database, and region are **deployment-dependent** and confirmed per
engagement; a current sub-processor list is provided with the DPA.

## 8. Data residency, retention & data-subject rights

- **Residency:** AX10M runs in the operator's chosen environment; region is configurable. *Confirmed
  per engagement.*
- **Retention:** the ledger is append-only (required for tamper-evident billing); operational data
  retention windows are set per engagement. Contact fields are retained only as needed for active
  recovery.
- **GDPR / CCPA:** we support data-subject access/deletion requests for personal data (contact
  fields); ledger entries can be pseudonymized where deletion conflicts with billing integrity. A
  **DPA is available**. *Formal DSR tooling is a roadmap item — handled operationally today.*

## 9. Reliability & continuity

- **Durable recovery saga** (Temporal) makes multi-step recovery crash-safe and re-runnable without
  double-charging.
- **Restart-safe persistence:** the hash-chained ledger, model store, per-credential counters, and
  dunning-send idempotency all survive restarts and are shared across processes; integrity is
  re-verified on load.
- **Idempotency** throughout the charge and comms paths prevents duplicate side effects under
  at-least-once transports.

## 10. Secure development & vulnerability management

- TypeScript throughout; a large automated test suite (unit + end-to-end) gates changes.
- Secrets kept out of source; least-privilege credentials; encrypted at rest; no PAN in scope.
- *Roadmap:* formal SDLC attestations, scheduled dependency/vuln scanning cadence, and a published
  responsible-disclosure policy. We welcome a **penetration test** and will remediate findings.

## 11. Compliance posture — stated honestly

| Item | Status |
|---|---|
| **PCI DSS** | **SAQ-A** by design (no cardholder data in scope). Not a card processor; not PCI Level 1. |
| **SOC 2 / ISO 27001** | **Not yet certified.** On the roadmap. We'll complete your security questionnaire in the interim. |
| **GDPR / CCPA** | DPA available; data-subject requests supported operationally; formal tooling on roadmap. |
| **Penetration test** | None on file yet; **supported on request** for a design-partner engagement. |
| **Card-network retry rules** | Enforced in code + tests; specific numeric caps are placeholders pending region/MCC confirmation (`docs/COMPLIANCE.md §1`). |
| **Third-party charge authority** | Operates under the merchant's authorization on their processor; platform-terms edge cases flagged for counsel/processor (`docs/COMPLIANCE.md §2`). |

## 12. What we can provide on request

- Completed security questionnaire (SIG / CAIQ / your template)
- Architecture overview (`docs/ARCHITECTURE.md`) and compliance notes (`docs/COMPLIANCE.md`)
- A **sample signed Uplift Statement + the one-line verify command** (so your team can test the
  audit trail before any data moves)
- A signed **DPA** and current sub-processor list
- Support for a penetration test / security review

---

**Contact:** [SECURITY CONTACT — name / email]. Please send security questionnaires and DPAs here;
we typically turn them around within [N] business days.

See also: [Certification-Window Runbook](CERTIFICATION-RUNBOOK.md) ·
[Design-Partner Outreach](DESIGN-PARTNER-OUTREACH.md) · [Architecture](ARCHITECTURE.md) ·
[Compliance notes](COMPLIANCE.md).
