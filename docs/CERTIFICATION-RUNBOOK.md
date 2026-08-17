# AX10M Certification-Window Runbook

The operational playbook for running a design partner's **certification window** — the ~90-day live
holdout that turns AX10M's honest-but-modeled recovery claim into a **signed, reconcilable Uplift
Statement** on the merchant's own traffic. This is the artifact that closes the #1 gap (proven live
lift); everything else in the platform exists to make it credible and safe.

> **Honesty contract.** We do not tell a merchant a number until their own randomized holdout
> proves it. During certification the merchant pays for proven lift only (and, net of the holdout
> credit, ≈ $0 while proving) — see [Billing during certification](#7-billing-during--after-certification).
> Never present modeled/backtest figures as measured results.

---

## 0. Overview — what the window proves, and how

AX10M runs a **randomized holdout**: a control group gets the merchant's existing recovery
(baseline / processor Smart Retries) with **no AX10M treatment**; the treatment group gets the
AX10M engine. The difference in net recovered value, measured with an always-valid sequential test
(mSPRT) and reported as a **lower bound**, is the incremental lift AX10M caused. The merchant is
billed 12% of that proven lower bound — and can verify the whole thing against their processor's
payout file.

```
Phase 0  Scope + qualify        → ICP quote, agreement, opt-in            (days -14 … 0)
Phase 1  Connect + Shadow       → measure the baseline, MOVE NO MONEY     (days 0 … ~14)
Phase 2  Certification holdout  → 10% control, live treatment, learn      (~90 days)
Phase 3  Certify                → signed Uplift Statement + reconcile     (at proof / window close)
Phase 4  Taper + steady state   → 2% audit holdout, ongoing billing       (ongoing)
```

---

## 1. Prerequisites & the ICP gate

Run the **ICP + time-to-proven-lift quote** before committing to a window. A merchant below the
volume floor may never clear the mSPRT boundary under pay-only-on-proof, which wastes everyone's time.

```bash
curl "http://<api>/billing/icp-quote?monthlyFailedPayments=8000&avgInvoiceAmountMinor=5000&baselineRecoveryRate=0.3&upliftRatePoints=0.02"
```

Proceed when the quote returns `clearsIcpFloor: true` with `estimatedDaysToProvenLift` inside the
certification window. Also confirm:

- **Volume**: roughly **≥ 3–5k failed payments/month** (the quote is the real gate; this is the rule of thumb).
- **Processor**: on a supported adapter (Stripe, Adyen, Braintree, PayPal, Checkout.com, GoCardless, …).
  Where AX10M can only observe (not drive), we run in advisory/co-drive mode — flag it up front.
- **Legal/security**: the merchant can accept the [terms](../packages/billing/TERMS.md) (counsel-reviewed
  before first real use) and clear any security review. AX10M holds **no card numbers** (SAQ-A;
  opaque processor tokens only).

---

## 2. Roles

| Role | Who | Owns |
|---|---|---|
| **AX10M operator** | us | flags, holdout config, statement signing, reconciliation, this runbook |
| **Merchant champion** | payments / RevOps / growth | processor connection, go/no-go on activation |
| **Merchant finance** | finance / AP | verifies the signed statement, approves the (holdout-credited) invoice |
| **Merchant IT/security** | eng / security | connection scopes, security review |

---

## 3. Phase 0 — Scope, qualify, agree

1. Run the **ICP quote** (§1). Share the honest output (it's labeled a planning *estimate*).
2. Merchant opts in via the portal: `POST /billing/opt-in` (or the `/opt-in` page). Captures the
   legal entity, AP contact, PO policy, payer track, and an **Ed25519-signed clickwrap acceptance**
   of the terms.
   - **Auto-pay** (default): `POST /billing/setup-intent` → Stripe Elements collects a card (the PAN
     never touches AX10M) → the returned `cus_`/`pm_` go on the account.
   - **Invoice/net-14** (enterprise fallback): no card on file; invoices go to the AP contact.
3. Agree the **certification terms**: full-holdout certification (default 90 days @ 10% control),
   tapering to a ≤2% permanent audit holdout, with the **holdout cost credited against the fee** so
   the effective rate stays ~12% even during proof.

---

## 4. Phase 1 — Connect + Shadow mode (move no money)

Shadow mode is the trust builder: AX10M assigns holdout buckets and records everything to the
tamper-evident ledger to project the opportunity, **but executes no charges**.

**Safety gates — all default-OFF; keep them OFF in Phase 1:**

| Flag | Default | Meaning |
|---|---|---|
| `AX10M_LIVE_CHARGING` | `false` | worker runs in SHADOW (plans + measures, moves no money) |
| `AX10M_LIVE_COMMS` | `false` | dunning is dry-run (composes, sends nothing) |
| `AX10M_LIVE_BILLING` | `false` | statements recorded, no fee collected |

1. Connect the processor with a **least-privilege restricted key** (see `docs/ARCHITECTURE.md §7`);
   credentials are encrypted at rest, never logged.
2. Verify ingestion: failed-payment webhooks normalize into canonical events and land on the
   hash-chained ledger. Confirm `verifyChain` passes.
3. Watch the **shadow projection** on the dashboard: projected monthly opportunity + would-be fee,
   clearly labeled **not holdout-verified**. This calibrates expectations without any claim.
4. Confirm the **guardrail** is inviolable and region/MCC-accurate: network retry caps, quiet hours,
   consent, global opt-out. These enforce in shadow too (as suppressions).

Exit Phase 1 when the baseline is stable and the merchant's champion + security are comfortable.

---

## 5. Phase 2 — Activate the certification holdout (~90 days)

This is the live window. Turn on live charging for the **treatment** arm; the **control** arm stays
on the merchant's existing recovery untouched.

1. Set the holdout: `AX10M_HOLDOUT_CONTROL_FRACTION=0.10`, a stable `AX10M_HOLDOUT_SALT` (rotate per
   environment, keep stable within it so assignment is reproducible).
2. Enable live charging on a host with real processor credentials and explicit intent:
   `AX10M_LIVE_CHARGING=true`. (Optionally `AX10M_DURABLE_RECOVERY=true` + a Temporal cluster for the
   durable saga; optionally `AX10M_LIVE_COMMS=true` once dunning copy + consent are signed off.)
3. Optionally enable the **learned policy + cross-merchant flywheel**: `AX10M_BANDIT_POLICY=true`
   (LinUCB bandit, online learning, pooled across merchants). It starts grounded on the cost/
   compliance-aware objective, so day-one behavior is unchanged, and improves as real outcomes land.
4. Let it run. The engine's edge is **dead-credential recovery** (Account Updater + backup-rail +
   dunning) and **cost/compliance-aware selectivity** — recovery a blind "retry harder" baseline
   structurally can't reach, at fewer attempts and within network caps.

**Do not** change the holdout fraction, salt, or engine mid-window without recording it — it breaks
the measurement. Monitor the **SRM check** (sample-ratio mismatch): if it breaches, assignment is
skewed → pause and investigate before trusting any statement.

---

## 6. What's measured (the statistics)

- **mSPRT lower bound** — an always-valid sequential confidence bound on the per-invoice incremental
  net recovered value. We bill the **lower bound**, never the point estimate, so we systematically
  under-claim.
- **Net of reversals** — recovered value is net of refunds/chargebacks; a won chargeback re-accrues.
- **CUPED** — variance reduction so the lower bound clears sooner without inflating it.
- **SRM** — guards randomization integrity; a breach pauses billing.
- **Estimated holdout cost** — the recovery the merchant forwent on the control group, disclosed on
  every statement and credited against the fee.

$0 is a valid, honest outcome: if the holdout hasn't proven positive incremental recovery at
confidence, the merchant owes nothing and we say so plainly.

---

## 7. Billing during & after certification

Run the monthly billing job: `pnpm --filter @ax10m/api run bill` (records the signed statement;
collects only when `AX10M_LIVE_BILLING=true` and a charger is wired). Dunning sweep: `run dun`.

- **During certification (10% holdout):** the holdout credit ≈ the fee, so **net billed ≈ $0**. The
  merchant bears the holdout via forgone recovery and receives the signed proof — an honest,
  low-friction "prove it first" deal.
- **After taper (≤2% audit holdout):** the credit shrinks, so the merchant pays ~12% of proven lift,
  net-14, with a 1.5%/mo finance charge on overdue balances. Every invoice shows the gross fee, the
  **estimated holdout cost**, the **holdout credit**, and the net owed.
- Invoices are auto-delivered to the AP contact; `POST /billing/invoice/:n/forward-ap` composes a
  forward on demand.

---

## 8. Phase 3 — Certify (the deliverable)

The output is a **signed Uplift Statement** the merchant can verify without trusting us:

1. Generate the statement (Ed25519-signed over the statement hash, which covers the ledger range).
2. Hand the merchant: `uplift-statement.json` (signed), `uplift-statement.csv` (recovered
   transactions), `uplift-ledger.json` (the hash-chained ledger), and the public key.
3. They verify + reconcile — recompute by hand and tie the recovered transactions **penny-for-penny
   to their processor payout report**:
   ```bash
   node scripts/verify-statement.mjs uplift-statement.json ax10m-demo-pubkey.pem uplift-ledger.json
   # → PASS statement hash · PASS Ed25519 signature · PASS ledger chain
   ```

This reconcilable proof — on their logo, their data — is worth more than any methodology deck. It is
the asset that unlocks the next design partner (with permission) and the finance-audience motion.

---

## 9. Phase 4 — Taper + steady state

- Taper the holdout from 10% → **≤2% permanent audit holdout** (keeps the measurement honest at
  minimal forgone-recovery cost). The billing layer applies this via the onboarding date.
- Steady-state billing continues monthly; the audit holdout keeps producing a signed statement each
  period so the merchant never has to trust an unverifiable number.
- Feed the win back into the roadmap and (with explicit written permission) the case study.

---

## 10. Exit criteria & honest-null handling

**Certified** when: the mSPRT lower bound is positive, the SRM check passes, and the recovered
transactions reconcile to the processor payout. → taper + steady-state billing.

**Not certified** (lower bound hasn't cleared by window close): the merchant owes **$0**. Options,
stated honestly: extend the window (volume-dependent — re-run the ICP quote), investigate coverage
(are we reaching the dead-credential cohort?), or part ways. Never bill an unproven lift, and never
reframe a null as a win.

---

## 11. Operator checklist

- [ ] ICP quote clears the floor within the window
- [ ] Opt-in signed (clickwrap acceptance recorded); payer track set
- [ ] Processor connected (restricted key, encrypted at rest); `verifyChain` passes
- [ ] Phase 1 shadow: all `AX10M_LIVE_*` flags OFF; guardrail enforcing; baseline stable
- [ ] Holdout config set (`CONTROL_FRACTION=0.10`, stable `SALT`); SRM monitored
- [ ] Phase 2 live: `AX10M_LIVE_CHARGING=true` on a credentialed host; (optional bandit/durable/comms)
- [ ] Monthly `bill` (+ `dun`) running; holdout credit visible on statements
- [ ] Phase 3: signed statement delivered; merchant reconciles to payout ✓
- [ ] Phase 4: taper to ≤2%; steady-state billing; roadmap + (permissioned) case study

---

## 12. Risk & compliance notes

- **Processor ToS / third-party charge authority** — confirm the merchant authorizes AX10M's charge
  activity on their processor; where the processor also retries, de-conflict (advisory fallback is
  planned). See `docs/COMPLIANCE.md`.
- **Network retry caps** — enforced by the guardrail per network/region/MCC; the cost/compliance
  objective also prices in near-cap fine risk and backs off early. Keep the cap table current.
- **Holdout ethics** — the control group receives the merchant's *existing* recovery, not *nothing*;
  the forgone incremental recovery is disclosed and credited. Keep the window bounded and taper.
- **No PAN, ever** — SAQ-A; opaque tokens only; signed records carry no card data.

See also: [Design-Partner Outreach](DESIGN-PARTNER-OUTREACH.md) · [Strategy](STRATEGY.md) ·
[Attribution](ATTRIBUTION.md) · [Compliance](COMPLIANCE.md) · [Worker runbook](RUNBOOK-WORKER.md).
