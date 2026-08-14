/**
 * TSYS / Transaction Express → canonical decline-code mapping.
 *
 * Transaction Express returns an ISO-8583-derived `responseCode` on a declined
 * sale (e.g. '51' insufficient funds, '54' expired card, '05' do not honor) plus
 * a `responseMessage`. We map the common codes onto AX10M's canonical taxonomy,
 * with a message-keyword fallback for the cases where only the text is meaningful.
 * Unmapped codes fall back to `Unknown` (family: gray) so the recoverability model
 * decides rather than a guess.
 *
 * Reference: ISO-8583 response codes / TSYS Transaction Express response codes.
 * Exact code set varies by acquirer platform — confirm against the live boarding.
 */

import { DeclineCode } from '@ax10m/canonical';

const CODE_MAP: Readonly<Record<string, DeclineCode>> = {
  '51': DeclineCode.InsufficientFunds,
  '61': DeclineCode.VelocityLimitExceeded, // exceeds withdrawal amount limit
  '65': DeclineCode.VelocityLimitExceeded, // exceeds withdrawal frequency limit
  '54': DeclineCode.ExpiredCard,
  '41': DeclineCode.LostCard,
  '43': DeclineCode.StolenCard,
  '04': DeclineCode.PickupCard,
  '07': DeclineCode.PickupCard, // pick up card, special condition
  '05': DeclineCode.DoNotHonor,
  '14': DeclineCode.InvalidCard, // invalid card number
  '15': DeclineCode.InvalidCard, // no such issuer
  '78': DeclineCode.InvalidCard, // invalid/nonexistent account
  '57': DeclineCode.CardNotSupported, // transaction not permitted to cardholder
  '58': DeclineCode.CardNotSupported, // transaction not permitted to terminal
  '62': DeclineCode.CardNotSupported, // restricted card
  '59': DeclineCode.Fraudulent, // suspected fraud
  '63': DeclineCode.Fraudulent, // security violation
  '91': DeclineCode.IssuerUnavailable, // issuer or switch inoperative
  '96': DeclineCode.ProcessingError, // system malfunction
};

/** Ordered keyword → canonical code fallback when the numeric code is unmapped. */
const MESSAGE_KEYWORDS: ReadonlyArray<readonly [string, DeclineCode]> = [
  ['INSUFFICIENT', DeclineCode.InsufficientFunds],
  ['EXPIRED', DeclineCode.ExpiredCard],
  ['PICK UP', DeclineCode.PickupCard],
  ['PICKUP', DeclineCode.PickupCard],
  ['LOST', DeclineCode.LostCard],
  ['STOLEN', DeclineCode.StolenCard],
  ['DO NOT HONOR', DeclineCode.DoNotHonor],
  ['DO NOT HONOUR', DeclineCode.DoNotHonor],
  ['FRAUD', DeclineCode.Fraudulent],
  ['INVALID', DeclineCode.InvalidCard],
  ['NOT PERMITTED', DeclineCode.CardNotSupported],
  ['RESTRICTED', DeclineCode.CardNotSupported],
  ['EXCEEDS', DeclineCode.VelocityLimitExceeded],
  ['UNAVAILABLE', DeclineCode.IssuerUnavailable],
  ['INOPERATIVE', DeclineCode.IssuerUnavailable],
];

/**
 * Map a TSYS decline to a canonical decline code.
 *
 * @param responseCode    ISO-ish `responseCode` (preferred signal).
 * @param responseMessage `responseMessage` (keyword fallback).
 */
export function mapTsysDeclineCode(
  responseCode?: string | null,
  responseMessage?: string | null,
): DeclineCode {
  if (responseCode) {
    const mapped = CODE_MAP[responseCode.trim()];
    if (mapped) return mapped;
  }
  const msg = (responseMessage ?? '').toUpperCase();
  for (const [keyword, mapped] of MESSAGE_KEYWORDS) {
    if (msg.includes(keyword)) return mapped;
  }
  return DeclineCode.Unknown;
}
