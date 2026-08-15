VERDICT: inconclusive at this sample size — the point estimate favors the AX10M engine by 1.19 pp, but the mSPRT lower bound is not positive (lower bound not yet positive (lift unproven)), so it would bill $0. — BUT this edge is a longer-retry-window artifact: against a baseline that retries as far as the engine, the engine LOSES (see the fairness sweep). On recovery rate alone the engine does not beat a persistent baseline.

# AX10M Backtest — does the recovery engine beat Stripe Smart Retries?

_Synthetic backtest. Treatment = `ax10m-engine`, Control = `stripe-smart-retries`. 5,364 control invoices, 49,691 treatment invoices, stream seed 20260814._

## Headline

| Metric | Control (Smart Retries) | Treatment (AX10M engine) |
|---|---|---|
| Recovery rate | 36.91% | 38.11% |
| Recovered $ | $138,828 | $1,305,697 |

- **Absolute recovery-rate lift:** 1.19 pp
- **Relative lift:** 3.2%
- **CUPED-adjusted incremental $/treated invoice (point):** $1 (SE $1)
- **mSPRT lower bound $/treated invoice:** $0
- **Proven lower-bound dollars (cum):** $0
- **Would it bill?** no (lower bound not yet positive (lift unproven))
- CUPED variance reduction: 17.67% · SRM χ²=3.06

## Fairness — is any engine gain just a longer retry window?

The headline compares the engine to Stripe Smart Retries' **default** reach (~day 18). But a baseline can simply retry longer. This sweep runs the engine against baselines that reach further:

| Baseline reaches | Control recovery | Engine recovery | Δ (engine − baseline) |
|---|---|---|---|
| day 18 | 36.31% | 38.29% | 1.98 pp |
| day 28 | 44.75% | 38.29% | -6.46 pp |
| day 35 | 47.43% | 38.29% | -9.14 pp |

**Reading it honestly.** The engine only edges ahead of the *default* (short-reaching) baseline; against a baseline that retries as far as the engine does, the engine **loses**. So the apparent gain is a **window-length effect any baseline can copy**, not decline-specific intelligence. On recovery rate alone, in a world with no attempt cost, "retry everything for longer" beats the engine.

The engine's real case therefore cannot rest on raw recovery rate. It rests on what this backtest does NOT price: **per-attempt cost and card-network retry-cap fines** (a maximally-persistent baseline would breach network caps — which the guardrail prevents but recovery-rate ignores), and the **cross-merchant issuer flywheel** (the engine runs on cold features here). Proving that edge needs a cost/compliance-aware objective and a live holdout — not this metric.

## Where the difference comes from (by decline code)

| Decline code | Volume share | Control recovery | Treatment recovery | Δ |
|---|---|---|---|---|
| insufficient_funds | 34.50% | 46.33% | 56.71% | 10.38 pp |
| do_not_honor | 21.94% | 27.48% | 31.11% | 3.64 pp |
| expired_card | 12.12% | 14.84% | 0.00% | -14.84 pp |
| issuer_unavailable | 5.95% | 77.81% | 77.11% | -0.70 pp |
| processing_error | 4.97% | 71.43% | 70.11% | -1.32 pp |
| try_again_later | 4.09% | 70.27% | 67.73% | -2.54 pp |
| authentication_required | 4.04% | 25.11% | 1.60% | -23.52 pp |
| lost_card | 3.21% | 0.59% | 0.00% | -0.59 pp |
| velocity_limit_exceeded | 3.01% | 32.70% | 26.65% | -6.05 pp |
| stolen_card | 2.09% | 0.00% | 0.00% | 0.00 pp |
| closed_account | 2.02% | 0.00% | 0.00% | 0.00 pp |
| invalid_card | 1.55% | 1.87% | 0.00% | -1.87 pp |

**Mechanism (why the engine underperforms *here*).** The deficit spans every recoverable decline code and has a single cause: the engine acts too **early** and stops too **soon**. Its ARSE schedule is front-loaded with no attempt after ~day 11 (insufficient-funds ~day 11, do-not-honor ~day 7.5, transient issuer errors clustered in the first hours), while this world's recovery onsets extend to 2–4 weeks — monthly paydays, ~3-week card reissue, diffuse do-not-honor — and even "transient" issuer errors clear over ~a day. The baseline's four blanket retries reach day 18, covering the back half of every window the engine never revisits: it wins on insufficient-funds (later paydays), do-not-honor, the immediate-onset issuer codes (its day-1 attempt lands *after* onset; the engine's sub-hour cluster often fires *before* it), and even expired cards (a day-18 retry with Account Updater recovers ~15% of them; the engine's day-0 card-update comm lands weeks before the reissue and recovers ~0). Only lost/stolen/closed cards are a true wash. In a recovery-rate-only world with no attempt cost, reaching later beats acting early-and-selectively.

