# Lift — Uplift Attribution Engine

> Specification for the component that decides *what we are allowed to bill*.
> Companion to `ARCHITECTURE.md` §3 (the Uplift Attribution Engine). This document **deepens** that section; it does not contradict it. Where the architecture states a principle, this spec states the math, the schema, and the procedure.
> Document owner: founding eng. Status: attribution v0.1. Date: 2026-08-14.

---

## 0. Reading guide & first principles

Everything here serves one sentence:

> **Lift bills 12% of the lower confidence bound of the incremental recovery uplift measured by a live, stratified, randomized holdout, computed with an always-valid confidence sequence, and recorded in a signed, hash-chained ledger a CFO can reconcile line-by-line against the processor's own payout report.**

Five non-negotiable invariants follow from that sentence. They are the acceptance criteria for this engine:

1. **Under-claim by construction.** We bill a *lower bound*, never a point estimate. If the statistics are uncertain, the bill goes *down*, never up. A billing error should almost always favor the merchant.
2. **The counterfactual is measured, not modeled.** The baseline is a live control group running *simultaneously* under *identical* conditions — not a regression forecast of "what would have happened." Models (CUPED, recoverability) only *reduce variance around* the measured difference; they never *create* the difference.
3. **Determinism & reproducibility.** Given the ledger, anyone can recompute the exact bill. No floating random seeds, no un-versioned model outputs on the billing path, no "trust our dashboard."
4. **Tamper-evidence.** The record of who was in control vs. treatment is written *before* the outcome is known and is cryptographically chained so it cannot be back-dated or re-bucketed to inflate lift.
5. **No double-counting.** Recovered-invoice dollars and retained-subscription dollars are defined on disjoint accounting horizons and combined by a rule (§1.4) that provably cannot count the same dollar twice.

If a proposed feature violates any of these, it does not ship on the billing path. It may live in the (non-billing) analytics/dashboard layer with a clear label.

---

## 1. Goal & billing contract

### 1.1 What we are measuring

Let a **failed invoice** be an invoice that received at least one hard/soft decline and entered a recovery-eligible state. For each such unit we observe a binary recovery outcome and a set of dollar outcomes over a fixed **attribution window** `W` (default **21 days** from first decline; configurable per merchant, frozen per epoch — see §2.6).

We run two arms:

- **Control (baseline-only, `c`)** — the merchant's *pre-existing* recovery stack runs untouched: Stripe Smart Retries + the merchant's native dunning. Lift observes but does **not** act. This arm *is* the counterfactual.
- **Treatment (`t`)** — Lift's engine drives recovery (retry policy, comms, card-update, guardrail), *on top of / in place of* the native stack as configured.

The thing we bill on is the **incremental** difference between arms, in dollars, and only the portion the control group proves is real.

### 1.2 Two dollar quantities

Uplift has two economically distinct components. We define both precisely and keep them on **disjoint horizons** so they never overlap.

**(A) Incremental recovered invoice value** — the near-term, hard-dollar component.
For a failed invoice `i` with face value `v_i` (in merchant settlement currency, §9.4), define the *recovered-value* outcome:

```
R_i = v_i · 1[invoice i settled and NOT reversed within window W]
```

`R_i` is **net of clawbacks** observed within `W`: if a recovered charge is refunded, disputed, or charged back inside the window, `R_i` reverts to 0 (partial refund → proportional, §9.2). This is the current billing cycle's cash.

**(B) Incremental retained-subscription value** — the durable component.
A recovery can prevent *involuntary churn*: the subscription survives and bills again next cycle. This future value is real but must be counted conservatively and *without* re-counting the invoice already in (A).

Define, for a subscription behind invoice `i` with net monthly value `m_i` (MRR net of variable cost/refund reserve), a **retained-value** outcome measured on the **forward horizon only** — i.e., strictly *future* billing cycles, excluding the cycle whose invoice is in (A):

```
S_i = m_i · Ŝurv_i · A(H)
```

where:
- `Ŝurv_i` = estimated probability the subscription is still active at the *next* renewal *given the invoice was recovered* — but note this factor multiplies MRR **only for cycles after the recovered one**, so the recovered invoice’s own dollars (already in A) are excluded.
- `A(H) = Σ_{k=1}^{H} δ^k · ρ^k` — a bounded, discounted survival annuity over a **capped horizon** `H` cycles (default `H = 6` monthly cycles), with per-cycle discount `δ` (default 0.99/mo ≈ merchant cost of capital) and per-cycle voluntary-retention rate `ρ` (empirical, per merchant/segment). Capping `H` is a deliberate conservatism: we do not claim infinite-horizon LTV.

> **Why retained value is measured at the arm level, not per-invoice.** `Ŝurv_i` and `ρ` are estimates. To keep invariant #2 (measured, not modeled), the *retention* component is **also** differenced across the randomized arms: we compare realized forward retention of recovered *control* customers vs. recovered *treatment* customers (see §1.4). The model only smooths; the arm difference is what we bill.

### 1.3 Arm-level dollar aggregates

Over all treated (`T`) and control (`C`) invoices in a strata-balanced experiment, we form per-invoice outcomes and estimate **arm mean outcomes** (§4). The **billable incremental dollars** is a *difference of differences* expressed in dollars, never a raw treatment total.

### 1.4 Combining (A) and (B) without double-counting

The composite billable outcome per invoice is:

```
Y_i = R_i + S_i
```

with these disjointness guarantees:

1. **Horizon disjointness.** `R_i` covers the *current* invoice/cycle; `S_i` covers *only* cycles `1..H` *after* it. No cycle appears in both. The recovered invoice’s face value is in `R_i` and is explicitly excluded from the `S_i` annuity (the sum starts at `k=1`, the *next* cycle).
2. **Both differenced against control.** We bill on `E[Y_t] − E[Y_c]`, so any retention that *would have happened anyway* (control customers also renew) is subtracted out. Involuntary-save value we did not cause is not billed.
3. **Clawback symmetric.** A future refund/chargeback/downgrade inside horizon `H` retro-reduces `S_i` and, via the true-up mechanism (§9.1–9.2), the corresponding fee.
4. **Retention capped and discounted.** `A(H)` is bounded, so a single save can never inflate a bill without limit.

> **Billing toggle (founder decision, §14).** Two modes:
> - **Conservative (default, recommended for launch):** bill on `R` only (component A). Retained-subscription value is *shown* on the statement as "additional value created (not billed)". Maximum trust, simplest audit.
> - **Full-value:** bill on `Y = R + S`. Higher revenue, requires the merchant to accept the (still holdout-verified, still lower-bounded) retention math. Enable per contract.

### 1.5 The fee

Given the **lower confidence bound** `L$` on incremental billable dollars for the billing period (§5, §7):

