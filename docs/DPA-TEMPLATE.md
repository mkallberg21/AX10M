# AX10M Data Processing Addendum (DPA) — **DRAFT TEMPLATE**

> ⚠️ **DRAFT / STARTING POINT — NOT LEGAL ADVICE. REVIEW BY QUALIFIED COUNSEL REQUIRED BEFORE USE.**
>
> This is a working template so a design-partner engagement has a real DPA to negotiate from. It is
> **not** a substitute for legal review. Counsel must confirm the applicable data-protection laws
> and roles, the correct international-transfer mechanism (e.g. EU SCCs / UK IDTA / DPF), the CCPA/
> state-privacy language, breach-notice timing, liability and governing law, and every
> `[BRACKETED PLACEHOLDER]`. Where this DPA and the [Recovery Services Agreement](../packages/billing/TERMS.md)
> conflict on data protection, this DPA should be drafted to control (confirm with counsel).

This Data Processing Addendum ("**DPA**") forms part of the AX10M Recovery Services Agreement (the
"**Agreement**") between **[AX10M LEGAL ENTITY]** ("**AX10M**", "**Processor**") and the customer
identified in the Agreement ("**Merchant**", "**Controller**"), each a "party".

---

## 1. Definitions

Capitalized terms not defined here have the meaning in the Agreement.

- **Applicable Data Protection Law** — all laws/regulations applicable to the Processing of Personal
  Data under this DPA, including, as applicable, the EU GDPR, the UK GDPR, and U.S. state privacy
  laws including the CCPA/CPRA. *[Confirm the full list per engagement.]*
- **Controller**, **Processor**, **Personal Data**, **Processing**, **Data Subject**, **Personal
  Data Breach**, **Sub-processor** — as defined in Applicable Data Protection Law.
- **Merchant Personal Data** — Personal Data that AX10M Processes on Merchant's behalf under the
  Agreement, as described in **Annex I**.

## 2. Roles and scope

2.1 The parties acknowledge that, for Merchant Personal Data, **Merchant is the Controller** (or a
processor acting on behalf of its own controller) and **AX10M is the Processor**.

2.2 AX10M shall Process Merchant Personal Data only (a) to provide the failed-payment recovery,
measurement, and billing services under the Agreement, and (b) on Merchant's **documented
instructions** (the Agreement, this DPA, and Merchant's configuration/use of the service constitute
those instructions), unless required by law (in which case AX10M will notify Merchant unless
legally prohibited).

2.3 The subject matter, duration, nature and purpose of Processing, categories of Data Subjects, and
categories of Personal Data are set out in **Annex I**. AX10M does **not** receive or Process
cardholder primary account numbers (PAN); payment methods are handled as opaque processor tokens.

## 3. Processor obligations

AX10M shall:

3.1 Process Merchant Personal Data only per Section 2 and promptly inform Merchant if, in AX10M's
opinion, an instruction infringes Applicable Data Protection Law.

3.2 Ensure persons authorized to Process Merchant Personal Data are under an appropriate **duty of
confidentiality**.

3.3 Implement and maintain the **technical and organizational measures** in **Annex II**, taking
account of the state of the art, costs, and the nature/scope/context/risk of Processing.

3.4 **Assist Merchant** by appropriate measures, insofar as possible, with (a) responding to Data
Subject rights requests (Section 5), (b) security of Processing, Personal Data Breach notification,
and data protection impact assessments and prior consultations, taking into account the information
available to AX10M.

3.5 At Merchant's choice, **delete or return** Merchant Personal Data on termination per Section 8.

3.6 Make available to Merchant information necessary to demonstrate compliance with this DPA and
allow for and contribute to audits per Section 7.

## 4. Sub-processors

4.1 Merchant provides **general authorization** for AX10M to engage the Sub-processors listed in
**Annex III** to Process Merchant Personal Data.

4.2 AX10M shall (a) impose data-protection obligations on each Sub-processor that are **no less
protective** than those in this DPA, and (b) remain **liable** for each Sub-processor's performance.

4.3 AX10M shall give Merchant **[30] days'** prior notice of any intended addition or replacement of
a Sub-processor. Merchant may **object** on reasonable data-protection grounds within **[14] days**;
the parties will work in good faith to resolve, and if unresolved Merchant may terminate the
affected service. *[Confirm notice/objection mechanics with counsel.]*

## 5. Data Subject rights

