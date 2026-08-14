/**
 * Decline-Code Intelligence — the classifier at the heart of the recovery brain.
 *
 * Every processor speaks a different decline dialect; AX10M's POAL adapters normalize
 * them into ONE canonical taxonomy (`@ax10m/canonical` DeclineCode) — that canonical
 * taxonomy IS the "global cross-processor decline map", and this module is the
 * intelligence layer on top of it: given a canonical code it answers *what kind of
 * failure is this, is it worth retrying, and what should we do instead*.
 *
 * This is deliberately processor-agnostic. The raw→canonical mapping lives in each
 * adapter (so a new processor is one small map, not a change here); the strategy,
 * sequencing, and prediction all key off the canonical code so they work identically
 * across Stripe, Adyen, PayPal, Worldpay, Chargebee, Zuora, and every other connector.
 */

import { DeclineCode, DeclineFamily, familyOf, isRetriable } from '@ax10m/canonical';

/** What AX10M should do about a decline, independent of timing. */
export type RecommendedAction = 'retry' | 'card_update' | 'suppress';

export interface DeclineClassification {
  code: DeclineCode;
  family: DeclineFamily;
  /** Taxonomy-level retriability (the guardrail still has the final say on caps/quiet-hours). */
  retriable: boolean;
  recommendedAction: RecommendedAction;
  /** One-line human explanation for dashboards / audit. */
  description: string;
}

const DESCRIPTIONS: Readonly<Record<DeclineCode, string>> = {
  [DeclineCode.InsufficientFunds]: 'No funds now — recovers on a well-timed retry (payday proximity matters most).',
  [DeclineCode.IssuerUnavailable]: 'Issuer temporarily unreachable — a quick retry usually clears it.',
  [DeclineCode.ProcessingError]: 'Transient processing error — retry shortly.',
  [DeclineCode.VelocityLimitExceeded]: 'Issuer velocity/limit tripped — retry after a cooldown.',
  [DeclineCode.AuthenticationRequired]: 'Needs cardholder authentication (3DS/SCA) — retry via an authenticated flow.',
  [DeclineCode.TryAgainLater]: 'Issuer asked to retry later — back off then retry.',
  [DeclineCode.LostCard]: 'Card reported lost — dead credential; get a new card, do not retry.',
  [DeclineCode.StolenCard]: 'Card reported stolen — dead credential; get a new card, do not retry.',
  [DeclineCode.ClosedAccount]: 'Account closed — dead credential; needs a new payment method.',
  [DeclineCode.InvalidCard]: 'Card details invalid — needs a corrected/new card.',
  [DeclineCode.PickupCard]: 'Issuer pickup request — do not retry; new credential required.',
  [DeclineCode.CardNotSupported]: 'Card type/feature not supported — needs an alternate method.',
  [DeclineCode.RevocationOfAuthorization]: 'Cardholder revoked authorization — do not retry; re-consent + new mandate.',
  [DeclineCode.DoNotHonor]: 'Generic issuer refusal (ISO 05) — the gray zone; the model + issuer prior decide.',
  [DeclineCode.Fraudulent]: 'Flagged as fraud — never retry (network-penalty risk); investigate.',
  [DeclineCode.ExpiredCard]: 'Card expired — a same-card retry is pointless; route to a card update.',
  [DeclineCode.Unknown]: 'Unmapped reason — let the recoverability model decide.',
};

/** Classify a canonical decline code into family, retriability, and the recommended action. */
export function classifyDecline(code: DeclineCode): DeclineClassification {
  const family = familyOf(code);
  const retriable = isRetriable(code);

  let recommendedAction: RecommendedAction;
  if (code === DeclineCode.Fraudulent) {
    recommendedAction = 'suppress'; // retrying fraud is exactly the network penalty we prevent
  } else if (code === DeclineCode.ExpiredCard || family === DeclineFamily.Hard) {
    recommendedAction = 'card_update'; // dead credential → get a working one, don't burn attempts
  } else {
    recommendedAction = 'retry'; // soft + gray(retriable): worth a timed attempt
  }

  return { code, family, retriable, recommendedAction, description: DESCRIPTIONS[code] };
}

/** The full canonical taxonomy, classified — the single source every processor maps into. */
export function describeCanonicalTaxonomy(): DeclineClassification[] {
  return Object.values(DeclineCode).map((c) => classifyDecline(c));
}

/**
 * A raw processor decline code normalized + classified. The `normalize` fn is the
 * adapter's own decline-map (e.g. `mapStripeDeclineCode`), so this stays the one place
 * that turns "processor X said Y" into full canonical intelligence without duplicating
 * any adapter's mapping table.
 */
export function classifyRaw(rawCode: string | null | undefined, normalize: (raw: string | null | undefined) => DeclineCode): DeclineClassification {
  return classifyDecline(normalize(rawCode));
}
