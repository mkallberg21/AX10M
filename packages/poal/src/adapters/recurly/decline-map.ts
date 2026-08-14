/**
 * Recurly → canonical decline-code mapping.
 *
 * Recurly surfaces a failed collection via a `transaction_error` whose `code` /
 * `decline_code` is a normalized decline code (Recurly maps many raw gateway codes
 * onto its own set). We map the common ones onto AX10M's canonical taxonomy; unmapped
 * codes fall back to `Unknown` (family: gray) so the recoverability model decides
 * rather than a guess.
 *
 * Reference: Recurly transaction error / decline codes. Coverage MUST be confirmed
 * against the live API version — the mapping mechanism is the deliverable, not the
 * exhaustiveness.
 */

import { DeclineCode } from '@ax10m/canonical';

const RECURLY_DECLINE_MAP: Readonly<Record<string, DeclineCode>> = {
  // Soft (retriable)
  insufficient_funds: DeclineCode.InsufficientFunds,
  try_again_later: DeclineCode.TryAgainLater,
  authentication_required: DeclineCode.AuthenticationRequired,

  // Hard declines
  expired_card: DeclineCode.ExpiredCard,
  card_not_supported: DeclineCode.CardNotSupported,
  invalid_card: DeclineCode.InvalidCard,
  invalid_number: DeclineCode.InvalidCard,
  lost_card: DeclineCode.LostCard,
  stolen_card: DeclineCode.StolenCard,
  closed_account: DeclineCode.ClosedAccount,

  // Gray zone
  declined: DeclineCode.DoNotHonor,
  call_issuer: DeclineCode.DoNotHonor,
  fraud: DeclineCode.Fraudulent,
};

/** Map a raw Recurly transaction error / decline code to a canonical decline code. */
export function mapRecurlyDeclineCode(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  return RECURLY_DECLINE_MAP[raw.trim().toLowerCase()] ?? DeclineCode.Unknown;
}
