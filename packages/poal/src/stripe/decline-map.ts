/**
 * Stripe → canonical decline-code mapping.
 *
 * Stripe surfaces failures via `charge.outcome` / `payment_intent` last error
 * with a `decline_code` (issuer reason) and/or `code`. We map the common issuer
 * decline codes onto AX10M's canonical taxonomy. Unmapped codes fall back to
 * `Unknown` (family: gray) so the recoverability model — not a guess — decides.
 *
 * Reference: https://stripe.com/docs/declines/codes
 */

import { DeclineCode } from '@ax10m/canonical';

const STRIPE_DECLINE_MAP: Readonly<Record<string, DeclineCode>> = {
  insufficient_funds: DeclineCode.InsufficientFunds,
  issuer_not_available: DeclineCode.IssuerUnavailable,
  processing_error: DeclineCode.ProcessingError,
  card_velocity_exceeded: DeclineCode.VelocityLimitExceeded,
  authentication_required: DeclineCode.AuthenticationRequired,
  try_again_later: DeclineCode.TryAgainLater,
  reenter_transaction: DeclineCode.TryAgainLater,

  lost_card: DeclineCode.LostCard,
  stolen_card: DeclineCode.StolenCard,
  closed_account: DeclineCode.ClosedAccount,
  invalid_account: DeclineCode.InvalidCard,
  invalid_number: DeclineCode.InvalidCard,
  pickup_card: DeclineCode.PickupCard,
  card_not_supported: DeclineCode.CardNotSupported,
  revocation_of_authorization: DeclineCode.RevocationOfAuthorization,

  do_not_honor: DeclineCode.DoNotHonor,
  fraudulent: DeclineCode.Fraudulent,
  merchant_blacklist: DeclineCode.Fraudulent,
  expired_card: DeclineCode.ExpiredCard,
};

/** Map a raw Stripe decline_code to a canonical code. */
export function mapStripeDeclineCode(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  return STRIPE_DECLINE_MAP[raw] ?? DeclineCode.Unknown;
}