## Validity checks

**A/A test (engine vs itself):** PASS — Δrate 0.65 pp, lower bound $0, billable false. The estimator does not manufacture lift where there is none.

**Power curve** — minimum invoices to detect a given true lift (α=0.05, world amount variance + clustering):

| True lift | Min invoices to a positive lower bound | Control customers at detection |
|---|---|---|
| 1 pp | > 200k (not reached) | — |
| 3 pp | 88,133 | 6311 |
| 5 pp | 44,228 | 3123 |
| 10 pp | 11,013 | 732 |

This is the **minimum viable merchant size** for billing: a merchant whose monthly failed-payment volume is below the row for the lift we actually deliver can never be billed under "unproven months bill $0."

**Sensitivity sweep (±30% on each world parameter):**

| Parameter | ×0.7 Δrate | ×0.7 lower$ | ×1.3 Δrate | ×1.3 lower$ |
|---|---|---|---|---|
| recoverableScale | 1.11 pp | $0 | 2.40 pp | $0 |
| onsetScale | -4.87 pp | $0 | 3.73 pp | $0 |
| windowScale | -7.97 pp | $0 | 1.57 pp | $0 |
| residualScale | 0.15 pp | $0 | 1.29 pp | $0 |
| nsfShareScale | 0.23 pp | $0 | 2.30 pp | $0 |

Sign of the lift is **NOT stable** across the sweep. A result whose sign flips under a ±30% parameter change is fragile — treat the headline as indicative only.

## Assumptions & Limitations (read before trusting any number)

- **Synthetic world.** Every recovery dynamic is modeled, not observed. Parameters are in `src/world/sources.ts`, each tagged `GROUNDED:` (qualitative real basis) or `ASSUMPTION:` (a plain conservative guess, no verified public figure). No precise statistic is attributed to a named company.
- **Same-author caveat.** The world model and the engine were written by the same author; true blind separation is impossible here. Mitigations: the world was written before the engine policy was wired in and derived independently of the engine's own numbers; the A/A test guards the estimator; the sensitivity sweep guards against a world tuned to flatter the engine.
- **Smart Retries is modeled, not exact.** Stripe's ML-selected retry times and attempt count are not public; the baseline is a strong, decline-agnostic 4-attempt schedule (days 1/4/10/18) meant to be a fair opponent, not a strawman. If the real Smart Retries times differ, the comparison shifts.
- **Engine features are cold.** A backtest has no customer history, so the engine runs on neutral priors (tenure/prior-recovery/issuer). Its production edge from the cross-merchant issuer flywheel is NOT exercised here — this understates the engine.
- **No cost of wasted attempts.** Recovery rate ignores per-attempt cost and network-cap fines; the engine's suppression advantage (not burning attempts on dead credentials) does not show up in recovery rate, only in cost — which this backtest does not price. A cost-aware objective would narrow the gap; it would not, on this evidence, reverse it (the deficit is soft/gray *timing*, not wasted attempts).
- **Card-update comms modeled as instantaneous.** A `card_update` action is adjudicated at its action day, so the engine's day-0 comm lands weeks before the ~3-week reissue and recovers ~0 of expired cards, while the baseline's day-18 retry (Account Updater) recovers ~15%. Modeling the comm's effect at the reissue day would win the engine back some expired volume (~12% of the book) — a few points — but would NOT reverse the sign, which is driven by soft/gray timing on the ~56% insufficient-funds + do-not-honor majority.
- **Independent per-attempt success draws** within the recoverable window; a policy is rewarded for placing attempts in-window, not for raw frequency (out-of-window attempts fail).
- **One epoch, one merchant, card-only.** No multi-epoch dynamics, no bank debit, no MoR.

## Reproduce

```bash
corepack pnpm --filter @ax10m/backtest run backtest
```
Deterministic: the same seeds reproduce `results.json` byte-for-byte. See `results.json` for all seeds and parameters.
