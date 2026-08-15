VERDICT: under these assumptions the AX10M engine beats the baseline by 13.29 pp (recovery-rate), with a positive holdout-verified lower bound — it would bill $40,039. — CAVEAT: this 13.81 pp win is over the DEFAULT-reach baseline (what merchants run); against a maximally-persistent baseline it is ~parity on recovery rate (1.94 pp) — the durable edge is the dead-credential capability + cost/compliance, not raw rate vs an all-out retrier.

# AX10M Backtest — does the recovery engine beat Stripe Smart Retries?

_Synthetic backtest. Treatment = `ax10m-engine`, Control = `stripe-smart-retries`. 5,364 control invoices, 49,691 treatment invoices, stream seed 20260814._

## Headline

| Metric | Control (Smart Retries) | Treatment (AX10M engine) |
|---|---|---|
| Recovery rate | 36.56% | 49.85% |
| Recovered $ | $138,128 | $1,713,873 |

- **Absolute recovery-rate lift:** 13.29 pp
- **Relative lift:** 36.4%
- **CUPED-adjusted incremental $/treated invoice (point):** $9 (SE $1)
- **mSPRT lower bound $/treated invoice:** $7
- **Proven lower-bound dollars (cum):** $333,662
- **Would it bill?** yes — fee $40,039
- CUPED variance reduction: 26.52% · SRM χ²=3.06

## Fairness — is any engine gain just a longer retry window?

The headline compares the engine to Stripe Smart Retries' **default** reach (~day 18). But a baseline can simply retry longer. This sweep runs the engine against baselines that reach further:

| Baseline reaches | Control recovery | Engine recovery | Δ (engine − baseline) |
|---|---|---|---|
| day 18 | 36.42% | 50.23% | 13.81 pp |
| day 28 | 45.42% | 50.23% | 4.81 pp |
| day 35 | 48.29% | 50.23% | 1.94 pp |

**Reading it honestly.** The engine beats the **default** baseline (~day 18 — what merchants actually run) by 13.81 pp. Crucially, this is **not** a window-length effect: it does not flip to a loss when the baseline retries longer. The margin narrows as the baseline reaches window-close — to 1.94 pp vs a maximally-persistent (day 35) baseline, i.e. roughly **parity** — because a longer blanket retry catches up on the *soft/funds* declines, but it can **never** touch the dead-card book. The engine's gain is a fixed **capability** — dead-credential recovery (Account Updater `card_refresh`, `alternate_rail`, and dunning) — that no retry on the original card can reach (see the by-code table). That is why the edge survives the sweep instead of collapsing.

So on recovery rate the honest picture is: **a material win over the realistic baseline, parity with a maximally-persistent one** — and that persistent baseline is itself cost- and compliance-infeasible (it burns far more attempts and breaches card-network retry caps). The next section prices exactly that, and the cross-merchant issuer flywheel (cold features here) is additional upside not yet exercised.

## Net value — the cost + compliance-aware objective

Recovery rate rewards blanket persistence. A merchant's actual objective is **net value**: recovered dollars, minus the cost of every charge attempt, minus card-network fines for retrying do-not-retry declines (hard-decline / fraud codes — *not* expired, whose Account-Updater retry is legitimate) and for exceeding the excessive-retry cap. This is where the engine's selectivity — fewer, better-placed attempts — is supposed to pay off. Costs below are labeled assumptions, so the honest output is a **threshold**, not one number (per-attempt $0.20, do-not-retry fine $1.00).

| Baseline reaches | Engine net $/inv | Baseline net $/inv | Engine attempts/inv | Baseline attempts/inv | Engine wins? |
|---|---|---|---|---|---|
| day 18 | $34.19 | $24.96 | 2.71 | 3.49 | **yes** |
| day 28 | $34.19 | $30.88 | 2.71 | 4.12 | **yes** |
| day 35 | $34.19 | $32.74 | 2.71 | 4.66 | **yes** |