Taking into account the nature of the Processing, AX10M shall assist Merchant by appropriate
technical and organizational measures, insofar as possible, to fulfill Merchant's obligation to
respond to Data Subject requests (access, rectification, erasure, restriction, portability,
objection). If AX10M receives such a request directly, it will not respond except on Merchant's
documented instructions, and will promptly forward it to Merchant.

## 6. Personal Data Breach

6.1 AX10M shall notify Merchant **without undue delay** (and in any event within **[72 hours]** of
becoming aware) of a Personal Data Breach affecting Merchant Personal Data.

6.2 The notification shall, to the extent known, describe the nature of the breach, the categories
and approximate number of Data Subjects and records concerned, likely consequences, and the measures
taken or proposed. AX10M will provide reasonable cooperation to Merchant's breach-response.

*[Timing/content to be confirmed against Applicable Data Protection Law and the Agreement.]*

## 7. Audit

7.1 AX10M shall make available information reasonably necessary to demonstrate compliance with this
DPA, which may include completed security questionnaires (e.g. SIG/CAIQ), security documentation,
and — where available — third-party audit reports.

7.2 Merchant may conduct an audit **no more than [once per 12 months]** (and following a Personal
Data Breach), on **[30] days'** notice, during business hours, subject to confidentiality and without
unreasonable disruption, or by an independent auditor bound by confidentiality. *[Confirm scope/
frequency/cost allocation with counsel.]*

7.3 In addition, AX10M's billing is **independently verifiable** by Merchant: each Uplift Statement
is cryptographically signed and reconcilable to Merchant's own processor records, providing a
continuous integrity check on the data underlying the service.

## 8. Deletion and return

8.1 On termination or expiry, AX10M shall, at Merchant's choice, **delete or return** all Merchant
Personal Data and delete existing copies, unless retention is required by law.

8.2 **Ledger-integrity carve-out.** Certain records are stored in an append-only, hash-chained
ledger that underpins tamper-evident billing and cannot be selectively erased without destroying its
integrity. For such records, AX10M will **pseudonymize / redact the Personal Data** to the extent
technically feasible while preserving the ledger's integrity, and will retain only what is necessary
for billing, audit, and legal-compliance purposes for **[retention period]**, after which it is
deleted. *[Confirm this carve-out is acceptable to counsel and disclosed to Merchant.]*

## 9. International transfers

Where Processing involves a transfer of Merchant Personal Data to a country without an adequacy
decision, the parties shall put in place an appropriate transfer mechanism (e.g. **EU Standard
Contractual Clauses**, the **UK IDTA/Addendum**, and/or reliance on the **EU-U.S. Data Privacy
Framework** where applicable), which shall be incorporated by reference and completed at **Annex
[IV]**. *[Counsel to select and complete the correct mechanism per the parties' locations.]*

## 10. CCPA / U.S. state privacy

To the extent AX10M Processes Personal Data subject to the CCPA/CPRA, AX10M acts as a **service
provider** (or contractor) and shall: (a) Process such data only for the **business purposes** in the
Agreement/Annex I; (b) **not sell or share** such data and not retain, use, or disclose it outside
the direct business relationship or for any purpose other than the services; and (c) comply with
applicable service-provider obligations. AX10M certifies it understands and will comply with these
restrictions. *[Counsel to finalize CCPA/state-specific language.]*

## 11. General

11.1 **Liability** under this DPA is subject to the limitations and exclusions in the Agreement.
*[Confirm interaction with data-protection statutory liability.]*

11.2 **Order of precedence:** in the event of conflict on data-protection matters, this DPA controls
over the body of the Agreement. *[Confirm with counsel.]*

11.3 **Term:** this DPA takes effect on the Agreement's effective date and continues while AX10M
Processes Merchant Personal Data.

11.4 **Governing law / jurisdiction:** **[as per the Agreement / to be specified].**

---

## Annex I — Details of Processing

| | |
|---|---|
| **Controller** | Merchant (as identified in the Agreement) |
| **Processor** | AX10M **[legal entity]** |
| **Subject matter** | Provision of failed-payment recovery, incremental-uplift measurement, and billing services |
| **Duration** | For the term of the Agreement + the deletion/retention period in Section 8 |
| **Nature & purpose** | Ingesting failed-payment events; deciding/executing compliant recovery attempts; measuring incremental recovery via a randomized holdout; composing/sending dunning communications (if enabled); computing and collecting the fee |
| **Categories of Data Subjects** | Merchant's end customers whose payments failed (and, for account/contract data, Merchant's own personnel who administer the account) |
| **Categories of Personal Data** | Opaque payment-method + customer tokens (`pm_`/`cus_`); invoice/transaction identifiers and amounts; decline codes; issuer region / BIN-derived attributes; customer tenure; dunning **contact fields** (email address, E.164 phone number); merchant account + billing/AP contact details |
| **Special-category data** | **None** intended or required |
| **Cardholder data (PAN/CVV/track)** | **None** — handled by the processor; AX10M holds tokens only (PCI **SAQ-A**) |
| **Frequency** | Continuous / event-driven (per failed-payment webhook) |

