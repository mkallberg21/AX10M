/**
 * Braintree → canonical decline mapping + webhook signature verification.
 *
 * Braintree surfaces declines via a numeric `processor-response-code` (the 2000
 * series) and text. We map the common codes onto AX10M's canonical taxonomy;
 * unmapped codes fall back to `Unknown` (family: gray).
 *
 * Webhooks are signed: `bt_signature` is `publicKey|hmac` pairs joined by `&`, and
 * the hmac is HMAC-SHA1 of the `bt_payload` keyed by the SHA1-hex of the private
 * key (Braintree's scheme). We verify in constant time.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DeclineCode } from '@ax10m/canonical';

const BRAINTREE_DECLINE_MAP: Readonly<Record<string, DeclineCode>> = {
  '2000': DeclineCode.DoNotHonor, // Do Not Honor
  '2001': DeclineCode.InsufficientFunds,
  '2002': DeclineCode.VelocityLimitExceeded, // Limit Exceeded
  '2003': DeclineCode.VelocityLimitExceeded, // Cardholder Activity Limit Exceeded
  '2004': DeclineCode.ExpiredCard,
  '2005': DeclineCode.InvalidCard, // Invalid Credit Card Number
  '2006': DeclineCode.InvalidCard, // Invalid Expiration Date
  '2007': DeclineCode.ClosedAccount, // No Account
  '2008': DeclineCode.InvalidCard, // Card Account Length Error
  '2009': DeclineCode.IssuerUnavailable, // No Such Issuer
  '2010': DeclineCode.Fraudulent, // Issuer Declined CVV
  '2011': DeclineCode.AuthenticationRequired, // Voice Authorization Required
  '2012': DeclineCode.LostCard, // Possible Lost Card
  '2013': DeclineCode.StolenCard, // Possible Stolen Card
  '2014': DeclineCode.Fraudulent, // Fraud Suspected
  '2015': DeclineCode.CardNotSupported, // Transaction Not Allowed
  '2019': DeclineCode.ProcessingError, // Invalid Transaction
  '2024': DeclineCode.CardNotSupported, // Card Type Not Enabled
  '2038': DeclineCode.DoNotHonor, // Processor Declined
  '2044': DeclineCode.DoNotHonor, // Declined - Call Issuer
  '2046': DeclineCode.DoNotHonor, // Declined
  '2047': DeclineCode.PickupCard, // Call Issuer. Pick Up Card
  '2057': DeclineCode.CardNotSupported, // Issuer or Cardholder Restriction
};

/** Map a raw Braintree processor-response-code to a canonical decline code. */
export function mapBraintreeDeclineCode(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  return BRAINTREE_DECLINE_MAP[raw.trim()] ?? DeclineCode.Unknown;
}

// ── Webhook signature (Braintree) ───────────────────────────────────────────────

function sha1Hex(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
function hmacSha1Hex(key: string, message: string): string {
  return createHmac('sha1', key).update(message, 'utf8').digest('hex');
}

/** The HMAC Braintree computes for a payload: HMAC-SHA1(SHA1hex(privateKey), payload). */
export function braintreeSignatureFor(payload: string, privateKey: string): string {
  return hmacSha1Hex(sha1Hex(privateKey), payload);
}

/** Build a full `publicKey|hmac` bt_signature for a payload (used in tests / debugging). */
export function signBraintreePayload(payload: string, publicKey: string, privateKey: string): string {
  return `${publicKey}|${braintreeSignatureFor(payload, privateKey)}`;
}

/** Verify a Braintree webhook: find our public key's signature pair and constant-time compare. */
export function verifyBraintreeSignature(
  btSignature: string,
  btPayload: string,
  publicKey: string,
  privateKey: string,
): boolean {
  const pair = btSignature
    .split('&')
    .map((p) => p.split('|'))
    .find((parts) => parts.length === 2 && parts[0] === publicKey);
  if (!pair) return false;
  const expected = braintreeSignatureFor(btPayload, privateKey);
  const a = Buffer.from(pair[1]!);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
