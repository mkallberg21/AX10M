/**
 * WooCommerce (underlying-gateway) failure string → canonical decline mapping,
 * plus WooCommerce webhook HMAC verification.
 *
 * WooCommerce itself has no normalized decline taxonomy: a failed renewal order
 * carries a free-text gateway note / `failure_code` produced by whichever payment
 * plugin (WooCommerce Payments, Stripe, etc.) attempted the charge. We therefore map
 * on message KEYWORDS (substring match, case-insensitive), in priority order, the
 * same shape as the Elavon adapter's free-text mapping. Unmatched strings fall back
 * to `Unknown` (family: gray) so the recoverability model decides rather than a guess.
 *
 * Webhooks are authenticated with the `X-WC-Webhook-Signature` header: the base64
 * HMAC-SHA256 of the RAW request body keyed by the store's webhook secret. We verify
 * it in constant time and FAIL CLOSED (throw) when no secret is configured.
 *
 * Reference: WooCommerce REST webhook signing + common gateway decline strings
 * (confirm against the store's installed payment plugin).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeclineCode } from '@ax10m/canonical';

/** Keyword → canonical decline, checked in order (first substring match wins). */
const WOO_KEYWORD_MAP: ReadonlyArray<readonly [string, DeclineCode]> = [
  ['insufficient', DeclineCode.InsufficientFunds],
  ['expired', DeclineCode.ExpiredCard],
  ['do not honor', DeclineCode.DoNotHonor],
  ['do not honour', DeclineCode.DoNotHonor],
  ['lost', DeclineCode.LostCard],
  ['stolen', DeclineCode.StolenCard],
  ['invalid', DeclineCode.InvalidCard],
  // Generic "declined" is the gray-zone catch — checked AFTER the specific hard/soft
  // keywords so "card declined - insufficient funds" maps to InsufficientFunds.
  ['declined', DeclineCode.DoNotHonor],
];

/** Map a raw WooCommerce/gateway failure string to a canonical decline code. */
export function mapWooDeclineCode(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  const s = raw.trim().toLowerCase();
  for (const [keyword, code] of WOO_KEYWORD_MAP) {
    if (s.includes(keyword)) return code;
  }
  return DeclineCode.Unknown;
}

/** Compute the WooCommerce webhook signature: base64 HMAC-SHA256(secret, rawBody). */
export function computeWooSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

/** Constant-time verification of the `X-WC-Webhook-Signature` header. */
export function verifyWooSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = computeWooSignature(rawBody, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
