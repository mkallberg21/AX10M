/**
 * Shopify SubscriptionBillingAttempt error code → canonical decline mapping,
 * plus Shopify webhook HMAC verification.
 *
 * A billing attempt that Shopify accepts but the gateway then rejects surfaces a
 * `SubscriptionBillingAttemptErrorCode` on the attempt (e.g. PAYMENT_METHOD_DECLINED,
 * INSUFFICIENT_FUNDS). These are Shopify's normalized codes, not the raw gateway
 * decline strings, so the map is small and enum-driven. Unmapped codes fall back to
 * `Unknown` (family: gray) so the recoverability model decides rather than a guess.
 *
 * Webhooks are authenticated with the `X-Shopify-Hmac-Sha256` header: the base64
 * HMAC-SHA256 of the RAW request body keyed by the app's API secret. We verify it in
 * constant time and FAIL CLOSED (throw) when no secret is configured.
 *
 * Reference: Shopify Admin GraphQL `SubscriptionBillingAttemptErrorCode` enum and
 * Shopify webhook HMAC verification (documented values; confirm against the pinned
 * API version).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeclineCode } from '@ax10m/canonical';

const SHOPIFY_DECLINE_MAP: Readonly<Record<string, DeclineCode>> = {
  // Gateway declined the stored method — gray zone (issuer/context dependent).
  payment_method_declined: DeclineCode.DoNotHonor,
  card_declined: DeclineCode.DoNotHonor,

  // Soft / retriable.
  insufficient_funds: DeclineCode.InsufficientFunds,

  // Expired / invalid credential — card-update path, not a retry.
  expired_payment_method: DeclineCode.ExpiredCard,
  invalid_payment_method: DeclineCode.InvalidCard,
  payment_method_not_found: DeclineCode.InvalidCard,

  // 3DS / SCA.
  authentication_error: DeclineCode.AuthenticationRequired,
};

/** Map a raw Shopify SubscriptionBillingAttemptErrorCode to a canonical decline code. */
export function mapShopifyDeclineCode(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  return SHOPIFY_DECLINE_MAP[raw.trim().toLowerCase()] ?? DeclineCode.Unknown;
}

/** Compute the Shopify webhook HMAC: base64 HMAC-SHA256(secret, rawBody). */
export function computeShopifyHmac(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

/** Constant-time verification of the `X-Shopify-Hmac-Sha256` header. */
export function verifyShopifyHmac(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = computeShopifyHmac(rawBody, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
