/**
 * PayPal → canonical decline-code mapping.
 *
 * NOTE: PayPal exposes a decline through several surfaces depending on the flow —
 * the Orders v2 error `details[].issue` (e.g. `INSTRUMENT_DECLINED`), the
 * `processor_response.response_code` (an ISO-8583 numeric like `51`), and webhook
 * `status_details.reason`. We map the common ones onto AX10M's canonical taxonomy;
 * unmapped reasons fall back to `Unknown` (family: gray) so the recoverability model
 * decides rather than a guess. Field/name coverage MUST be confirmed against the
 * live API version — the mapping mechanism is the deliverable, not the exhaustiveness.
 */

import { DeclineCode } from '@ax10m/canonical';

/** Exact PayPal issue names / processor response codes → canonical code (keys lowercased). */
const PAYPAL_DECLINE_MAP: Readonly<Record<string, DeclineCode>> = {
  // Generic issuer decline — PayPal's catch-all "the bank said no".
  instrument_declined: DeclineCode.DoNotHonor,
  transaction_refused: DeclineCode.DoNotHonor,
  card_refused: DeclineCode.DoNotHonor,
  declined: DeclineCode.DoNotHonor,
  do_not_honor: DeclineCode.DoNotHonor,
  '05': DeclineCode.DoNotHonor, // ISO-8583 do-not-honor

  // Insufficient funds
  insufficient_funds: DeclineCode.InsufficientFunds,
  '51': DeclineCode.InsufficientFunds,

  // Expired card (gray: retry is pointless, card-update recovers)
  expired_card: DeclineCode.ExpiredCard,
  card_expired: DeclineCode.ExpiredCard,
  '54': DeclineCode.ExpiredCard,

  // Closed / revoked account
  card_closed: DeclineCode.ClosedAccount,
  closed_account: DeclineCode.ClosedAccount,

  // 3DS / SCA / payer action
  authentication_required: DeclineCode.AuthenticationRequired,
  payer_action_required: DeclineCode.AuthenticationRequired,
  '3d_secure_required': DeclineCode.AuthenticationRequired,

  // Temporary — retry later
  try_again_later: DeclineCode.TryAgainLater,
  reattempt_transaction: DeclineCode.TryAgainLater,
  issuer_unavailable: DeclineCode.IssuerUnavailable,
};

/**
 * Map a raw PayPal decline reason (issue name and/or numeric processor code) to a
 * canonical decline code. Matches the exact key first, then falls back to a couple
 * of substring rules ("authentication", "declined"/"refused") for reason strings
 * that carry extra prose, and finally to `Unknown`.
 */
export function mapPaypalDeclineCode(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  const s = raw.trim().toLowerCase();
  const exact = PAYPAL_DECLINE_MAP[s];
  if (exact) return exact;
  // Substring fallbacks for prose-y reason strings.
  if (s.includes('authentication')) return DeclineCode.AuthenticationRequired;
  if (s.includes('insufficient')) return DeclineCode.InsufficientFunds;
  if (s.includes('expired')) return DeclineCode.ExpiredCard;
  if (s.includes('closed')) return DeclineCode.ClosedAccount;
  if (s.includes('declined') || s.includes('refused')) return DeclineCode.DoNotHonor;
  return DeclineCode.Unknown;
}