```
Fee = 0.12 × max(0, L$)
```

If `L$ ≤ 0` (holdout has not yet proven positive lift at the required confidence), **the fee is $0**. We never bill on an unproven month. This is the honest-billing guarantee made mechanical.

---

## 2. Unit of randomization & assignment

### 2.1 The decision: cluster-randomize at the **customer** level

**We randomize at the customer level, not the invoice level.** The randomization unit (the "cluster") is the `(merchant_id, customer_id)` pair; *all* of a customer's failed invoices inherit that customer's arm for the life of the epoch. Outcomes are still *observed and logged per invoice*, but assignment is per customer.

This reconciles with `ARCHITECTURE.md` §3.1 ("keyed on a stable hash of customer+invoice so re-processing is deterministic"): the **bucket boundary** is computed at customer grain (so a customer is stable across repeat failures), while `invoice_id` enters only the *assignment-record key* to make reprocessing idempotent and to key the fallback path in §2.4. The architecture's determinism goal is preserved; we make the *unit* explicit.

**Trade-off analysis (why customer, not invoice):**

| | Invoice-level randomization | Customer-level (cluster) — **chosen** |
|---|---|---|
| Statistical power | Higher (more independent units, smaller variance) | Lower nominal N; must use cluster-robust variance (§4.5). CUPED partly recovers the loss. |
| Contamination | **Broken.** A customer with two failed invoices could be split across arms; Lift comms sent for the treatment invoice ("update your card") fix the payment method that then recovers the *control* invoice for free → control looks artificially good, uplift is *understated* (and unstable). | **Clean.** A customer is entirely in one arm; no within-customer spillover. |
| Retained-subscription measurement (§1.2B) | Impossible to attribute cleanly — the subscription belongs to a customer, not an invoice. | Natural — retention is a customer-level outcome. |
| Repeat failures | Ambiguous | Well-defined: same arm every time. |

We accept lower nominal power in exchange for an *unbiased, non-contaminated, honestly-defensible* estimate. Under invariant #1 (under-claim) and the CFO-trust mandate, bias is unacceptable and variance is merely inconvenient — and CUPED (§4.6) + longer accrual buys the power back.

### 2.2 Deterministic assignment function

Assignment is a pure function of stable identifiers and a per-epoch salt — no database state, no RNG, no time-of-day dependence. Reprocessing the same customer always yields the same arm.

```
bucket_key   = f"{merchant_id}|{customer_id}|{epoch_salt}"
h            = SHA256(bucket_key)                       # 256-bit
u            = (int(h[:16], 16) mod 10_000) / 10_000    # uniform in [0,1), 4-dp resolution
arm          = "control" if u < control_fraction(merchant, stratum, t) else "treatment"
```

- `epoch_salt` is a per-merchant, per-experiment-epoch random constant (§2.6). Rotating it re-randomizes everyone; it is **frozen** for the life of an epoch and versioned in the ledger.
- Using SHA-256 (not a fast non-crypto hash) makes the assignment **non-gameable**: neither we nor the merchant can search for a salt that flatters the numbers, because per-epoch salt is committed *before* outcomes accrue (§2.6, §8).
- `control_fraction(...)` may vary by stratum and time (taper, §2.3), but for a *given* customer within a *given* epoch the effective threshold is pinned by the epoch config, so `u < threshold` is stable.

### 2.3 Control fraction: default and taper

- **Default onboarding:** `control_fraction = 0.10` (10%). Tighter/faster significance; the "cost of holdout" is 10% of failures left on baseline-only.
- **Taper:** once per-merchant lift is established at required confidence and stable across ≥2 epochs, taper to `0.05` (5%) to reduce the merchant’s opportunity cost of the holdout.
- Taper is **epoch-boundary only** — never mid-epoch, because changing `control_fraction` mid-epoch changes the threshold and would re-bucket borderline customers, breaking invariant #3. A taper starts a new epoch with a new salt (or a *nested* holdout carve-out; see §2.6 note).
- **Floor:** never below a per-merchant minimum that preserves detectable power for that merchant’s failure volume (compute from §6.4 MDE budget). Very small merchants may need to *stay at 10%* or pool epochs longer.

### 2.4 New-customer cold assignment & the guest/one-off fallback

