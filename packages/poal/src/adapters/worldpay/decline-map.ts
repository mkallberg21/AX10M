/**
 * Worldpay → canonical decline-code mapping.
 *
 * Access Worldpay surfaces a refused payment via `refusalCode` (the ISO-8583
 * response code, e.g. "51" Insufficient Funds) and a human-readable
 * `refusalDescription`. We match on the numeric code first, then fall back to
 * substring rules over the description; unmapped refusals fall back to `Unknown`
 * (family: gray) so the recoverability model decides rather than a guess.
 *
 * Reference: Worldpay refusal (ISO-8583 response) codes + description strings.
 */

import { DeclineCode } from '@ax10m/canonical';

/** Exact ISO-8583 refusal codes Worldpay returns in `refusalCode`. */
const WORLDPAY_REFUSAL_CODES: Readonly<Record<string, DeclineCode>> = {
  '01': DeclineCode.DoNotHonor, // Refer to card issuer
  '02': DeclineCode.DoNotHonor, // Refer to card issuer, special condition
  '04': DeclineCode.PickupCard, // Pick up card
  '05': DeclineCode.DoNotHonor, // Do not honor
  '12': DeclineCode.InvalidCard, // Invalid transaction
  '13': DeclineCode.ProcessingError, // Invalid amount
  '14': DeclineCode.InvalidCard, // Invalid card number
  '15': DeclineCode.InvalidCard, // No such issuer
  '30': DeclineCode.ProcessingError, // Format error
  '41': DeclineCode.LostCard, // Lost card
  '43': DeclineCode.StolenCard, // Stolen card
  '51': DeclineCode.InsufficientFunds, // Insufficient funds
  '54': DeclineCode.ExpiredCard, // Expired card
  '57': DeclineCode.CardNotSupported, // Transaction not permitted to cardholder
  '58': DeclineCode.CardNotSupported, // Transaction not permitted to terminal
  '59': DeclineCode.Fraudulent, // Suspected fraud
  '61': DeclineCode.VelocityLimitExceeded, // Exceeds withdrawal amount limit
  '62': DeclineCode.CardNotSupported, // Restricted card
  '65': DeclineCode.VelocityLimitExceeded, // Exceeds withdrawal count limit
  '75': DeclineCode.InvalidCard, // Allowable PIN tries exceeded
  '78': DeclineCode.InvalidCard, // No account / not effective
  '91': DeclineCode.IssuerUnavailable, // Issuer or switch inoperative
  '96': DeclineCode.ProcessingError, // System malfunction
};

/** Ordered substring rules — specific first — matched against the lowercased description. */
const WORLDPAY_DESCRIPTION_RULES: ReadonlyArray<readonly [string, DeclineCode]> = [
  ['insufficient funds', DeclineCode.InsufficientFunds],
  ['expired', DeclineCode.ExpiredCard],
  ['lost card', DeclineCode.LostCard],
  ['stolen card', DeclineCode.StolenCard],
  ['pick up card', DeclineCode.PickupCard],
  ['pickup card', DeclineCode.PickupCard],
  ['do not honor', DeclineCode.DoNotHonor],
  ['do not honour', DeclineCode.DoNotHonor],
  ['refer to card issuer', DeclineCode.DoNotHonor],
  ['invalid card number', DeclineCode.InvalidCard],
  ['invalid card', DeclineCode.InvalidCard],
  ['invalid transaction', DeclineCode.InvalidCard],
  ['not permitted', DeclineCode.CardNotSupported],
  ['restricted card', DeclineCode.CardNotSupported],
  ['suspected fraud', DeclineCode.Fraudulent],
  ['fraud', DeclineCode.Fraudulent],
  ['exceeds', DeclineCode.VelocityLimitExceeded],
  ['issuer', DeclineCode.IssuerUnavailable],
  ['system malfunction', DeclineCode.ProcessingError],
];

/** Map a raw Worldpay refusal code and/or description to a canonical decline code. */
export function mapWorldpayRefusal(code: string | null | undefined, description?: string | null): DeclineCode {
  if (code) {
    // Normalize to a zero-padded 2-digit ISO code when the value is purely numeric.
    const trimmed = code.trim();
    const key = /^\d$/.test(trimmed) ? `0${trimmed}` : trimmed;
    const mapped = WORLDPAY_REFUSAL_CODES[key] ?? WORLDPAY_REFUSAL_CODES[trimmed];
    if (mapped) return mapped;
  }
  if (description) {
    const s = description.trim().toLowerCase();
    for (const [needle, mapped] of WORLDPAY_DESCRIPTION_RULES) {
      if (s.includes(needle)) return mapped;
    }
  }
  return DeclineCode.Unknown;
}