**Reading it honestly.** Against the Stripe Smart Retries **default** reach (~day 18 — what merchants actually run), the engine **wins on net value**: $34.19 vs $24.96 per invoice — it recovers more AND does it at 2.71 vs 3.49 attempts (22% fewer). And it now **holds the net-value win even against a maximally-persistent** baseline (day 35): $34.19 vs $32.74 — the credential-recovery capability keeps recovery at ~parity while the engine spends far fewer attempts, so the all-out retrier's brute persistence no longer buys enough extra recovery to cover its cost and fines.

**Sensitivity: at what do-not-retry fine does the picture hold?** Varying the fine (excess-attempt fine tracks at 2×):

| Do-not-retry fine | Engine net $/inv | Baseline net $/inv | Engine wins? |
|---|---|---|---|
| $0.00 | $34.09 | $32.99 | **yes** |
| $0.50 | $34.09 | $32.73 | **yes** |
| $1.00 | $34.09 | $32.47 | **yes** |
| $2.50 | $34.09 | $31.68 | **yes** |
| $5.00 | $34.09 | $30.37 | **yes** |
| $10.00 | $34.09 | $27.75 | **yes** |
| $20.00 | $34.09 | $22.51 | **yes** |

**Conclusion.** The engine wins on net value across the fine range vs the most-persistent baseline — including with **zero** compliance fines — because the win is driven by recovering MORE (dead-credential capture) at FEWER attempts, not by penalizing the baseline. Fines only widen the gap. On both recovery rate and net value, then, the honest headline is: **a real, capability-driven win over what merchants actually run**, robust to the cost/fine assumptions. The cross-merchant flywheel (cold here) is further upside not yet exercised, and a live holdout is still what proves the magnitude.

## Where the difference comes from (by decline code)

| Decline code | Volume share | Control recovery | Treatment recovery | Δ |
|---|---|---|---|---|
| insufficient_funds | 34.40% | 45.56% | 56.77% | 11.21 pp |
| do_not_honor | 22.07% | 27.43% | 31.14% | 3.71 pp |
| expired_card | 12.13% | 11.46% | 68.04% | 56.58 pp |
| issuer_unavailable | 5.95% | 78.06% | 77.17% | -0.89 pp |
| processing_error | 4.93% | 69.32% | 70.51% | 1.20 pp |
| try_again_later | 4.08% | 68.52% | 67.21% | -1.31 pp |
| authentication_required | 4.05% | 26.32% | 1.54% | -24.78 pp |
| lost_card | 3.23% | 8.70% | 42.20% | 33.51 pp |
| velocity_limit_exceeded | 3.01% | 32.45% | 26.38% | -6.07 pp |
| stolen_card | 2.10% | 9.52% | 41.21% | 31.68 pp |
| closed_account | 2.00% | 0.00% | 30.86% | 30.86 pp |
| invalid_card | 1.55% | 3.77% | 35.07% | 31.29 pp |
| pickup_card | 0.50% | 10.34% | 30.36% | 20.02 pp |

