/**
 * Chargebee → canonical decline-code mapping.
 *
 * Chargebee surfaces a failed transaction via `transaction.error_code` /
 * `error_text`, which are largely the underlying gateway's decline codes (Chargebee
 * normalizes many onto its own set). We map the common ones onto AX10M's canonical
 * taxonomy; unmapped codes fall back to `Unknown` (family: gray) so the
 * recoverability model decides rather than a guess.
 *
 * Reference: Chargebee transaction error codes + common gateway decline strings.
 */

import { DeclineCode } from '@ax10m/canonical';

const CHARGEBEE_DECLINE_MAP: Readonly<Record<string, DeclineCode>> = {
  // Insufficient funds
  insufficient_funds: DeclineCode.InsufficientFunds,
  'insufficient-funds': DeclineCode.InsufficientFunds,

  // Issuer / processor temporarily unavailable
  issuer_not_available: DeclineCode.IssuerUnavailable,
  issuer_unavailable: DeclineCode.IssuerUnavailable,
  processing_error: DeclineCode.ProcessingError,
  payment_gateway_currently_unreachable: DeclineCode.IssuerUnavailable,
  try_again_later: DeclineCode.TryAgainLater,
  reenter_transaction: DeclineCode.TryAgainLater,

  // Velocity / limits
  card_velocity_exceeded: DeclineCode.VelocityLimitExceeded,
  approve_with_id: DeclineCode.VelocityLimitExceeded,

  // 3DS / auth
  authentication_required: DeclineCode.AuthenticationRequired,
  three_d_secure_failure: DeclineCode.AuthenticationRequired,

  // Hard declines
  lost_card: DeclineCode.LostCard,
  stolen_card: DeclineCode.StolenCard,
  pickup_card: DeclineCode.PickupCard,
  closed_account: DeclineCode.ClosedAccount,
  invalid_account: DeclineCode.InvalidCard,
  invalid_number: DeclineCode.InvalidCard,
  invalid_card: DeclineCode.InvalidCard,
  no_such_issuer: DeclineCode.InvalidCard,
  card_not_supported: DeclineCode.CardNotSupported,
  currency_not_supported: DeclineCode.CardNotSupported,
  revocation_of_authorization: DeclineCode.RevocationOfAuthorization,
  revocation_of_all_authorizations: DeclineCode.RevocationOfAuthorization,

  // Gray zone
  do_not_honor: DeclineCode.DoNotHonor,
  card_declined: DeclineCode.DoNotHonor,
  fraudulent: DeclineCode.Fraudulent,
  fraudulent_transaction: DeclineCode.Fraudulent,
  merchant_blacklist: DeclineCode.Fraudulent,
  suspected_fraud: DeclineCode.Fraudulent,
  expired_card: DeclineCode.ExpiredCard,
  'expired-card': DeclineCode.ExpiredCard,
};

/** Map a raw Chargebee/gateway error code to a canonical decline code. */
export function mapChargebeeDeclineCode(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  return CHARGEBEE_DECLINE_MAP[raw.toLowerCase()] ?? DeclineCode.Unknown;
}
