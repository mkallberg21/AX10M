/**
 * Elavon Converge → canonical decline-code mapping.
 *
 * Converge surfaces a decline via `ssl_result` (a non-zero numeric string) plus a
 * human-readable `ssl_result_message` that is largely the issuer's decline text
 * ("INSUFFICIENT FUNDS", "EXPIRED CARD", "PICK UP CARD", "DECLINE CVV2", ...).
 * There is no stable, granular numeric decline code across issuers, so we map
 * primarily on message keywords, with a small assist from the raw code. Unmapped
 * results fall back to `Unknown` (family: gray) so the recoverability model
 * decides rather than a guess.
 *
 * Reference: Converge Developer Guide `ssl_result` / `ssl_result_message`. Exact
 * issuer strings vary — confirm against the live integration before production.
 */

import { DeclineCode } from '@ax10m/canonical';

/** Ordered keyword → canonical code table. First substring match wins. */
const MESSAGE_KEYWORDS: ReadonlyArray<readonly [string, DeclineCode]> = [
  ['INSUFFICIENT FUNDS', DeclineCode.InsufficientFunds],
  ['NOT SUFFICIENT FUNDS', DeclineCode.InsufficientFunds],
  ['EXPIRED CARD', DeclineCode.ExpiredCard],
  ['EXPIRED', DeclineCode.ExpiredCard],
  ['PICK UP CARD', DeclineCode.PickupCard],
  ['PICKUP', DeclineCode.PickupCard],
  ['LOST', DeclineCode.LostCard],
  ['STOLEN', DeclineCode.StolenCard],
  ['CLOSED ACCOUNT', DeclineCode.ClosedAccount],
  ['NO ACCOUNT', DeclineCode.ClosedAccount],
  ['DO NOT HONOR', DeclineCode.DoNotHonor],
  ['DO NOT HONOUR', DeclineCode.DoNotHonor],
  ['FRAUD', DeclineCode.Fraudulent],
  ['SECURITY VIOLATION', DeclineCode.Fraudulent],
  ['INVALID', DeclineCode.InvalidCard],
  ['CARD NOT SUPPORTED', DeclineCode.CardNotSupported],
  ['NOT PERMITTED', DeclineCode.CardNotSupported],
  ['EXCEEDS', DeclineCode.VelocityLimitExceeded],
  ['VELOCITY', DeclineCode.VelocityLimitExceeded],
  ['ISSUER', DeclineCode.IssuerUnavailable],
  ['UNAVAILABLE', DeclineCode.IssuerUnavailable],
  ['TRY AGAIN', DeclineCode.TryAgainLater],
  ['REENTER', DeclineCode.TryAgainLater],
  ['DECLINE', DeclineCode.DoNotHonor],
];

/**
 * Map a Converge decline result to a canonical decline code.
 *
 * @param resultMessage `ssl_result_message` (issuer decline text).
 * @param code          `ssl_result` (non-zero numeric string), used only as a
 *                      weak assist since Converge's numeric codes are coarse.
 */
export function mapElavonDeclineCode(
  resultMessage?: string | null,
  code?: string | null,
): DeclineCode {
  const msg = (resultMessage ?? '').toUpperCase();
  for (const [keyword, mapped] of MESSAGE_KEYWORDS) {
    if (msg.includes(keyword)) return mapped;
  }
  // Converge does not expose a stable granular numeric taxonomy; a non-zero
  // ssl_result with no recognizable message is a generic decline.
  if (code && code !== '0') return DeclineCode.DoNotHonor;
  return DeclineCode.Unknown;
}