- **Cold customers:** the hash needs no history — a brand-new `customer_id` buckets immediately and deterministically. No warm-up bias.
- **Guest / one-off invoices with no durable customer identity** (rare in subscription billing, common in some processors' one-time charges): if `customer_id` is null/ephemeral, fall back to invoice-grain assignment:
  ```
  bucket_key = f"{merchant_id}|guest|{invoice_id}|{epoch_salt}"
  ```
  These units are flagged `unit_grain = "invoice"` in the assignment log and are analyzed in a **separate stratum** (they cannot contaminate a customer relationship since there is none). They never mix into customer-grain cluster variance.

### 2.5 Stratified randomization

Assignment is stratified so control and treatment are comparable *within* comparable populations. Strata are the cross-product:

```
stratum = (MRR_tier) × (decline_code_family) × (issuer_region)
```

- **MRR tier** — e.g., `{<$20, $20–99, $100–499, $500+}` monthly (per-merchant configurable buckets).
- **Decline-code family** — canonical families from the POAL taxonomy (`insufficient_funds`, `do_not_honor`, `expired_card`, `lost_stolen`, `invalid_card`, `issuer_unavailable`, `velocity_limit`, `other`). Hard vs. soft is derivable from family.
- **Issuer region** — issuer country/region bucket from BIN metadata (`NA`, `EU`, `UK`, `LATAM`, `APAC`, `other`).

**Implementation of stratification with a deterministic hash.** We do *not* need a stateful stratified sampler. Because assignment is customer-deterministic and `control_fraction` can be set per stratum, each stratum receives the target control share in expectation, and the SRM check (§6) verifies realized balance per stratum. If a stratum drifts (small-N strata can), we (a) pool sparse strata into an `other` bucket per dimension by a documented collapse rule, and (b) rely on CUPED + post-stratification adjustment (§4.7) at analysis time. **Randomization is stratified; estimation is post-stratified** — belt and suspenders.

> A customer’s stratum is defined by the **first** failed invoice in the epoch that put them in the experiment (stratum is sticky per customer per epoch, stored in the assignment log) so that later invoices with different decline codes don't re-stratify the same customer and reintroduce within-customer heterogeneity into the cluster.

### 2.6 Holdout stability across reprocessing (epochs & salt)

- An **epoch** is a `(merchant_id, epoch_id, epoch_salt, control_fraction_config, window_W, stratum_config)` tuple, written to the ledger at epoch start (§8) *before* any outcomes. This is the pre-registration.
- Within an epoch, `arm(customer)` is a pure function → webhook replays, reconciliation re-runs, backfills, and disaster-recovery reprocessing all yield the *same* arm. There is no path by which reprocessing moves a customer between arms.
- **Salt rotation** (new epoch) is the *only* way anyone changes buckets, it re-randomizes everyone, and it is logged and immutable. Rotations are rare and scheduled (taper, model-generation change). Frequent rotation is a red flag the SRM/anomaly layer surfaces.
- **Nested taper option:** to taper 10%→5% *without* fully re-randomizing (preserving longitudinal comparability), keep the same salt and move the *upper half* of the current control band `[0.05, 0.10)` into treatment at the next epoch boundary. Customers with `u < 0.05` stay control; `0.05 ≤ u < 0.10` become treatment. This is deterministic, auditable, and doesn't disturb the retained 5% control. (Founder decision which taper style to use.)

---

## 3. Contamination & interference (SUTVA)

The estimator is unbiased only under **SUTVA** (a unit's outcome depends only on its own arm). We enumerate the realistic violations and how the design blocks each.

### 3.1 Within-customer spillover (the main threat) — blocked by design

Mechanism: a customer with multiple failed invoices; Lift sends a card-update link for one, the customer updates their card, and a *different* invoice recovers "for free." If that other invoice were in control, the control recovery rate is inflated → uplift understated and noisy.
**Mitigation:** customer-level clustering (§2.1). The whole customer is one arm; there is no control invoice to leak into. **This is the single strongest reason for the design choice.**

### 3.2 Comms spillover across customers — bounded and monitored

Mechanism: shared inbox / family plan / same billing contact for two customers in different arms; a treatment comm nudges a control customer to fix payment.
**Mitigation:** (a) rare in practice; (b) where the processor exposes a stable `billing_contact` / email hash, we *co-cluster* customers sharing a contact into the same arm (assignment key falls back to the shared-contact hash when present). Logged as `cluster_grain = "contact"`. (c) The residual is monitored via a **negative-control**: control-arm recovery *timing* should not spike right after treatment comms sends; a spillover monitor flags it.

### 3.3 Model / intelligence leakage — structurally absent from control

Concern: Lift’s cross-merchant issuer model learns from treatment outcomes; does that "help" control?
**Answer:** No. **Control is baseline-only — Lift executes nothing for control invoices.** No retry timing, no comms, no card-update from us. Control recovery is produced entirely by the merchant’s native stack (Stripe Smart Retries), which is independent of our model. So model improvement cannot raise the control rate. It *does* raise the treatment rate over time — that is exactly the lift we are entitled to bill, and the sequential estimator (§5) tracks a possibly-growing effect honestly.

### 3.4 Temporal interference — handled by strata & epochs

Issuer behavior, paydays, and seasonality shift over time and would bias a naive before/after. Because control and treatment run **simultaneously**, common-time shocks hit both arms equally and difference out. The randomized simultaneous control is precisely what a before/after baseline (Redux/Butter) lacks.

### 3.5 Capacity / congestion interference — monitored

If Lift’s comms volume were so high it degraded deliverability for everyone (including control’s native email), that’s cross-arm interference. Monitored via per-arm comms deliverability metrics; guardrail rate-limits prevent it.

---

## 4. Estimator

### 4.1 Per-invoice outcomes

For invoice `i` with arm `A_i ∈ {c,t}`, stratum `s(i)`, we record the composite dollar outcome `Y_i = R_i + S_i` (§1.4) and, for diagnostics, the binary recovery `Z_i ∈ {0,1}`.

### 4.2 Recovery rates (diagnostic layer)

```
p̂_c = (Σ_{i∈C} Z_i) / |C|          # control recovery rate
p̂_t = (Σ_{i∈T} Z_i) / |T|          # treatment recovery rate
Δ̂_rate = p̂_t − p̂_c                # incremental recovery-rate lift
```

`Δ̂_rate` is the headline "we lift recovery by X points" number and drives the dashboard; it is **not** what we bill. We bill dollars (§4.3), because a point of lift on a $500 invoice ≠ a point on a $20 invoice.

### 4.3 Incremental dollars — the billed estimator

Work in per-invoice dollars and take the difference of arm means:

```
Ȳ_c = (1/|C|) Σ_{i∈C} Y_i
Ȳ_t = (1/|T|) Σ_{i∈T} Y_i
Δ̂$_per = Ȳ_t − Ȳ_c                              # incremental $ per treated failed invoice
Incremental$ (period) = Δ̂$_per × N_treated       # scaled to the treated population
```

Here `N_treated` is the count of *treated* failed invoices in the billing period (the population that actually received treatment). We bill the lift **on the treated volume only** — control invoices, by definition, received no treatment, so we do not bill their forgone lift. (We *could*; we deliberately don't — another structural under-claim.)

Equivalently and preferred for variance work: define the centered per-invoice contribution and estimate the *total* incremental dollars directly with a Horvitz–Thompson-style scaling, but the arm-mean-difference form above is the reference implementation.

### 4.4 Stratified (post-stratified) point estimate

To remove residual imbalance, combine per-stratum effects weighted by treated volume:

```
Δ̂$_per = Σ_s w_s · (Ȳ_t,s − Ȳ_c,s),    w_s = N_treated,s / N_treated
```

This is the **post-stratification** estimator; it is our defense against Simpson’s paradox (§9.7) — the aggregate is always a volume-weighted average of *within-stratum* effects, so a mix shift across strata cannot flip the sign of the reported lift.

### 4.5 Variance with clustering

Because customers are the randomization unit, invoices within a customer are correlated. We use **cluster-robust (CR) variance** with the customer as the cluster, per stratum:

```
V̂[Δ̂$_per,s] = V̂_clustered[Ȳ_t,s] + V̂_clustered[Ȳ_c,s]
```

where each arm’s clustered variance is the cluster-sum estimator

```
V̂_clustered[Ȳ_a,s] = ( 1 / n_a,s² ) · Σ_{k∈clusters(a,s)} ( (Σ_{i∈k} (Y_i − Ȳ_a,s)) )²  · (G/(G−1)) correction
```

(`n_a,s` = invoices in arm `a`, stratum `s`; `G` = #clusters; small-G correction applied). Aggregate across strata:

```
V̂[Δ̂$_per] = Σ_s w_s² · V̂[Δ̂$_per,s]
```

The **standard error** `SE = sqrt(V̂[Δ̂$_per])` feeds the confidence sequence (§5). Using CR variance (vs. naive iid) is what keeps the interval *honest* under clustering; skipping it would understate uncertainty and over-bill — forbidden.

### 4.6 CUPED variance reduction

CUPED (Controlled-experiment Using Pre-Experiment Data) removes variance explained by *pre-failure* covariates that are, by construction, independent of arm assignment (assignment happens at/after failure; covariates are measured strictly before). This tightens the interval → higher billable lower bound *without any bias*, and faster time-to-significance.

**Covariate vector `X_i`** (all measured *before* the failure event; no post-treatment leakage):

- `tenure_days` — customer age at time of failure.
- `prior_recovery_rate` — customer’s historical share of past failed invoices eventually recovered.
- `mrr` — current monthly recurring value (also a strat variable; residual within-tier variation still helps).
- `hist_decline_rate` — customer’s historical decline frequency.
- `invoice_amount` — face value `v_i` (strong predictor of dollar outcome variance).
- `prior_failures_count`, `days_since_last_failure`.
- `plan_type` / `billing_interval` (one-hot).
- `issuer_approval_prior` — cross-merchant BIN historical approval propensity (the aggregated issuer feature; pre-failure snapshot only).

**Single-covariate CUPED (classic):** for a chosen scalar covariate `X` with grand mean `X̄`,

```
θ* = Cov(Y, X) / Var(X)           # estimated pooled across arms
Y_i^cuped = Y_i − θ*·(X_i − X̄)
```

`Y^cuped` has the same expectation as `Y` (so `Δ̂` is unbiased) but variance reduced by factor `(1 − ρ²)`, where `ρ = corr(Y, X)`. All estimators in §4.3–4.5 are recomputed on `Y^cuped`.

**Multivariate / CUPAC (recommended):** replace the single covariate with a **predicted outcome** `Ŷ_i = g(X_i)` from a model `g` trained on *pre-experiment* (or cross-validated, arm-blinded) data — CUPED then uses `Ŷ` as the single control variate:

```
θ* = Cov(Y, Ŷ)/Var(Ŷ);   Y_i^cuped = Y_i − θ*·(Ŷ_i − Ŷ̄)
```

This captures nonlinear multivariate structure and typically yields the largest variance reduction. **Guardrails to preserve invariant #2:** `g` is trained *without* arm labels and *without* any post-failure signal; the CUPED adjustment is re-derived per epoch and versioned in the ledger; and we *verify* unbiasedness with an A/A check (§6.5) — CUPED must not move the A/A effect off zero.

> CUPED reduces variance; it **cannot** manufacture lift. If `Y` and `X` are uncorrelated, `θ*→0` and we fall back to the raw estimator. The floor case is always the model-free difference of means.

### 4.7 Estimator summary (billing path)

1. Compute `Y_i = R_i + S_i` (or `R_i` only in conservative mode).
2. Compute `Y_i^cuped` with the epoch-frozen CUPED adjustment.
3. Post-stratify: `Δ̂$_per = Σ_s w_s (Ȳ_t,s^cuped − Ȳ_c,s^cuped)`.
4. Cluster-robust `SE` (§4.5).
5. `Incremental$ = Δ̂$_per × N_treated`; `SE$ = SE × N_treated`.
6. Feed `(Incremental$, SE$, cumulative n)` to the confidence sequence (§5) → lower bound `L$`.

---

## 5. Sequential / always-valid inference

### 5.1 Why fixed-horizon p-values are wrong here

We read the uplift metric **continuously** — the dashboard updates daily, and billing runs monthly on whatever data has accrued. A classic fixed-`n` 95% CI or t-test is only valid if `n` is fixed *in advance* and looked at *once*. Peeking and stopping when it looks significant inflates the false-positive rate dramatically (repeated testing → the "always-significant-eventually" problem). If we billed on a fixed-horizon CI that we happened to read at a favorable moment, we would over-claim — a direct violation of invariant #1 and exactly the kind of thing a skeptical auditor is trained to catch.

We therefore use **always-valid inference**: a confidence sequence (CS) `{[L_n, U_n]}_{n≥1}` such that

```
P( ∀ n :  θ ∈ [L_n, U_n] )  ≥  1 − α
```

The coverage guarantee holds **simultaneously at all sample sizes**, so we may look as often as we like, stop whenever we like (e.g., every monthly billing run), and bill on `L_n` at that moment with the guarantee intact.

### 5.2 The confidence sequence we use

We adopt the **mSPRT-derived normal-mixture confidence sequence** (Robbins mixture / Johari–Pekelis–Walsh "always valid inference", the method Optimizely productionized), because it has a clean closed form, a tunable parameter that lets us optimize tightness for an anticipated effect size, and it degrades gracefully.

Let `θ = Δ$_per` be the per-invoice incremental dollars (the CUPED-adjusted, post-stratified effect). Let `θ̂_n` be its estimate after cumulative effective sample size `n`, and let `σ̂²_n` be the per-observation variance of the (CUPED-adjusted) contribution such that `Var(θ̂_n) = σ̂²_n / n` — computed with the cluster-robust machinery of §4.5 (so `n` is an *effective* sample size that already accounts for intra-cluster correlation and stratification).

The `(1−α)` confidence sequence half-width is:

```
        ┌                                              ┐
        │   σ̂²_n · (n·τ² + σ̂²_n)          n·τ² + σ̂²_n  │
h_n =  √│  ───────────────────── · log( ─────────────── ) │
        │        n² · τ²                    α² · σ̂²_n     │
        └                                              ┘
```

and the confidence sequence is `θ̂_n ± h_n`.

- `τ²` is the **mixture (tuning) variance** — heuristically a prior on the effect size. Tuning `τ² ≈ (anticipated θ)²` at the merchant’s planned decision horizon minimizes `h_n` there. It is **committed per epoch** (in the ledger) *before* reading outcomes, so it cannot be tuned to flatter results. Any `τ²>0` yields a valid CS; tuning only affects tightness, never coverage.
- As `n→∞`, `h_n → 0` at rate `√(log n / n)` — slightly wider than a fixed-horizon CI (the price of anytime validity), which is exactly the small, honest conservatism we want.
- `α` default `0.05` (95% CS). One-sided billing uses the lower bound; we quote the two-sided CS and bill on `L_n`, which is conservative.

> Equivalent framing: this CS is dual to the **mSPRT** always-valid p-value `p_n = min(1, 1/Λ_n)` where `Λ_n` is the mixture likelihood ratio of `H_1: θ≠0` vs `H_0: θ=0`. Billing gating (§6) can use either the CS lower bound crossing 0 or `p_n < α`; they are consistent. We standardize on the CS because it directly yields the dollar lower bound we bill.

### 5.3 Deriving the number we bill

Per-invoice lower bound, then scale to treated volume:

```
L_per = θ̂_n − h_n
L$    = max(0, L_per) × N_treated
Fee   = 0.12 × L$
```

Two conservatisms stack here: (1) we take the *lower* end of the interval, and (2) we `max(0,·)` so a not-yet-significant month bills zero rather than anything negative. `L$` is the single number that flows to the ledger and the Uplift Statement.

### 5.4 Accrual & horizon bookkeeping

- The CS accrues over the **experiment epoch**, not the calendar month: `n` is cumulative since epoch start. Each monthly bill is `0.12 × [L$(end of month) − Σ already-billed L$]`, i.e., we bill the **increment in proven cumulative lower-bound dollars**, never re-billing prior months (§7.4). This makes the sequence monotone-friendly and prevents double billing as the CS tightens.
- Outcomes are only counted once their attribution window `W` has closed (a failure late in the month whose window still extends into next month accrues to the period in which its window closes). Open-window invoices sit in a `pending` state and are excluded from `n` until resolved — no guessing.

---

## 6. Sample-ratio-mismatch (SRM) & health checks

Assignment integrity is the foundation; if the arms aren’t really randomized/balanced, every downstream number is void. We gate billing on a battery of automated checks.

### 6.1 SRM chi-square

Expected control share is `f = control_fraction`. Observed counts `(O_c, O_t)` over clusters (customers, not invoices — SRM is tested at the randomization unit). Test:

```
E_c = f·N_clusters,  E_t = (1−f)·N_clusters
χ² = (O_c − E_c)²/E_c + (O_t − E_t)²/E_t          # 1 dof
```

- Run **overall and per stratum** (with multiplicity control across strata).
- **Auto-pause threshold:** `p < 0.001` (SRM checks use a strict threshold because a true 50/50-style randomization should essentially never fail; a failure means a bug, a leak, or tampering — not noise). On trip: **pause billing accrual, freeze the epoch, page on-call, surface a banner.** Do *not* silently proceed.
- Common root causes to check on a trip: skewed retry of one arm (idempotency bug re-inserting treatment invoices), a stratum collapse rule misfiring, an adapter double-emitting webhooks for one arm, salt misconfiguration.

### 6.2 A/A pre-flight and continuous A/A

- **Pre-flight A/A:** before an epoch bills, run the entire pipeline with a *synthetic* second control (split control into c1/c2). The measured c1−c2 effect must have a CS covering 0 and a well-calibrated false-positive rate. This validates the *plumbing* (CUPED unbiasedness, variance estimator, CS coverage) end-to-end.
- **Continuous negative control:** maintain a small permanent A/A shadow to detect regressions in the estimator over time.

### 6.3 Minimum sample size before billing

No fee is charged until **all** hold:

- `N_clusters,control ≥ n_min` (default `n_min = 300` control customers) **and** `N_treated ≥ 300` treated invoices — floors for the CLT/variance estimator to behave.
- Each **billed stratum** meets a per-stratum floor (default 50 control + 50 treated invoices); strata below the floor are pooled per the collapse rule before contributing.
- The CS lower bound `L_per > 0` (i.e., lift is *proven*, not merely estimated).
- SRM and anomaly checks green for the period.

If floors aren’t met, the month accrues data and bills **$0**; the value is still shown as "measured, not yet billable."

### 6.4 Minimum detectable effect (MDE) budget

At epoch setup we compute, from the merchant’s failure volume, control fraction, and outcome variance (CUPED-reduced), the **time-to-detect** for a plausible effect. This sets the taper schedule (§2.3) and tells small merchants up front how long until a billable signal — no surprises.

### 6.5 Anomaly detection

Continuous monitors, each with auto-pause + alert:

- **Outcome-rate anomalies:** sudden jump/drop in either arm’s recovery rate beyond a control-charted band (issuer outage, merchant toggled Smart Retries — §9.1).
- **Covariate balance drift:** standardized mean differences of `X` between arms should hover near 0; a drift implies a leak or a stratification bug.
- **Value-distribution shifts:** heavy-tail invoices entering one arm (a single whale can dominate `Δ$`); flagged and handled via winsorization disclosure (§9.6).
- **CUPED sanity:** `θ*` and achieved variance reduction within expected range; if CUPED starts *increasing* variance or moving the A/A off zero, disable it for the epoch and fall back to raw.
- **Salt/epoch integrity:** any unexpected change in epoch config vs. ledger commitment → hard stop.

---

## 7. The billing computation (step by step)

### 7.1 Pipeline

```
raw outcomes (per invoice, window-closed)
  → 1. join arm + stratum from assignment_log (immutable)
  → 2. compute R_i, S_i → Y_i             (net of clawbacks in-window)
  → 3. apply epoch CUPED: Y_i^cuped
  → 4. per-stratum arm means Ȳ_{a,s}^cuped
  → 5. post-stratified Δ̂$_per = Σ_s w_s (Ȳ_t,s − Ȳ_c,s)
  → 6. cluster-robust SE (customer clusters)
  → 7. cumulative effective n → CS half-width h_n
  → 8. L_per = max(0, Δ̂$_per − h_n)
  → 9. L$_cum = L_per × N_treated_cum
  → 10. period fee = 0.12 × (L$_cum − L$_already_billed)
  → 11. write Uplift Statement + ledger entries (signed)
```

Health gates (§6) sit between 6 and 8: if any red, the run **halts and bills $0** for the period, with reason logged.

### 7.2 Worked numeric example

*Illustrative single-epoch month, conservative mode (bill on `R` only), one pooled stratum for brevity. Real runs post-stratify.*

Inputs (window-closed invoices this epoch-to-date):

| | Control | Treatment |
|---|---|---|
| Failed invoices (window-closed) | 1,000 | 9,000 |
| Distinct customers (clusters) | 820 | 7,350 |
| Recovered invoices | 380 | 4,140 |
| Recovery rate `p̂` | 38.0% | 46.0% |
| Mean recovered $ per **failed** invoice `Ȳ` | \$85.00 | \$104.00 |

Step 1 — recovery-rate lift (diagnostic): `Δ̂_rate = 46.0% − 38.0% = 8.0 pts`.

Step 2 — incremental $ per treated failed invoice:
`Δ̂$_per = Ȳ_t − Ȳ_c = 104.00 − 85.00 = $19.00`.

Step 3 — CUPED. Suppose `corr(Y, Ŷ) = 0.55`, so variance reduces by `1 − 0.55² = 0.6975`. Raw per-invoice SD ≈ \$300 (heavy-tailed invoice values). CUPED SD ≈ `300·√0.6975 ≈ $250.6`. (CUPED leaves `Δ̂$_per` ≈ \$19.00 unchanged in expectation; assume \$19.00.)

Step 4 — standard error of `Δ̂$_per` with clustering. Approximate effective per-arm SE (design-effect from clustering already folded into effective n). Using CUPED SD:
`SE ≈ √( 250.6²/9000 + 250.6²/1000 ) = √(6.98 + 62.8) = √69.8 ≈ $8.35`.

Step 5 — confidence sequence half-width. Take `α=0.05`, mixture `τ` tuned to the anticipated effect. For this `n` and `σ̂`, the mSPRT-mixture CS is modestly wider than the fixed-horizon `1.96·SE = $16.37`. Suppose the anytime-valid inflation factor here is ≈ `1.35×` → `h_n ≈ $22.1` **per invoice**? That would swamp the \$19 point estimate and bill \$0 — which correctly reflects that 1,000 control invoices is thin. To make the example *billable*, assume the epoch has accrued more control data over time so the cumulative effective control N is larger and `h_n ≈ $11.90` per invoice.

Step 6 — per-invoice lower bound: `L_per = max(0, 19.00 − 11.90) = $7.10`.

Step 7 — scale to treated volume: `L$_cum = 7.10 × 9,000 = $63,900`.

Step 8 — prior cumulative billed lower-bound dollars (earlier months this epoch): `L$_already = $41,000`.

Step 9 — period billable increment: `63,900 − 41,000 = $22,900`.

Step 10 — **fee = 0.12 × 22,900 = \$2,748.**

Interpretation for the CFO: "Treatment recovered \$104/failed-invoice vs. \$85 on a live control; the *point* estimate of incremental value is \$19/invoice (~\$171K on 9,000 treated), but we only bill 12% of the **statistically-guaranteed lower bound** of \$7.10/invoice (\$63.9K cumulative), and only the \$22.9K *new* this month. Your fee is \$2,748. The other ~\$107K of point-estimate value we created is *not* billed — it isn’t proven at 95% anytime-valid confidence yet."

*(All numbers illustrative; the inflation factor, SE, and CUPED gain are computed from real data, not assumed.)*

### 7.3 What appears on the invoice line

`Fee = 12% × (billable incremental lower-bound $ newly proven this period)`, with a pointer to the Uplift Statement ID and ledger hash range that produced it.

### 7.4 Monotone accrual & no re-billing

We bill the **increment in cumulative proven lower-bound dollars**. Because the CS lower bound can rise (more data) or, occasionally, fall (a bad stretch, a clawback), the increment can be zero or, in a clawback month, *negative* → handled as a credit (§9.1), never a silent absorption. We never re-bill dollars already billed and never bill above cumulative `L$`.

---

## 8. The immutable ledger & Uplift Statement

### 8.1 Hash-chained append-only ledger

Every consequential event is an append-only ledger entry. Each entry commits to the previous one:

```
entry.prev_hash = ledger[n−1].hash
entry.hash      = SHA256( canonical_json( entry.payload ) || entry.prev_hash )
```

- Genesis entry per merchant per epoch commits the **pre-registration**: `epoch_id`, `epoch_salt` (or a salted commitment to it), `control_fraction`, `window_W`, `stratum_config`, `τ²`, `α`, CUPED model version, billing mode. Committing these *before* outcomes accrue is what makes the experiment non-p-hackable: we cannot later choose the analysis that flatters the bill.
- Writing is **write-once**; corrections are *new compensating entries* referencing the prior hash, never edits. The chain is periodically anchored (daily Merkle root) to a WORM store / external timestamp for stronger tamper-evidence.

### 8.2 Entry types & fields

**`assignment` entry** (written at experiment entry, *before* outcome):
`entry_id, ts, merchant_id, epoch_id, customer_id, invoice_id, unit_grain{customer|invoice|contact}, arm{control|treatment}, stratum{mrr_tier,decline_family,issuer_region}, bucket_u, salt_version, decline_code, decline_family, invoice_amount, currency, mrr_snapshot, cuped_covariates_snapshot{...}, prev_hash, hash`.

**`attempt` entry** (each charge attempt / comm action):
`entry_id, ts, invoice_id, arm, action_type{retry|comm|card_update|suppressed}, channel, rail/method_ref, attempt_number, idempotency_key, decline_code, guardrail_decision{allowed|suppressed,reason}, processor_request_id, prev_hash, hash`.

**`outcome` entry** (window resolution & any later clawback):
`entry_id, ts, invoice_id, arm, outcome{recovered|failed|pending}, settled_ts, recovered_amount, currency, reversal{none|refund|chargeback|dispute}, reversal_amount, reversal_ts, retained_flag, forward_cycle_index, processor_txn_id, prev_hash, hash`.

**`billing` entry** (per period):
`entry_id, ts, merchant_id, epoch_id, period, N_treated_cum, delta_per, se, h_n, L_per, L$_cum, L$_prev, billable_increment, fee_rate=0.12, fee, statement_id, cuped_theta, tau2, alpha, health_checks{srm_p, srm_paused, min_n_met, anomalies[]}, input_hash_range{first,last}, prev_hash, hash`.

### 8.3 The monthly Uplift Statement

Generated deterministically from the ledger (given the ledger, the statement is a pure function → reproducible, invariant #3). Contents:

1. **Header:** merchant, period, epoch(s), config (control %, window, α, τ, CUPED version, billing mode), ledger hash range, statement hash, signature.
2. **Population:** failed invoices in period, split control/treatment, per stratum; customer counts; SRM p-values (overall + per stratum) and pass/fail.
3. **Outcomes:** per-arm recovery rates and mean recovered $ per failed invoice (raw and CUPED-adjusted), per stratum and pooled (post-stratified).
4. **Estimate:** `Δ̂$_per`, `SE`, `h_n`, per-invoice lower bound `L_per`, `N_treated`, `L$_cum`, prior billed, **billable increment**, **fee**.
5. **Not billed (transparency):** point-estimate value minus billed lower bound (the money we created but did not charge for); retained-subscription value shown separately (billed or not per mode).
6. **Clawbacks:** refunds/chargebacks/disputes that reduced recovered value this period, with processor txn references and resulting credits.
7. **Reconciliation appendix (§8.4).**
8. **Signature block:** statement hash, signing key ID, timestamp, anchor reference.

Exportable as CSV / PDF / API. The PDF is a render of the signed JSON; the JSON is authoritative.

### 8.4 CFO reconciliation — line-by-line against the processor

The trust moat is that a CFO can tie our number to the processor’s **own** records without trusting us:

1. **Recovered transactions ↔ processor payout report.** Every `outcome.recovered` entry carries `processor_txn_id` and `settled_ts`. The statement ships a CSV of exactly these; the CFO filters the Stripe (or other) balance/payout export to the recovered invoice IDs and checks the sum of settled amounts matches our recovered-$ total **penny for penny**. Because we never touch the PAN or the money flow, the processor’s ledger is the independent source of truth.
2. **Arm membership is pre-committed.** The `assignment` entries are timestamped and hash-chained *before* outcomes, so the CFO can verify no invoice was moved into "treatment" after it happened to recover. (We can furnish the salt post-epoch so they can *recompute* every bucket themselves — full reproduction.)
3. **Attempts ↔ processor attempt logs.** `attempt` entries with `processor_request_id`/`idempotency_key` reconcile against the processor’s attempt/event log — proving we did (treatment) or did not (control) act.
4. **Fee arithmetic is on the statement.** `fee = 0.12 × billable_increment`, every input shown, recomputable by hand.
5. **Clawbacks tie out** to the processor’s refund/dispute records via `processor_txn_id`.

The CFO’s conclusion: the counterfactual is a real simultaneous control they can reconstruct, the recovered dollars are the processor’s own settled transactions, and the fee is 12% of a lower bound they can recompute. Nothing requires trusting Lift’s dashboard.

### 8.5 Signing

- Each Uplift Statement and each daily Merkle anchor is signed with a per-merchant (or per-region) asymmetric key (Ed25519), key managed in KMS/HSM (`ARCHITECTURE.md` §9). `signing_key_id` is on the statement; the public key is published so anyone can verify.
- Signature covers the statement hash, which covers the ledger hash range, which chains back to the pre-registered genesis. One verification transitively validates config, assignment, outcomes, and arithmetic.

---

## 9. Edge cases & adversarial concerns

### 9.1 Merchant changes the baseline mid-month (Smart Retries toggled)

The control arm *is* "the merchant’s native stack." If the merchant toggles Stripe Smart Retries (or changes native dunning) mid-epoch, the baseline shifts under us — control recovery rate steps, and the anomaly monitor (§6.5) fires on the control-arm rate change.
**Handling:** (a) Where detectable via processor config/API, we **snapshot native-dunning config** into the epoch genesis and watch for changes; a change **ends the epoch** and starts a new one (new pre-registration) so pre- and post-change data are never pooled. (b) Undetectable changes are caught by the control-rate control-chart → auto-pause, investigate, re-epoch. (c) Net effect: we always bill against the *concurrent* baseline, whatever it currently is — turning Smart Retries on *reduces* our measured lift honestly, and we bill the smaller number. We never claim credit for what Smart Retries does.

### 9.2 Refunds & chargebacks clawing back recovered revenue

A "recovered" charge later refunded/charged-back was not real recovered value.
**Handling:** `R_i` is defined net of in-window reversals; reversals *after* the window generate a **compensating `outcome` entry** and a **credit** on the next statement (`billable_increment` can go negative → credit, never hidden). Because both arms suffer reversals, differencing removes baseline reversal noise; only *incremental* net-of-reversal value is billed. Chargebacks also feed the recoverability model (a recovery that charges back is a *bad* recovery — the retention-aware reward already prices this).

### 9.3 Partial captures / partial payments

If only part of `v_i` is captured (partial capture, negotiated/partial payment): `R_i` = actually-settled amount, not face value. `Z_i` (binary recovered) uses a configurable threshold (default: any settlement > 0 counts as recovered for rate diagnostics; dollars always use the *actual* settled amount). Retained-value `S_i` keys off subscription continuation, which a partial payment may or may not achieve — driven by the processor’s subscription state, not our assumption.

### 9.4 Currency

All dollar math is in a single **merchant settlement currency**; multi-currency invoices are converted at the **processor’s own settled FX rate** (from the payout record, so reconciliation ties out) — never our own rate. Per-currency strata may be added if a merchant is materially multi-currency, to avoid FX variance leaking into the effect. `currency` is stored on every outcome entry.

### 9.5 Disputes over attribution

The whole design is the answer, but concretely: on dispute we (a) hand over the salt so the merchant recomputes every bucket, (b) provide the reconciliation CSV to tie recovered $ to their processor payout, (c) show the pre-registered genesis proving config wasn’t changed post-hoc, (d) recompute the CS from raw outcomes. Every claim is falsifiable by the merchant against the *processor’s* records, not ours. We also keep an "advisory-mode" fallback: if a processor won’t cede retry control, treatment is *advice the merchant/processor executes*, still logged and measurable.

### 9.6 Seasonality, whales, and heavy tails

- **Seasonality/dayparts:** handled by *simultaneous* control (common-time shocks difference out, §3.4). No seasonal baseline model needed.
- **Whale invoices:** a single \$50k invoice landing in one arm can swing `Δ$`. We (a) report with and without **winsorization** (disclosed on the statement), (b) let the CS’s honest variance widen `h_n` (heavy tails → wider interval → lower bill, correctly), and (c) can define a separate high-value stratum. We never *quietly* drop outliers; any winsorization is on the statement.

### 9.7 Simpson’s paradox across strata

Aggregate lift could differ in sign from every stratum’s lift if arm mix shifts across strata. **Prevented structurally** by the post-stratified estimator (§4.4): the reported effect is *always* a treated-volume-weighted average of *within-stratum* effects, so a mix shift cannot flip the sign. The statement shows per-stratum effects so the aggregation is transparent. SRM-per-stratum (§6.1) further guards against a stratum-level imbalance driving the aggregate.

### 9.8 Adversarial merchant / adversarial us

- **Merchant can’t game it:** they don’t control the salt, the assignment is pre-committed and reconcilable to the processor.
- **We can’t game it either (and prove it):** pre-registered genesis freezes `τ, α, W, CUPED version, strata, control %`; salt is committed before outcomes; billing is a pure function of the immutable ledger; CUPED can’t create lift and is A/A-verified; we bill a lower bound. Every degree of freedom that could inflate a bill is committed before outcomes are known and is independently checkable. That is the entire point of the artifact.

---

## 10. Data schema

Postgres (append-only ledger tables; §4.5 warehouse mirrors for analysis in ClickHouse). Money as integer minor units + currency; times as UTC `timestamptz`. `hash`/`prev_hash` are 32-byte.

### 10.1 `experiment_epoch` (pre-registration)

```
epoch_id            uuid pk
merchant_id         uuid
epoch_salt_commit   bytea            -- commitment to salt (salt revealed post-epoch)
control_fraction    numeric          -- e.g. 0.10
window_days         int              -- attribution window W
stratum_config      jsonb            -- tier cutpoints, family map, region map, collapse rules
tau2                double precision -- mSPRT mixture variance (committed)
alpha               double precision -- e.g. 0.05
cuped_model_version text
billing_mode        text             -- 'conservative' | 'full_value'
horizon_H           int              -- retained-value cycles
delta_discount      double precision
native_dunning_snapshot jsonb        -- baseline config at epoch start (§9.1)
created_at          timestamptz
genesis_hash        bytea            -- first ledger entry
```

### 10.2 `assignment_log` (one row per customer/unit per epoch; immutable)

```
assignment_id   uuid pk
epoch_id        uuid fk
merchant_id     uuid
customer_id     text null            -- null → guest/one-off (invoice grain)
unit_grain      text                 -- 'customer' | 'invoice' | 'contact'
bucket_key      text                 -- the exact string hashed (audit)
bucket_u        numeric              -- uniform in [0,1)
arm             text                 -- 'control' | 'treatment'
mrr_tier        text
decline_family  text                 -- sticky, from first qualifying failure
issuer_region   text
mrr_snapshot    bigint               -- minor units
salt_version    int
assigned_at     timestamptz          -- BEFORE outcomes
prev_hash       bytea
hash            bytea
unique(epoch_id, coalesce(customer_id, ''), unit_grain)
```

### 10.3 `cuped_covariates` (pre-failure snapshot; joined by assignment)

```
assignment_id        uuid fk pk
tenure_days          int
prior_recovery_rate  numeric
mrr                  bigint
hist_decline_rate    numeric
invoice_amount       bigint
prior_failures_count int
days_since_last_fail int
plan_type            text
billing_interval     text
issuer_approval_prior numeric        -- aggregated BIN feature, pre-failure snapshot
predicted_outcome    double precision -- ŷ = g(X), for CUPAC
snapshot_at          timestamptz     -- must be < failure ts (leakage guard)
```

### 10.4 `attempt_log` (each action; immutable)

```
attempt_id       uuid pk
epoch_id         uuid fk
invoice_id       text
customer_id      text
arm              text
action_type      text                -- retry | comm | card_update | suppressed | none(control)
channel          text null           -- email/sms/whatsapp/push/inapp
method_ref       text null           -- tokenized method / rail
attempt_number   int
idempotency_key  text
decline_code     text null
decline_family   text null
guardrail_decision jsonb             -- {allowed|suppressed, reason, cap, quiet_hours,...}
processor_request_id text null
occurred_at      timestamptz
prev_hash        bytea
hash             bytea
```

### 10.5 `outcome_log` (window resolution + clawbacks; append-only)

```
outcome_id       uuid pk
epoch_id         uuid fk
invoice_id       text
customer_id      text
arm              text
stratum          jsonb               -- denormalized for analysis
invoice_amount   bigint
currency         text
outcome          text                -- recovered | failed | pending
recovered_amount bigint              -- actual settled (partial-aware)
settled_at       timestamptz null
window_close_at  timestamptz
reversal_type    text                -- none | refund | chargeback | dispute
reversal_amount  bigint default 0
reversal_at      timestamptz null
retained_flag    boolean null        -- subscription active at next renewal
forward_cycle_index int null         -- which post-recovery cycle this row records
retained_value   bigint null         -- S_i contribution (minor units)
processor_txn_id text null           -- reconciliation key
recorded_at      timestamptz
prev_hash        bytea
hash             bytea
```

### 10.6 `billing_ledger` (per period; immutable, signed)

```
billing_id        uuid pk
epoch_id          uuid fk
merchant_id       uuid
period            daterange
n_treated_cum     bigint
delta_per         double precision    -- CUPED, post-stratified $ / invoice
se                double precision    -- cluster-robust
h_n               double precision    -- CS half-width
l_per             double precision    -- max(0, delta_per - h_n)
l_dollar_cum      bigint              -- l_per * n_treated_cum (minor units)
l_dollar_prev     bigint
billable_increment bigint             -- can be negative (credit)
fee_rate          numeric default 0.12
fee               bigint
retained_value_reported bigint        -- component B, billed or shown per mode
cuped_theta       double precision
tau2              double precision
alpha             double precision
health            jsonb               -- {srm_p_overall, srm_p_by_stratum[], min_n_met, anomalies[], paused}
input_hash_first  bytea               -- ledger range that produced this
input_hash_last   bytea
statement_id      uuid
statement_hash    bytea
signing_key_id    text
signature         bytea
created_at        timestamptz
prev_hash         bytea
hash              bytea
```

### 10.7 Derived analysis views (ClickHouse / warehouse)

- `v_arm_stratum_outcomes` — per (epoch, stratum, arm): counts, recovery rate, mean/var of `Y` and `Y^cuped`, cluster counts. Feeds §4.
- `v_cs_trace` — time series of `(n, delta_per, se, h_n, l_per)` for the dashboard’s always-valid trace and for auditing that we billed the lower bound at each point.
- `v_srm_trace` — per-period SRM p-values overall and per stratum.

---

## 11. Open statistical decisions for the founder

These are genuine forks where the "right" answer is a business/risk trade, not a math fact:

1. **Billing mode at launch (§1.4).** Recommend **conservative (recovered-$ only)** for the first cohorts — maximal trust, simplest reconciliation — then offer **full-value (adds retained-subscription $)** as an opt-in once the retention math has a track record. Decide whether full-value is even offered pre-Series-A.
2. **Retained-value horizon `H` and discount `δ` (§1.2B).** `H=6` months capped is deliberately conservative. A longer `H` books more value (and more clawback exposure). Recommend keeping `H` short until forward-retention estimates are validated against realized cohorts.
3. **CUPED vs. CUPAC (§4.6).** Single-covariate CUPED (invoice amount) is trivially defensible to an auditor; CUPAC (model-predicted outcome) is tighter but "a model on the billing path," which needs the A/A guard and clear disclosure. Recommend shipping single-covariate CUPED first (auditor-obvious), add CUPAC once A/A calibration is proven and disclosed.
4. **CS family (§5.2).** mSPRT normal-mixture (chosen) is clean and battle-tested (Optimizely). Alternative: nonparametric empirical-Bernstein confidence sequences (Waudby-Smith–Ramdas) — more robust to heavy-tailed invoice values (§9.6) at some tightness cost. Recommend mSPRT for v1, evaluate empirical-Bernstein for heavy-tail merchants.
5. **Taper style (§2.6).** Full re-randomization (new salt, clean but breaks longitudinal comparability) vs. nested carve-out (keep salt, move `[0.05,0.10)` band to treatment, preserves the retained 5% control). Recommend **nested** for continuity.
6. **Control-fraction floor for small merchants (§2.3, §6.4).** Some low-volume merchants can never reach significance at 5% and possibly not even at 10% in a reasonable time. Decide the policy: keep them at 10%+ indefinitely, pool epochs longer, or offer them a *flat* fee with a clearly-labeled "not holdout-verified" statement (which arguably dilutes the brand — recommend against).
7. **`α` and the anytime-valid conservatism (§5).** `α=0.05` two-sided → bill the lower bound. Going to `α=0.10` tightens bills ~15–25% but weakens the "your auditor will believe it" story. Recommend staying at `0.05`; the under-claim is the brand.
8. **Winsorization policy (§9.6).** Fixed percentile winsor vs. none-but-wider-interval. Recommend disclosed light winsorization (e.g., 99.5th pct) *plus* showing the un-winsorized number, so we’re never accused of dropping a merchant’s big win *or* of letting one whale fabricate lift.
```
