/**
 * WORLD-MODEL PARAMETERS (Phase 1, Step A) — written BEFORE the treatment policy is
 * wired in, and derived independently of `@ax10m/recovery-engine`'s own numbers.
 *
 * HONESTY CONTRACT (read this):
 *  - There is no single authoritative public table for failed-payment recovery
 *    dynamics. Where a figure has a real qualitative basis in the payments literature
 *    it is tagged `GROUNDED:` with that basis. Where no verified public number exists,
 *    it is tagged `ASSUMPTION:` and is a deliberately plain, conservative guess.
 *  - We do NOT attribute invented precise percentages to named companies. "Grounded"
 *    means the DIRECTION/SHAPE is supported by widely-published guidance (Stripe /
 *    Recurly / Chargebee dunning docs, card-network Account Updater material, ISO 8583
 *    reason-code semantics), not that the exact number is quoted from a source.
 *  - Every number here is swept ±30% by the sensitivity analysis. A result that only
 *    survives at one setting is reported as fragile.
 *  - LIMITATION: the same author wrote this world model and the engine under test.
 *    True blind separation is impossible here; the A/A test guards the estimator and
 *    the sensitivity sweep guards against a world tuned to flatter the engine. This is
 *    stated again in report.md.
 */

import { DeclineCode, type IssuerRegion } from '@ax10m/canonical';

/**
 * Share of failed-payment attempts by canonical decline code.
 * GROUNDED (shape): dunning literature consistently reports that soft declines —
 * dominated by insufficient funds and the generic "do not honor" (ISO 8583 code 05) —
 * make up the majority of recoverable failures, expired cards are a meaningful
 * minority, and hard declines (lost/stolen/closed) are a small tail.
 * ASSUMPTION (exact split): the specific fractions below are a plain estimate, swept.
 */
export const DECLINE_MIX: ReadonlyArray<{ code: DeclineCode; share: number }> = [
  { code: DeclineCode.InsufficientFunds, share: 0.34 },
  { code: DeclineCode.DoNotHonor, share: 0.22 },
  { code: DeclineCode.ExpiredCard, share: 0.12 },
  { code: DeclineCode.IssuerUnavailable, share: 0.06 },
  { code: DeclineCode.ProcessingError, share: 0.05 },
  { code: DeclineCode.TryAgainLater, share: 0.04 },
  { code: DeclineCode.VelocityLimitExceeded, share: 0.03 },
  { code: DeclineCode.AuthenticationRequired, share: 0.04 },
  { code: DeclineCode.LostCard, share: 0.03 },
  { code: DeclineCode.StolenCard, share: 0.02 },
  { code: DeclineCode.ClosedAccount, share: 0.02 },
  { code: DeclineCode.InvalidCard, share: 0.015 },
  { code: DeclineCode.PickupCard, share: 0.005 },
];

/**
 * P(an invoice with this decline is EVER recoverable, given SOME action within the
 * dunning window). This caps the recovery rate any policy can achieve — timing only
 * decides how much of this ceiling a policy captures.
 * GROUNDED (ordering): transient issuer errors > NSF > do-not-honor > expired (needs a
 * new/updated credential) >> hard declines (dead credential, ~never on that card).
 * ASSUMPTION (levels): the numbers are conservative estimates, swept.
 */
export const BASE_RECOVERABLE: Readonly<Record<DeclineCode, number>> = {
  [DeclineCode.InsufficientFunds]: 0.62,
  [DeclineCode.DoNotHonor]: 0.34,
  [DeclineCode.IssuerUnavailable]: 0.78,
  [DeclineCode.ProcessingError]: 0.7,
  [DeclineCode.TryAgainLater]: 0.7,
  [DeclineCode.VelocityLimitExceeded]: 0.45,
  [DeclineCode.AuthenticationRequired]: 0.4,
  [DeclineCode.ExpiredCard]: 0.5, // only via a card update / Account Updater refresh
  [DeclineCode.LostCard]: 0.02,
  [DeclineCode.StolenCard]: 0.02,
  [DeclineCode.ClosedAccount]: 0.03,
  [DeclineCode.InvalidCard]: 0.05,
  [DeclineCode.PickupCard]: 0.02,
  [DeclineCode.CardNotSupported]: 0.05,
  [DeclineCode.RevocationOfAuthorization]: 0.05,
  [DeclineCode.Fraudulent]: 0.0,
  [DeclineCode.Unknown]: 0.3,
};