## Annex II — Technical & Organizational Measures (TOMs)

Stated honestly; ✅ built/verifiable · 🟡 partial (formalization on roadmap) · 🔧 deployment-dependent.
See [SECURITY-PROCUREMENT.md](SECURITY-PROCUREMENT.md) and [SIG-CAIQ-PREFILL.md](SIG-CAIQ-PREFILL.md)
for the fuller mapping and evidence pointers.

- **Data minimization / no cardholder data** ✅ — opaque tokens only; PAN-like sequences rejected before storage/send (PCI SAQ-A).
- **Encryption in transit** ✅ — TLS/HTTPS for all API and processor traffic.
- **Encryption at rest** 🟡🔧 — processor credentials encrypted with **AES-256-GCM** at the application layer (never logged); full-database encryption at rest is the operator's DB provider (per engagement).
- **Key management** 🔧 — encryption/signing keys externally supplied and never committed; production designed for **KMS/HSM**-managed keys.
- **Access control / least privilege** ✅🔧 — least-privilege restricted processor keys; per-merchant credential isolation; administrative access controlled at the operator's identity layer (MFA/SSO per engagement); product-native RBAC on roadmap.
- **Integrity & auditability** ✅ — append-only, hash-chained ledger + Ed25519-signed, independently-verifiable statements.
- **Pseudonymization** 🟡 — supported for the deletion carve-out (Section 8.2).
- **Safe-by-default processing** ✅ — money-movement and outbound comms are default-OFF (`AX10M_LIVE_CHARGING`/`_COMMS`/`_BILLING`); a hard-constraint guardrail (network caps, quiet hours, consent, opt-out) runs before any action; exactly-once execution.
- **Resilience & recoverability** ✅🔧 — durable saga + restart-safe persistence with integrity re-verification; backups + tested DR (RTO/RPO) per the operator's environment.
- **Logging** ✅ — application/audit logging that never records secrets or PAN; centralized SIEM/alerting per engagement.
- **Sub-processor management** ✅ — flow-down obligations; documented list (Annex III).
- **AI/LLM governance** ✅ — LLM use is optional and confined to comms/analytics, never the payment-decision path; output validated (no PAN; must carry opt-out) with deterministic fallback.
- **Roadmap (not yet, disclosed honestly)** 🗓 — formal ISMS/policies, incident-response plan, penetration test, scheduled vulnerability scanning, HR security program, SOC 2 attestation.

## Annex III — Authorized Sub-processors

| Sub-processor | Purpose | Location | When engaged |
|---|---|---|---|
| Merchant's payment processor(s) (Stripe, Adyen, Braintree, PayPal, Checkout.com, GoCardless, …) | Payment recovery + tokenized methods | **[per provider]** | Always (Merchant's own accounts) |
| Postmark | Dunning email delivery | **[region]** | Only if Merchant enables live email comms |
| Twilio | Dunning SMS delivery | **[region]** | Only if Merchant enables live SMS comms |
| Anthropic | Optional dunning-copy personalization | **[region]** | Only if an LLM API key is configured |
| **[Hosting / database provider]** | Application hosting + encrypted persistence | **[region]** | Always (operator-chosen) |

*A current, dated sub-processor list is maintained and provided on request; changes are notified per
Section 4.3.*

## Annex IV — International transfer mechanism

*[To be completed by counsel: SCCs module + selections, UK IDTA/Addendum, and/or DPF reliance, with
the relevant appendices.]*

---

*Companion documents: [Recovery Services Agreement (terms)](../packages/billing/TERMS.md) ·
[Security & Procurement](SECURITY-PROCUREMENT.md) · [SIG/CAIQ pre-fill](SIG-CAIQ-PREFILL.md) ·
[Compliance notes](COMPLIANCE.md).*
