/**
 * Adyen refusal-reason → canonical decline mapping + notification HMAC verification.
 *
 * Adyen surfaces a decline via `refusalReason` (normalized text, often prefixed
 * with a numeric code, e.g. "6 Expired Card") and `additionalData.refusalReasonRaw`
 * (the raw acquirer response). We match the common ones onto AX10M's canonical
 * taxonomy; unmapped reasons fall back to `Unknown` (family: gray).
 *
 * Reference: Adyen refusal reasons + HMAC signature calculation.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeclineCode } from '@ax10m/canonical';

/** Ordered substring rules — specific first — matched against the lowercased reason. */
const ADYEN_REFUSAL_RULES: ReadonlyArray<readonly [string, DeclineCode]> = [
  ['not enough balance', DeclineCode.InsufficientFunds],
  ['insufficient funds', DeclineCode.InsufficientFunds],
  ['issuer unavailable', DeclineCode.IssuerUnavailable],
  ['acquirer error', DeclineCode.ProcessingError],
  ['expired', DeclineCode.ExpiredCard],
  ['invalid card number', DeclineCode.InvalidCard],
  ['invalid card', DeclineCode.InvalidCard],
  ['invalid amount', DeclineCode.ProcessingError],
  ['3d not authenticated', DeclineCode.AuthenticationRequired],
  ['not 3d authenticated', DeclineCode.AuthenticationRequired],
  ['blocked card', DeclineCode.PickupCard],
  ['restricted card', DeclineCode.CardNotSupported],
  ['not supported', DeclineCode.CardNotSupported],
  ['transaction not permitted', DeclineCode.CardNotSupported],
  ['withdrawal amount exceeded', DeclineCode.VelocityLimitExceeded],
  ['withdrawal count exceeded', DeclineCode.VelocityLimitExceeded],
  ['revocation of auth', DeclineCode.RevocationOfAuthorization],
  ['cvc declined', DeclineCode.Fraudulent],
  ['fraud', DeclineCode.Fraudulent],
  ['referral', DeclineCode.DoNotHonor],
  ['declined non generic', DeclineCode.DoNotHonor],
  ['refused', DeclineCode.DoNotHonor],
];

/** Exact numeric Adyen refusal codes (when the reason is just a code). */
const ADYEN_REFUSAL_CODES: Readonly<Record<string, DeclineCode>> = {
  '2': DeclineCode.DoNotHonor,
  '3': DeclineCode.DoNotHonor,
  '4': DeclineCode.ProcessingError,
  '5': DeclineCode.PickupCard,
  '6': DeclineCode.ExpiredCard,
  '8': DeclineCode.InvalidCard,
  '9': DeclineCode.IssuerUnavailable,
  '10': DeclineCode.CardNotSupported,
  '11': DeclineCode.AuthenticationRequired,
  '12': DeclineCode.InsufficientFunds,
  '23': DeclineCode.CardNotSupported,
  '24': DeclineCode.Fraudulent,
  '25': DeclineCode.CardNotSupported,
  '26': DeclineCode.RevocationOfAuthorization,
  '27': DeclineCode.DoNotHonor,
};

/** Map a raw Adyen refusal reason (text and/or numeric code) to a canonical code. */
export function mapAdyenRefusalReason(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  const s = raw.trim().toLowerCase();
  for (const [needle, code] of ADYEN_REFUSAL_RULES) {
    if (s.includes(needle)) return code;
  }
  const numeric = s.match(/^(\d+)\b/)?.[1] ?? (/^\d+$/.test(s) ? s : undefined);
  if (numeric && ADYEN_REFUSAL_CODES[numeric]) return ADYEN_REFUSAL_CODES[numeric]!;
  return DeclineCode.Unknown;
}

// ── Notification HMAC (Adyen webhook authentication) ────────────────────────────

/** The subset of an Adyen NotificationRequestItem needed to compute its HMAC. */
export interface AdyenNotificationItem {
  pspReference?: string;
  originalReference?: string;
  merchantAccountCode?: string;
  merchantReference?: string;
  amount?: { value?: number; currency?: string };
  eventCode?: string;
  success?: string;
  paymentMethod?: string;
  reason?: string;
  eventDate?: string;
  additionalData?: Record<string, string>;
}

/** Adyen escapes `\` → `\\` and `:` → `\:` before joining fields with `:`. */
function escapeField(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/** Build the colon-joined data string Adyen signs (order is fixed by Adyen). */
export function adyenHmacData(item: AdyenNotificationItem): string {
  const a = item.amount ?? {};
  const fields = [
    item.pspReference ?? '',
    item.originalReference ?? '',
    item.merchantAccountCode ?? '',
    item.merchantReference ?? '',
    a.value === undefined ? '' : String(a.value),
    a.currency ?? '',
    item.eventCode ?? '',
    item.success ?? '',
  ];
  return fields.map(escapeField).join(':');
}

/** Compute the base64 HMAC-SHA256 signature for a notification item, given the hex key. */
export function computeAdyenHmac(item: AdyenNotificationItem, hmacKeyHex: string): string {
  const key = Buffer.from(hmacKeyHex, 'hex');
  return createHmac('sha256', key).update(adyenHmacData(item), 'utf8').digest('base64');
}

/** Constant-time verification of the item's `additionalData.hmacSignature`. */
export function verifyAdyenHmac(item: AdyenNotificationItem, hmacKeyHex: string): boolean {
  const provided = item.additionalData?.hmacSignature;
  if (!provided) return false;
  const expected = computeAdyenHmac(item, hmacKeyHex);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
