/**
 * Zuora → canonical decline-code mapping + Callout webhook signature verification.
 *
 * Zuora surfaces a gateway decline via `gatewayResponse` (free text) and
 * `gatewayResponseCode` (the raw acquirer code) on a Payment left in an `Error`
 * status. There is no normalized decline enum, so — like the other gateway maps — we
 * match on keywords in the response text. Unmapped reasons fall back to `Unknown`
 * (family: gray) so the recoverability model decides rather than a guess.
 *
 * Callout webhooks are authenticated with a `Zuora-Signature` header: hex HMAC-SHA256
 * of the raw request body keyed by the configured shared secret. We verify it in
 * constant time.
 *
 * Coverage MUST be confirmed against the live API version — the mapping/verify
 * MECHANISM is the deliverable, not the exhaustiveness.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeclineCode } from '@ax10m/canonical';

/** Ordered substring rules — specific first — matched against the lowercased response. */
const ZUORA_DECLINE_RULES: ReadonlyArray<readonly [string, DeclineCode]> = [
  ['insufficient', DeclineCode.InsufficientFunds],
  ['expired', DeclineCode.ExpiredCard],
  ['lost', DeclineCode.LostCard],
  ['stolen', DeclineCode.StolenCard],
  ['pick up', DeclineCode.PickupCard],
  ['pickup', DeclineCode.PickupCard],
  ['do not honor', DeclineCode.DoNotHonor],
  ['do not honour', DeclineCode.DoNotHonor],
  ['declined', DeclineCode.DoNotHonor],
  ['invalid', DeclineCode.InvalidCard],
];

/** Map a raw Zuora gateway response code / text to a canonical decline code. */
export function mapZuoraDeclineCode(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  const s = raw.trim().toLowerCase();
  for (const [needle, code] of ZUORA_DECLINE_RULES) {
    if (s.includes(needle)) return code;
  }
  return DeclineCode.Unknown;
}

/** Compute the Zuora Callout signature: HMAC-SHA256(secret, rawBody), hex. */
export function computeZuoraSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Constant-time verification of the `Zuora-Signature` header. */
export function verifyZuoraSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = computeZuoraSignature(rawBody, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
