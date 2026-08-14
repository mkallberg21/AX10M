/**
 * Decline taxonomy — the core control signal for the recovery engine.
 *
 * Declines fall into three families (ARCHITECTURE.md §2):
 *  - soft: retriable (insufficient funds, issuer temporarily unavailable, ...).
 *          → schedule an intelligent retry.
 *  - hard: NOT retriable (lost/stolen, closed account, invalid card, pickup).
 *          → suppress retries, go straight to card-update comms. Retrying these
 *            wastes attempts and triggers card-network penalties.
 *  - gray: issuer-and-context dependent ("do not honor", 05). The recoverability
 *          model earns its keep here.
 *
 * The codes below are AX10M-canonical decline codes. Processor adapters map their
 * native reason codes onto these; the decision core only ever sees canonical.
 */

export enum DeclineFamily {
  Soft = 'soft',
  Hard = 'hard',
  Gray = 'gray',
}

/**
 * Canonical decline codes. Deliberately processor-agnostic — adapters translate
 * Stripe `decline_code`, Adyen `refusalReason`, etc. into these.
 */
export enum DeclineCode {
  // --- Soft (retriable) ---
  InsufficientFunds = 'insufficient_funds',
  IssuerUnavailable = 'issuer_unavailable',
  ProcessingError = 'processing_error',
  VelocityLimitExceeded = 'velocity_limit_exceeded',
  AuthenticationRequired = 'authentication_required',
  TryAgainLater = 'try_again_later',

  // --- Hard (never retry) ---
  LostCard = 'lost_card',
  StolenCard = 'stolen_card',
  ClosedAccount = 'closed_account',
  InvalidCard = 'invalid_card',
  PickupCard = 'pickup_card',
  CardNotSupported = 'card_not_supported',
  RevocationOfAuthorization = 'revocation_of_authorization',

  // --- Gray (context-dependent) ---
  DoNotHonor = 'do_not_honor', // ISO 05 — the canonical gray-zone code
  Fraudulent = 'fraudulent',
  ExpiredCard = 'expired_card', // gray: retry is pointless, but card-update recovers

  // --- Fallback ---
  Unknown = 'unknown',
}

/** Static mapping from each canonical code to its family. */
const DECLINE_FAMILY: Readonly<Record<DeclineCode, DeclineFamily>> = {
  [DeclineCode.InsufficientFunds]: DeclineFamily.Soft,
  [DeclineCode.IssuerUnavailable]: DeclineFamily.Soft,
  [DeclineCode.ProcessingError]: DeclineFamily.Soft,
  [DeclineCode.VelocityLimitExceeded]: DeclineFamily.Soft,
  [DeclineCode.AuthenticationRequired]: DeclineFamily.Soft,
  [DeclineCode.TryAgainLater]: DeclineFamily.Soft,

  [DeclineCode.LostCard]: DeclineFamily.Hard,
  [DeclineCode.StolenCard]: DeclineFamily.Hard,
  [DeclineCode.ClosedAccount]: DeclineFamily.Hard,
  [DeclineCode.InvalidCard]: DeclineFamily.Hard,
  [DeclineCode.PickupCard]: DeclineFamily.Hard,
  [DeclineCode.CardNotSupported]: DeclineFamily.Hard,
  [DeclineCode.RevocationOfAuthorization]: DeclineFamily.Hard,

  [DeclineCode.DoNotHonor]: DeclineFamily.Gray,
  [DeclineCode.Fraudulent]: DeclineFamily.Gray,
  [DeclineCode.ExpiredCard]: DeclineFamily.Gray,

  [DeclineCode.Unknown]: DeclineFamily.Gray,
};

/** Return the decline family for a canonical decline code. */
export function familyOf(code: DeclineCode): DeclineFamily {
  return DECLINE_FAMILY[code];
}

/**
 * Whether a decline code is *eligible* for a network retry.
 *
 * NOTE: this is a taxonomy-level answer only ("is this code the kind of thing we
 * ever retry?"). It is NOT the final say — the compliance guardrail (@ax10m/guardrail)
 * still applies network attempt caps, quiet hours, consent, etc. and can suppress
 * a retry this function would allow. Hard declines are never retriable; gray-zone
 * codes are retriable in principle and handed to the recoverability model.
 */
export function isRetriable(code: DeclineCode): boolean {
  const family = familyOf(code);
  if (family === DeclineFamily.Hard) return false;
  // ExpiredCard is technically "gray" but a same-card retry is pointless — the
  // path to recovery is a card update, not a retry. Treat as non-retriable.
  if (code === DeclineCode.ExpiredCard) return false;
  // Fraudulent (gray for stratification) must never be retried — retrying a
  // fraud-flagged decline is exactly the network penalty the guardrail prevents.
  if (code === DeclineCode.Fraudulent) return false;
  return true;
}
