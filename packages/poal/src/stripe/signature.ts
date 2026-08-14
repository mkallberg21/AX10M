/**
 * Stripe webhook signature verification (`Stripe-Signature` header).
 *
 * The header is `t=<timestamp>,v1=<hex hmac>[,v1=<hex hmac>…]`. The signed payload
 * is `<timestamp>.<raw body>`, HMAC-SHA256 keyed by the webhook signing secret.
 * We verify at least one v1 signature in constant time and (optionally) enforce a
 * timestamp tolerance to blunt replay attacks.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeStripeSignature(timestamp: number | string, rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

/** Build a full `t=…,v1=…` Stripe-Signature header for a payload (used in tests). */
export function buildStripeSignatureHeader(timestamp: number, rawBody: string, secret: string): string {
  return `t=${timestamp},v1=${computeStripeSignature(timestamp, rawBody, secret)}`;
}

function parseHeader(header: string): { t?: string; v1: string[] } {
  const v1: string[] = [];
  let t: string | undefined;
  for (const part of header.split(',')) {
    const [k, val] = part.split('=');
    if (k === 't') t = val;
    else if (k === 'v1' && val) v1.push(val);
  }
  return { t, v1 };
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Verify a Stripe webhook. Returns true iff a v1 signature matches and (when
 * `toleranceSeconds` is given with `nowSeconds`) the timestamp is within tolerance.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): boolean {
  if (!header) return false;
  const { t, v1 } = parseHeader(header);
  if (!t || v1.length === 0) return false;
  if (opts.toleranceSeconds !== undefined && opts.nowSeconds !== undefined) {
    if (Math.abs(opts.nowSeconds - Number(t)) > opts.toleranceSeconds) return false;
  }
  const expected = computeStripeSignature(t, rawBody, secret);
  return v1.some((sig) => safeEqualHex(sig, expected));
}