/**
 * Recovery ONSET timing: for a recoverable invoice, the day (post-decline) on which it
 * first becomes recoverable, modeled as a distribution per code. A recovery action
 * before onset fails; on/after onset (and before the window closes) it can succeed.
 * `kind`:
 *   'immediate'  — transient; recoverable within ~a day (GROUNDED: issuer-unavailable /
 *                  processing errors clear fast).
 *   'payday'     — NSF; recoverable when the balance replenishes, clustered around pay
 *                  cycles (GROUNDED: balances replenish on payday; bi-weekly & monthly
 *                  cycles dominate US consumers). Modeled as a mixture of 14d and 30d.
 *   'reissue'    — expired/dead card; recoverable only after a new card is issued /
 *                  Account Updater refreshes the token (GROUNDED: reissue takes weeks).
 *   'uniform'    — do-not-honor / velocity / auth: diffuse, issuer-dependent.
 * ASSUMPTION: the specific day parameters, swept.
 */
export type OnsetKind = 'immediate' | 'payday' | 'reissue' | 'uniform';
export const ONSET_KIND: Readonly<Record<DeclineCode, OnsetKind>> = {
  [DeclineCode.InsufficientFunds]: 'payday',
  [DeclineCode.DoNotHonor]: 'uniform',
  [DeclineCode.IssuerUnavailable]: 'immediate',
  [DeclineCode.ProcessingError]: 'immediate',
  [DeclineCode.TryAgainLater]: 'immediate',
  [DeclineCode.VelocityLimitExceeded]: 'uniform',
  [DeclineCode.AuthenticationRequired]: 'uniform',
  [DeclineCode.ExpiredCard]: 'reissue',
  [DeclineCode.LostCard]: 'reissue',
  [DeclineCode.StolenCard]: 'reissue',
  [DeclineCode.ClosedAccount]: 'reissue',
  [DeclineCode.InvalidCard]: 'reissue',
  [DeclineCode.PickupCard]: 'reissue',
  [DeclineCode.CardNotSupported]: 'reissue',
  [DeclineCode.RevocationOfAuthorization]: 'reissue',
  [DeclineCode.Fraudulent]: 'uniform',
  [DeclineCode.Unknown]: 'uniform',
};

/** ASSUMPTION (swept): onset distribution parameters, in days. */
export const ONSET_PARAMS = {
  immediateMaxDay: 1, // recoverable within a day
  paydayCycles: [14, 30] as const, // bi-weekly + monthly mixture
  paydayJitterSd: 2, // days of noise around the payday
  reissueMeanDay: 21, // ~3 weeks to a new/updated card
  reissueSd: 8,
  uniformLoDay: 1,
  uniformHiDay: 21,
};

/**
 * Dunning WINDOW close: after this many days the customer has churned / the
 * subscription lapses, and no action recovers the invoice.
 * GROUNDED (shape): dunning/retry windows are finite (typically a few weeks); recovery
 * probability decays to ~0 by the end. ASSUMPTION (exact length), swept.
 */
export const WINDOW_CLOSE_DAY = 35;

/**
 * Residual per-action success given the invoice is recoverable AND the action is well
 * timed (captures execution noise, soft-decline-on-retry, gateway hiccups).
 * ASSUMPTION (swept). Card-update actions are modeled slightly lower (a comm must be
 * acted on by the customer).
 */
export const RESIDUAL_SUCCESS_RETRY = 0.85;
export const RESIDUAL_SUCCESS_CARD_UPDATE = 0.75;

/**
 * Invoice amount distribution (minor units), lognormal. GROUNDED (shape): subscription
 * invoice amounts are right-skewed with a modest median. ASSUMPTION (params), swept.
 * muLog=8.6 → median ≈ $54.60; sigmaLog=0.7 → a realistic spread.
 */