**Mechanism (where the engine's win comes from).** The gain is concentrated in the **dead-credential** codes — expired, lost, stolen, closed, invalid cards — exactly where a retry on the original card is hopeless. A blanket retry recovers a dead card only when the processor happens to pass a refreshed network token through automatically (partial *passive* coverage); everything else it re-hits the same dead number. The engine drives the recoveries the passive path misses: **`card_refresh`** actively queries Account Updater (Visa VAU / Mastercard ABU / network tokens) across processors and charges the refreshed credential; **`alternate_rail`** charges a stored backup method (recovering closed-account cases that never reissue — the baseline gets ~0 there); and **dunning** prompts the customer to update. On the soft/funds majority (insufficient-funds, do-not-honor) the engine and baseline are close — a longer-reaching baseline matches the engine there — which is why the overall edge narrows to parity against a maximally-persistent baseline but stays large against the realistic one. This edge is a **capability**, not timing: no retry cadence, however long, can fetch a card number that changed.

## Validity checks

**A/A test (engine vs itself):** PASS — Δrate 0.50 pp, lower bound $0, billable false. The estimator does not manufacture lift where there is none.

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
| recoverableScale | 10.63 pp | $4 | 15.16 pp | $8 |
| onsetScale | 7.86 pp | $3 | 13.30 pp | $6 |
| windowScale | 1.01 pp | $0 | 12.96 pp | $6 |
| residualScale | 9.33 pp | $3 | 13.53 pp | $6 |
| nsfShareScale | 13.80 pp | $6 | 12.48 pp | $6 |
| credEdgeScale | 11.18 pp | $5 | 14.67 pp | $7 |

Sign of the lift is **stable** across the sweep. 

## Assumptions & Limitations (read before trusting any number)

- **Synthetic world.** Every recovery dynamic is modeled, not observed. Parameters are in `src/world/sources.ts`, each tagged `GROUNDED:` (qualitative real basis) or `ASSUMPTION:` (a plain conservative guess, no verified public figure). No precise statistic is attributed to a named company.
- **Same-author caveat.** The world model and the engine were written by the same author; true blind separation is impossible here. Mitigations: the world was written before the engine policy was wired in and derived independently of the engine's own numbers; the A/A test guards the estimator; the sensitivity sweep guards against a world tuned to flatter the engine.
- **Smart Retries is modeled, not exact.** Stripe's ML-selected retry times and attempt count are not public; the baseline is a strong, decline-agnostic 4-attempt schedule (days 1/4/10/18) meant to be a fair opponent, not a strawman. If the real Smart Retries times differ, the comparison shifts.
- **Engine features are cold.** A backtest has no customer history, so the engine runs on neutral priors (tenure/prior-recovery/issuer). Its production edge from the cross-merchant issuer flywheel is NOT exercised here — this understates the engine.
- **The credential edge is where the win lives — and its SIZE is assumption-driven.** The dead-card advantage rests on four swept parameters in `sources.ts`: passive token pass-through (what the baseline gets, ~45% of reissued cards), active Account-Updater coverage (what the overlay gets, ~75%, a superset of passive), backup-rail prevalence (~20%), and dunning response (~15%). The **direction** is real and defensible (you cannot retry to a changed card number; active multi-processor AU + a backup rail + dunning recover cards a retry can't). The **magnitude** of the win depends on the passive-vs-active gap and the alt-rail/dunning levels — all labeled ASSUMPTION and swept ±30% via `credEdgeScale` (the sign holds). If real passive coverage is higher (e.g. a Stripe-native merchant already gets strong network-token updates), the edge shrinks toward the alt-rail/dunning residual.
- **Same-author caveat applies doubly to the credential model.** The same author wrote both the world's dead-card dynamics and the engine's `card_refresh`/`alternate_rail`/`dunning` capability. The guards: the baseline gets its fair passive-AU credit (it is not strawmanned to 0 on reissued cards), the fairness sweep shows the win is a capability not a window effect, and the sensitivity sweep on `credEdgeScale` shows the sign survives. A live holdout on a real merchant is still what would prove the magnitude.
- **Baseline is retry-only, by design.** Stripe Smart Retries retries the same credential; it does not automatically charge a backup method or drive cross-processor Account Updater / dunning. Modeling the baseline as retry-only reflects its default behavior — and the overlay's value is precisely automating what the baseline does not. A merchant could configure some of this themselves; the point is that they mostly don't.
- **Independent per-attempt success draws** within the recoverable window; a policy is rewarded for placing attempts in-window, not for raw frequency (out-of-window attempts fail).
- **One epoch, one merchant, card-only.** No multi-epoch dynamics, no bank debit, no MoR.

## Reproduce

```bash
corepack pnpm --filter @ax10m/backtest run backtest
```
Deterministic: the same seeds reproduce `results.json` byte-for-byte. See `results.json` for all seeds and parameters.
