# AX10M — SIG / CAIQ Security-Questionnaire Pre-Fill

A pre-filled reference for the standardized vendor security questionnaires (Shared Assessments **SIG
/ SIG-Lite**, CSA **CAIQ v4** / Cloud Controls Matrix). When a reviewer sends their actual
questionnaire, lift the answers below into it. Organized by CCM/CAIQ domain.

> **Honesty rules for whoever completes the real questionnaire.** Answer from *this* document, not
> from optimism. AX10M is design-partner stage: several governance/process controls are **not yet
> formalized** and are marked 🗓 Roadmap — answer those "No / In progress," never "Yes." Do **not**
> claim SOC 2 / ISO 27001 / PCI Level 1. Update 🔧 deployment-dependent rows to match the actual
> engagement's hosting.

**Answer legend:** ✅ Yes (built + verifiable in code/docs) · 🟡 Partial (operational; formalization
on roadmap) · 🔧 Deployment-dependent (set by the operator's environment; confirm per engagement) ·
🗓 Roadmap (not yet) · ⛔ No / N/A

---

## Vendor profile (SIG-Lite header)

| Field | Answer |
|---|---|
| Product | Zero-code overlay that recovers failed payments alongside the merchant's processor(s) |
| Data received | Failed-payment events + opaque processor tokens; dunning contact fields (email / E.164 phone). **No cardholder data.** |
| Cardholder data (PAN/CVV/track) | **None** — collected on the processor's side; AX10M holds tokens only → **PCI SAQ-A** |
| Sensitive personal data | Contact fields (email/phone) for the merchant's own customers; no SSN/health/financial-account numbers |
| Hosting model | Deployed in the operator's cloud environment (🔧 per engagement) |
| Multi-tenancy | Logical isolation per merchant (merchant-scoped data + separately-stored, encrypted credentials) |
| Certifications | SAQ-A by design; SOC 2 / ISO 27001 🗓 roadmap (not certified) |

---

## GRC — Governance, Risk & Compliance

| Question | | Notes & evidence |
|---|---|---|
| Formal information-security policy? | 🟡 | Security posture documented ([SECURITY-PROCUREMENT.md](SECURITY-PROCUREMENT.md), [COMPLIANCE.md](COMPLIANCE.md)); a formal ISMS/policy set is 🗓 roadmap. |
| SOC 2 / ISO 27001 / PCI attestation? | ⛔ | Not certified. SAQ-A by design (no CHD). Will complete this questionnaire + support a pen test; SOC 2 on roadmap. |
| Risk assessments performed? | 🟡 | Architecture-level risk controls built + tested; a formal periodic risk-assessment process is 🗓 roadmap. |
| Compliance with GDPR/CCPA? | 🟡 | DPA available; data-subject requests supported operationally; formal DSR tooling 🗓 roadmap. |
| Right-to-audit / independent verification? | ✅ | Billing is **client-verifiable**: Ed25519-signed statements + hash-chained ledger the customer recomputes and reconciles to their payout (`scripts/verify-statement.mjs`). Security review/pen test supported on request. |

## A&A — Audit & Assurance

| Question | | Notes & evidence |
|---|---|---|
| Independent audits (SOC 2 etc.)? | ⛔ | None on file yet (🗓 roadmap). |
| Tamper-evident audit trail? | ✅ | Append-only, **hash-chained** ledger of every recovery decision + outcome; any change breaks the chain (`verifyChain`). |
| Can customers audit their own data/billing? | ✅ | Yes — signed statement + ledger + public key handed over; verify in one command. |

## AIS — Application & Interface Security

| Question | | Notes & evidence |
|---|---|---|
| Secure SDLC? | 🟡 | TypeScript throughout; large automated unit + e2e test suite gates changes; secrets kept out of source. Formal secure-SDLC attestation + SAST cadence 🗓 roadmap. |
| Input validation / injection defense? | ✅ | Parameterized DB access (Drizzle); webhook signatures verified (e.g. Stripe/Adyen HMAC); canonical event normalization. |
| Cardholder data in the app? | ⛔ | None — tokens only (SAQ-A). Payload scans reject any PAN-like sequence before send/store. |
| API authentication? | 🔧 | Processor webhooks are signature-verified; administrative/API access controls are enforced at the operator's infrastructure layer (per engagement). Application-level RBAC 🗓 roadmap. |

## CEK — Cryptography, Encryption & Key Management

| Question | | Notes & evidence |
|---|---|---|
| Encryption at rest? | 🟡 | Processor credentials encrypted with **AES-256-GCM** (authenticated) at the app layer, never logged. Full-database/disk encryption is 🔧 the operator's DB provider. |
| Encryption in transit? | ✅ | TLS/HTTPS for all API + processor traffic. |
| Key management? | 🔧 | Encryption/signing keys are **externally supplied and never committed**; production is designed for **KMS/HSM**-managed keys. Confirmed per engagement. |
| Data integrity controls? | ✅ | Hash-chained ledger + Ed25519 signatures over statement hashes. |

## DSP — Data Security & Privacy Lifecycle

| Question | | Notes & evidence |
|---|---|---|
| Data classification / minimization? | ✅ | Strong minimization: no PAN; only tokens, event metadata, and contact fields needed for recovery. |
| Data retention & disposal? | 🟡 | Ledger is append-only (needed for tamper-evident billing); operational-data retention set per engagement; contact fields kept only for active recovery. Formal disposal tooling 🗓 roadmap. |
| Data-subject access/deletion (GDPR/CCPA)? | 🟡 | Supported operationally; ledger entries pseudonymized where deletion conflicts with billing integrity. |
| Data segregation between customers? | ✅ | Merchant-scoped data; per-merchant credentials stored + resolved separately, encrypted. Infra-level isolation 🔧 per deployment. |
| Secondary use / data sale? | ⛔ | No sale of data. Cross-merchant learning uses only **de-identified, merchant-agnostic model statistics** (issuer/decline/amount/tenure) — no raw records shared. |

## IAM — Identity & Access Management

| Question | | Notes & evidence |
|---|---|---|
| Least-privilege access? | ✅ | Processor connections use least-privilege **restricted keys** (shadow mode = read-only). |
| MFA / SSO for privileged access? | 🔧 | Enforced at the operator's infrastructure/identity layer (per engagement). Product-native SSO/RBAC 🗓 roadmap. |
| Access reviews / provisioning process? | 🗓 | Formal periodic access-review process is roadmap (early-stage team). |
| Credential storage? | ✅ | Encrypted at rest (AES-256-GCM); plaintext transient in memory only; never logged. |

## LOG — Logging & Monitoring

| Question | | Notes & evidence |
|---|---|---|
| Application/audit logging? | ✅ | Structured app logs; **secrets and PAN are never logged**; the ledger is the immutable business audit trail. |
| Centralized log management / SIEM / alerting? | 🔧🗓 | Log aggregation + security alerting are the operator's infra layer today; a built-in monitoring/alerting cadence (e.g. SRM-breach auto-pause) is 🗓 roadmap. |
| Time-synchronized, tamper-resistant logs? | ✅ | Ledger entries are hash-chained + ordered; integrity re-verified on load. |

## SEF — Security Incident Management

| Question | | Notes & evidence |
|---|---|---|
| Documented incident-response plan? | 🗓 | Formal IR plan is roadmap. Breach-notification commitments provided in the DPA. |
| Breach notification to customers? | 🟡 | Commitment via DPA; timelines confirmed per engagement. |
| Responsible-disclosure / security contact? | 🟡 | Security contact provided ([SECURITY-PROCUREMENT.md](SECURITY-PROCUREMENT.md)); published disclosure policy 🗓 roadmap. |

## BCR — Business Continuity & Resilience

| Question | | Notes & evidence |
|---|---|---|
| Crash-safe / durable operations? | ✅ | Durable recovery saga (Temporal) + restart-safe persistence (hash-chained ledger, model store, counters, dunning-send dedupe); integrity re-verified on load. |
| Idempotency / no duplicate side effects? | ✅ | Stable idempotency keys on charges + comms; processor de-dupes → exactly-once over at-least-once transports. |
| Backups + tested DR (RTO/RPO)? | 🔧🗓 | Backups are the operator's DB provider; formal DR test + RTO/RPO targets 🗓 roadmap / per engagement. |

## CCC — Change Control & Configuration

| Question | | Notes & evidence |
|---|---|---|
| Version control + change tracking? | ✅ | All changes in git; automated test suite gates them. |
| Separation of duties / change approval? | 🟡🗓 | Small team; formal change-approval workflow 🗓 roadmap. |
| Safe-by-default configuration? | ✅ | All money-movement is **default-off** (`AX10M_LIVE_CHARGING` / `_COMMS` / `_BILLING`); enabling requires explicit intent on a credentialed host. |

## TVM — Threat & Vulnerability Management

| Question | | Notes & evidence |
|---|---|---|
| Vulnerability scanning / dependency management? | 🟡🗓 | Dependencies pinned; a scheduled SCA/vuln-scan cadence is 🗓 roadmap. |
| Penetration testing? | 🗓 | None on file yet; **supported on request** for a design-partner engagement; will remediate findings. |
| Patch management? | 🔧 | Runtime/OS patching at the operator's infra layer. |

## HRS — Human Resources Security

| Question | | Notes & evidence |
|---|---|---|
| Background checks? | 🗓 | Formal program is roadmap (early-stage team); confirm current status per engagement. |
| Security-awareness training? | 🗓 | Formal training program is roadmap. |
| Confidentiality agreements? | 🟡 | In place with personnel; formalized under the engagement/DPA. |

## STA — Supply Chain & Sub-Processors

| Question | | Notes & evidence |
|---|---|---|
| Sub-processors documented + disclosed? | ✅ | Yes — processor adapters (merchant's own accounts), Postmark/Twilio (only if live comms), Anthropic (only if an LLM key is set), hosting/DB. See [SECURITY-PROCUREMENT.md §7](SECURITY-PROCUREMENT.md); current list ships with the DPA. |
| Fourth-party / AI transparency? | ✅ | LLM use is **optional and fenced to comms/analytics — never the charge decision**; output validated (no PAN, must carry opt-out) with deterministic fallback; off unless a key is configured. |

## IVS / DCS — Infrastructure & Datacenter

| Question | | Notes & evidence |
|---|---|---|
| Hosting / datacenter security? | 🔧 | Inherited from the operator's cloud provider (SOC 2 / ISO datacenters); confirmed per engagement. |
| Network segmentation / firewalling? | 🔧 | Operator's infra layer. |
| Data residency / region? | 🔧 | Configurable; confirmed per engagement. |

## IPY — Interoperability & Portability

| Question | | Notes & evidence |
|---|---|---|
| Data export / portability? | ✅ | Ledger, statements (JSON/CSV), and reconciliation exports are open, documented formats the customer already receives. |
| Vendor lock-in? | 🟡 | Overlay model — the merchant keeps their processor + baseline recovery; disconnecting AX10M reverts to their existing setup. |

---

## Attachments we can provide with the completed questionnaire

- This pre-fill + [SECURITY-PROCUREMENT.md](SECURITY-PROCUREMENT.md) and [ARCHITECTURE.md](ARCHITECTURE.md)
- A **sample signed Uplift Statement + the one-line verify command** (test the audit trail before any data moves)
- Signed **DPA** + current sub-processor list
- Support for a **penetration test / security review**

*See also: [Security & Procurement one-pager](SECURITY-PROCUREMENT.md) ·
[Certification-Window Runbook](CERTIFICATION-RUNBOOK.md) · [Compliance notes](COMPLIANCE.md).*
