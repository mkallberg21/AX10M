/**
 * GoCardless failure-cause → canonical decline mapping + webhook signature verify.
 *
 * Bank debit failures don't map perfectly onto card decline codes, but the key
 * signal — `insufficient_funds` (the retriable, Success+-eligible case) — maps
 * cleanly. GoCardless webhook events carry a normalized `details.cause`.
 *
 * Webhooks are authenticated with a `Webhook-Signature` header: HMAC-SHA256 (hex)
 * of the raw request body keyed by the webhook endpoint secret. We verify it in
 * constant time.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeclineCode } from '@lift/canonical';

const GOCARDLESS_CAUSE_MAP: Readonly<Record<string, DeclineCode>> = {
  insufficient_funds: DeclineCode.InsufficientFunds,
  refer_to_payer: DeclineCode.InsufficientFunds,
  bank_account_closed: DeclineCode.ClosedAccount,
  account_closed: DeclineCode.ClosedAccount,
  bank_account_transferred: DeclineCode.ProcessingError,
  invalid_bank_details: DeclineCode.InvalidCard,
  invalid_account_number: DeclineCode.InvalidCard,
  mandate_cancelled: DeclineCode.RevocationOfAuthorization,
  mandate_expired: DeclineCode.RevocationOfAuthorization,
  mandate_suspended: DeclineCode.RevocationOfAuthorization,
  payment_stopped: DeclineCode.RevocationOfAuthorization,
  user_cancelled: DeclineCode.RevocationOfAuthorization,
  customer_approval_denied: DeclineCode.RevocationOfAuthorization,
  authorisation_disputed: DeclineCode.DoNotHonor,
  return_on_odfi_request: DeclineCode.DoNotHonor,
  debit_authority_limit_breached: DeclineCode.VelocityLimitExceeded,
  direct_debit_not_enabled: DeclineCode.CardNotSupported,
};

/** Map a raw GoCardless failure cause to a canonical decline code. */
export function mapGoCardlessCause(cause: string | null | undefined): DeclineCode {
  if (!cause) return DeclineCode.Unknown;
  return GOCARDLESS_CAUSE_MAP[cause.trim().toLowerCase()] ?? DeclineCode.Unknown;
}

/** Compute the GoCardless webhook signature: HMAC-SHA256(secret, rawBody), hex. */
export function computeGoCardlessSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Constant-time verification of the `Webhook-Signature` header. */
export function verifyGoCardlessSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = computeGoCardlessSignature(rawBody, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