export const AMOUNT_MU_LOG = 8.6;
export const AMOUNT_SIGMA_LOG = 0.7;

/** Issuer-region mix (for stratification only; does not drive recovery here). */
export const REGION_MIX: ReadonlyArray<{ region: IssuerRegion; share: number }> = [
  { region: 'na', share: 0.55 },
  { region: 'emea', share: 0.25 },
  { region: 'apac', share: 0.12 },
  { region: 'latam', share: 0.08 },
];

/**
 * Invoices per customer (a customer can have repeat failures within the epoch — this is
 * why the estimator clusters on customer). ASSUMPTION (swept): mostly 1, some repeats.
 */
export const INVOICES_PER_CUSTOMER_WEIGHTS = [0, 0.72, 0.2, 0.06, 0.02]; // index = count

// ─────────────────────────────────────────────────────────────────────────────
// DEAD-CREDENTIAL recovery dynamics — the structural edge an overlay has over a
// blanket retry. You cannot retry your way to a card number that changed; the
// recoveries come from Account Updater, a backup rail, or a customer-driven update.
// This is where "retry longer" (a window-length effect any baseline can copy) does
// NOT help, so a real win here survives the fairness sweep.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * P(a dead card is REISSUED / updated within the window) by code. GROUNDED (ordering):
 * expired cards are reissued as a matter of course; lost/stolen usually; closed accounts
 * rarely (there's no card to reissue). ASSUMPTION (levels), swept.
 */
export const REISSUE_RATE: Readonly<Partial<Record<DeclineCode, number>>> = {
  [DeclineCode.ExpiredCard]: 0.9,
  [DeclineCode.LostCard]: 0.6,
  [DeclineCode.StolenCard]: 0.55,
  [DeclineCode.InvalidCard]: 0.4,
  [DeclineCode.PickupCard]: 0.35,
  [DeclineCode.CardNotSupported]: 0.25,
  [DeclineCode.ClosedAccount]: 0.15, // closed → alt-rail / dunning are the real paths
  [DeclineCode.RevocationOfAuthorization]: 0.2,
};
export const DEFAULT_REISSUE_RATE = 0.4;

/**
 * PASSIVE network-token / Account-Updater pass-through: fraction of REISSUED cards a
 * PLAIN RETRY recovers with no explicit action — the BASELINE's only dead-card path (e.g.
 * a processor's built-in token refresh). GROUNDED (direction): passive tokenization
 * coverage is real but partial. ASSUMPTION (level), swept.
 */
export const PASSIVE_TOKEN_COVERAGE = 0.45;

/**
 * ACTIVE Account Updater across processors (the overlay's `card_refresh`): fraction of
 * REISSUED cards it recovers — HIGHER than passive and a SUPERSET of it (actively querying
 * VAU/ABU + network tokens on every processor beats any one processor's pass-through).
 * The overlay's edge on reissued cards is (ACTIVE − PASSIVE). GROUNDED (direction),
 * ASSUMPTION (level), swept.
 */
export const ACTIVE_AU_COVERAGE = 0.75;

/**
 * Prevalence of a usable stored BACKUP method (the overlay's `alternate_rail`) — recovers
 * dead cards, closed accounts included, that NO retry on the original card can. GROUNDED
 * (direction): a minority of subscribers have a second card/wallet on file. ASSUMPTION
 * (level), swept.
 */
export const ALT_RAIL_PREVALENCE = 0.2;

/**
 * Fraction who act on a dunning card-update prompt (`dunning`). GROUNDED (direction):
 * card-update email/SMS response is a modest single-digit-to-low-teens share. ASSUMPTION
 * (level), deliberately conservative, swept.
 */
export const DUNNING_RESPONSE = 0.15;

/** Onsets/residuals for the credential paths (days / per-action success). ASSUMPTION, swept. */
export const ALT_RAIL_ONSET_DAY = 1; // a backup method is available immediately
export const DUNNING_ONSET_DAY = 4; // the customer needs a few days to act
export const RESIDUAL_SUCCESS_ALT_RAIL = 0.9; // charging a known-good backup rail is reliable
export const RESIDUAL_SUCCESS_DUNNING = 0.8;
