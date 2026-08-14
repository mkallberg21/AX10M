/**
 * Checkout.com → canonical decline-code mapping.
 *
 * Checkout surfaces a declined payment via `response_code` (a 4-5 digit string,
 * e.g. "20051" Insufficient Funds) plus a human-readable `response_summary`. The
 * numeric codes are largely the scheme/issuer response codes normalized onto
 * Checkout's "2xxxx" space. We map the common ones onto AX10M's canonical taxonomy;
 * unmapped codes fall back to `Unknown` (family: gray) so the recoverability model
 * decides rather than a guess.
 *
 * Reference: Checkout.com "Response codes" documentation.
 */

import { DeclineCode } from '@ax10m/canonical';

const CHECKOUT_DECLINE_MAP: Readonly<Record<string, DeclineCode>> = {
  // Insufficient funds
  '20051': DeclineCode.InsufficientFunds,

  // Invalid card / account
  '20005': DeclineCode.InvalidCard, // Declined - do not honour (invalid) / general
  '20014': DeclineCode.InvalidCard, // Invalid card number
  '20055': DeclineCode.InvalidCard, // Invalid PIN — non-recoverable via retry
  '20012': DeclineCode.InvalidCard, // Invalid transaction

  // Expired card
  '20054': DeclineCode.ExpiredCard, // Expired card

  // Revocation of authorization / stopped recurring
  '20001': DeclineCode.RevocationOfAuthorization, // Revocation of authorization order
  '20002': DeclineCode.RevocationOfAuthorization, // Revocation of all authorizations order

  // Pickup / lost / stolen
  '20004': DeclineCode.PickupCard, // Pick up card (no fraud)
  '20007': DeclineCode.PickupCard, // Pick up card - special conditions
  '20041': DeclineCode.LostCard, // Lost card
  '20042': DeclineCode.StolenCard, // No universal card / stolen
  '20059': DeclineCode.StolenCard, // Suspected fraud
  '20063': DeclineCode.StolenCard, // Security violation

  // Do-not-honor / gray zone
  '20006': DeclineCode.DoNotHonor, // Error
  '20046': DeclineCode.DoNotHonor, // Closed account -> treated as do-not-honor gray
  '20087': DeclineCode.DoNotHonor,

  // Fraud
  '20093': DeclineCode.Fraudulent, // Transaction cannot be completed; violation of law
  '40101': DeclineCode.Fraudulent, // Risk-blocked / fraud-flagged

  // Issuer / processing temporarily unavailable
  '20068': DeclineCode.IssuerUnavailable, // Response received too late / timeout
  '20091': DeclineCode.IssuerUnavailable, // Issuer or switch inoperative
  '30041': DeclineCode.ProcessingError, // System error

  // Velocity / limits
  '20061': DeclineCode.VelocityLimitExceeded, // Withdrawal amount limit exceeded
  '20065': DeclineCode.VelocityLimitExceeded, // Withdrawal count limit exceeded

  // Authentication
  '20150': DeclineCode.AuthenticationRequired, // Card not 3DS enrolled / auth required

  // Card not supported
  '20057': DeclineCode.CardNotSupported, // Transaction not permitted to cardholder
  '20058': DeclineCode.CardNotSupported, // Transaction not permitted to terminal
};

/** Map a raw Checkout.com `response_code` to a canonical decline code. */
export function mapCheckoutResponseCode(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  return CHECKOUT_DECLINE_MAP[raw.trim()] ?? DeclineCode.Unknown;
}
