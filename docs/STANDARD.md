# VIS — The Verified Incrementality Standard (v0.1, DRAFT)

> **Status: DRAFT for review.** This is a *proposal* for a vendor-neutral standard, not
> a ratified specification and not an industry standard yet — that requires adoption and
> open governance neither of which exists today. Per the AX10M build plan, this document
> is the **spec only**; no reference code is written against it until the spec is
> reviewed. A conformant reference implementation already exists as a side effect
> (`@ax10m/attribution`), but the standard below is written to be implementable by any
> vendor, in any language, using any statistically valid method that meets the
> requirements.

## 1. Abstract

VIS defines what it means to **prove**, rather than assert, that a performance-priced
service produced *incremental* value — and to bill only for the proven part. It
specifies (a) a small set of methodological requirements for honest incrementality
measurement, (b) a signed, reconcilable **Statement** format, and (c) a **verification
procedure** an independent party (e.g. the payer's CFO or an auditor) can run to confirm
the billed number is exactly what the evidence supports, without trusting the vendor.

The problem it solves: "pay for performance / pay for uplift" pricing is only as
trustworthy as the baseline it measures against. A vendor that computes its own baseline
with no live control can report almost any number. VIS makes the number **falsifiable and
reproducible**.

## 2. Scope and non-goals

**In scope.** Any service billed on *incremental* outcomes measured against a live
control: failed-payment recovery / dunning, incrementality-priced advertising, retention
/ churn interventions, lift-based marketing, etc.

**Non-goals.** VIS does not prescribe *how* a vendor produces lift (the intervention), nor
which estimator it uses beyond the validity requirements in §4. It does not define pricing
(the fee *rate* is a commercial term); it defines how the fee *base* is proven. It is not
a privacy or PCI framework, though §9–§10 state the constraints it inherits.

## 3. Terminology

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be
interpreted as in RFC 2119.

- **Payer** — the party billed (the merchant/advertiser).
- **Vendor** — the party issuing Statements and collecting the fee.
- **Verifier** — any party checking a Statement (payer, auditor, the vendor itself).
- **Unit** — the entity an outcome is observed on (an invoice, an impression, a customer).
- **Randomization unit** — the entity assigned to control/treatment (often the customer);
  MAY differ from the outcome unit (→ clustering, §4.4).
- **Epoch** — a measurement period with fixed, pre-registered parameters.
- **Statement** — the signed artifact defined in §5.

## 4. Methodological requirements (the core)

A billed figure is **VIS-conformant** only if all of the following hold.

**4.1 Live randomized control (MUST).** Incrementality MUST be measured against a
**concurrent, randomized control group** (a holdout that does *not* receive the
intervention), not against a modeled, historical, or synthetic baseline. The control
fraction MUST be disclosed (§5). Randomized-encouragement or intent-to-treat designs are
permitted provided the analysis is by assignment, not by treatment received.

**4.2 Reproducible assignment (MUST).** Arm assignment MUST be a deterministic function of
a disclosed key (salt) and stable unit identifiers, so that a Verifier can **recompute
every unit's arm** after the epoch. The salt MUST be revealed only *after* the epoch
closes (pre-revelation would let the vendor select units).

**4.3 Anytime-valid inference (MUST).** Because a Statement is read repeatedly (a
dashboard, monthly billing), the interval on the effect MUST be an **always-valid
confidence sequence** (e.g. an mSPRT / mixture confidence sequence, or another anytime-
valid procedure) whose (1−α) coverage holds under continuous monitoring. Fixed-horizon
confidence intervals are **NON-CONFORMANT** for continuous or repeated billing, because
optional stopping inflates their error rate.

**4.4 Cluster-correct variance (MUST).** When the randomization unit differs from the
outcome unit, the variance of the effect MUST account for within-cluster correlation
(cluster-robust / cluster-sum variance). Treating correlated outcomes as independent
understates uncertainty and over-bills.

**4.5 Bill the lower bound (MUST).** The billable quantity MUST be the **lower bound** of
the (1−α) interval on incremental value, floored at zero. A period whose lower bound is
not positive bills **zero**. Variance-reduction techniques (e.g. CUPED) MAY be used to
tighten the interval provided they are unbiased (they MUST NOT be able to manufacture
lift; a covariate with no signal MUST reduce to the raw estimator).

**4.6 Randomization-integrity check (MUST).** The Statement MUST report a sample-ratio-
mismatch (SRM) test (or equivalent) at the randomization grain. An SRM breach (assignment
materially off the declared fraction) **voids billing** for the period, because it
indicates broken randomization.

**4.7 Reproducibility (MUST).** Given the disclosed epoch parameters (§5.3) and the ledger
(§6), an independent party MUST be able to **recompute the billed figure** and obtain the
same value (up to documented rounding).

**4.8 Under-claim, never over-claim (SHOULD).** Where a modeling choice is ambiguous, the
conformant choice is the one that reduces the billed figure. Billing errors SHOULD favor
the payer.

## 5. The Statement

A Statement is a JSON object. All monetary amounts MUST be integer **minor units** (e.g.
cents) plus an ISO-4217 currency, to avoid floating-point drift.

### 5.1 Required fields

| Field | Type | Requirement |
|---|---|---|
| `standard` | string | MUST be `"VIS/0.1"` |
| `payerId` | string | opaque payer identifier (no PII) |
| `period` | string | the epoch, e.g. `"2026-08"` |
| `currency` | string | ISO-4217 |
| `summary.control`, `summary.treatment` | ArmSummary | per-arm unit counts + realized value |
| `feeWorksheet` | object | every input to the fee (§5.2) |
| `epoch` | EpochDisclosure | §5.3 |
| `reconciliation` | Row[] | transaction-level rows a Verifier ties to the settlement source (§7.4) |
| `ledgerHead` | string | tamper-evident-log head the Statement is bound to (§6) |
| `ledgerVerified` | boolean | vendor's own chain check (the Verifier re-checks) |
| `statementHash` | string | SHA-256 over the canonical content, excluding the signature block |
| `signature` | string | detached signature over `statementHash` (§5.4) |
| `signingKeyId` | string | identifier for the public key |
| `generatedAt` | string | ISO-8601 |

### 5.2 Fee worksheet (MUST be hand-recomputable)

`feeWorksheet` MUST expose every quantity needed to recompute the fee by hand:
`{ feeRate, effectPerUnit, standardError, intervalHalfWidth, lowerBoundPerUnit,
treatedUnits, lowerBoundValueCumulative, priorBilled, billableIncrement, fee, billable,
gateReasons[] }`, with `fee = feeRate × billableIncrement` and
`lowerBoundValueCumulative = max(0, lowerBoundPerUnit) × treatedUnits`. `billable` MUST be
false (and `fee` = 0) whenever any §4 gate fails; `gateReasons` MUST list why.

### 5.3 Epoch disclosure

`epoch` MUST include `{ epochId, saltRevealed, controlFraction, windowDays, alpha,
methodParams }` — enough that a Verifier can recompute assignments (§4.2) and the interval
(§4.3). `saltRevealed` MUST be the actual salt, disclosed post-epoch.

### 5.4 Canonicalization, hashing, signing

- **Canonical form:** JSON with object keys sorted lexicographically at every level, no
  insignificant whitespace, integers for money. (This makes the hash order-independent.)
- **Hash:** `statementHash = SHA-256(canonical(statement \ {statementHash, signature,
  signingKeyId}))`.
- **Signature:** a detached signature over `statementHash`. Ed25519 is the **RECOMMENDED**
  default; implementations MAY use another asymmetric scheme identified by `signingKeyId`.
  Private keys SHOULD be held in a KMS/HSM. The public key MUST be published so anyone can
  verify without contacting the vendor.

## 6. Tamper-evident ledger

Every decision, assignment, and realized outcome that feeds a Statement MUST be recorded
in an **append-only, tamper-evident log**. A hash chain (each record carries the hash of
the prior record; altering any record breaks every subsequent link) is the RECOMMENDED
construction; a Merkle log or an external transparency log is also acceptable. The
Statement's `ledgerHead` MUST bind it to a specific log state. The log MUST survive a
process restart with its integrity check still passing.

## 7. Verification procedure

A Verifier confirms a Statement is conformant using only public inputs (the Statement, the
published public key, the ledger export, and the payer's own settlement/payout export). A
Statement is **VERIFIED** iff all steps pass:

1. **Hash** — recompute `statementHash` from the canonical content; MUST equal the field.
2. **Signature** — verify the detached signature over `statementHash` with the published
   public key.
3. **Ledger** — verify the log's integrity and that its head equals `ledgerHead`.
4. **Reconciliation** — sum the `reconciliation` rows' settled amounts and confirm they
   tie, penny-for-penny, to the payer's settlement/payout export filtered to the same
   transaction ids (§7.4).
5. **Fee** — recompute the lower-bound fee from `epoch.methodParams` + the arm data; MUST
   equal `feeWorksheet.fee` up to documented rounding.
6. **Assignment (spot-check)** — recompute a sample of unit arms from `saltRevealed`; MUST
   match the ledger.
7. **Integrity gate** — the reported SRM (§4.6) MUST NOT be breached.

### 7.4 Reconciliation rows

Each row MUST carry the settlement/transaction id, the settled amount (minor units), the
arm, and any reversal (refund/chargeback) within the window. Net-of-reversal value is what
counts toward realized value. Rows MUST contain **no PAN and no PII** — settlement/token
references only.

## 8. Conformance & certification

- **Level 1 — Self-certified.** The vendor publishes VIS Statements and an **open-source
  verifier**; any payer can run §7. This is the minimum bar and is meaningful because the
  math is reproducible and the ledger is tamper-evident.
- **Level 2 — Independently audited.** A third party audits the measurement pipeline
  (randomization, estimator, ledger) and reproduces a sample of Statements end-to-end.
- A vendor MUST NOT claim "VIS-conformant" for a Statement that fails §7, and MUST NOT
  describe a modeled/no-control baseline as VIS (§4.1 is the line).

## 9. Security considerations

- Salt revelation MUST be post-epoch (§4.2); early revelation enables unit selection.
- Signing keys SHOULD be KMS/HSM-backed; key rotation MUST preserve verifiability of prior
  Statements (publish historical public keys).
- The ledger prevents *silent* backdating/editing; it does not prevent a vendor from
  choosing not to record — Level 2 audit addresses that.

## 10. Privacy considerations

Statements and reconciliation rows MUST NOT contain a PAN or personal data — opaque payer,
unit, and settlement identifiers only. This keeps a published/downloadable Statement safe
to share and aligns with a token-only (PCI SAQ-A) posture on the vendor side.

## 11. Governance & neutrality

VIS is intended to be **vendor-neutral** and openly governed; no single vendor owns the
definition. The reference implementation of the measurement + Statement + verifier is
`@ax10m/attribution` (open-source-able), and **AX10M is the flagship user, not the owner**.
Other performance-priced vendors (dunning, incrementality ads, retention) are the intended
adopters. Versioning is semantic; `standard: "VIS/<major.minor>"` identifies the version a
Statement conforms to. Breaking changes bump the major.

## 12. Relationship to other artifacts

- **AXP-03** (`@ax10m/protocol`, `docs/AXP.md`) is a *transport* for an uplift event; a VIS
  Statement is the *payload* it can carry.
- `@ax10m/attribution` is the reference *implementation* of the §4 method (customer-
  clustered stratified holdout, mSPRT confidence sequence, CUPED, cluster-robust variance,
  hash-chained ledger, Ed25519-signed reconcilable statement) and `docs/ATTRIBUTION.md` is
  its math.

## 13. Honest status & open questions (for review)

- **Draft, unratified.** "Standard" here is an aspiration pending open governance and
  adoption; today it is one vendor's proposal + reference implementation.
- Orthogonality: VIS specifies how to *prove* incrementality honestly. It says nothing
  about whether a given vendor's intervention actually *works* — AX10M's own engine, per
  its Phase-1 backtest, does **not** yet beat the baseline. VIS is exactly the mechanism
  that would bill $0 in that case, which is the point.
- Open for review: (a) canonicalization edge cases (number formatting, unicode); (b) which
  anytime-valid procedures qualify under §4.3 and how `methodParams` encodes them; (c)
  whether Level-2 audit needs a defined attestation format; (d) a machine-readable JSON
  Schema for §5 (deferred until the spec is reviewed — no code yet, per the plan); (e)
  cross-vendor identity/registry for signing keys.

_No reference code is added in this phase; the JSON Schema and a standalone verifier are
the first code items once this spec is reviewed._
