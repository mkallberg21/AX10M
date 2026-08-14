/**
 * Maxio / Chargify → canonical decline-code mapping + webhook signature verification
 * + webhook body parsing.
 *
 * Chargify surfaces a gateway decline as free-text in the transaction / payment error
 * message (e.g. "Insufficient funds", "card_declined"). There is no normalized decline
 * enum, so — like the other gateway maps — we match on keywords. Unmapped reasons fall
 * back to `Unknown` (family: gray) so the recoverability model decides rather than a
 * guess.
 *
 * Webhooks are authenticated with an `X-Chargify-Webhook-Signature-Hmac-Sha256`
 * header: hex HMAC-SHA256 of the raw request body keyed by the shared webhook key. We
 * verify it in constant time. Chargify posts webhooks as urlencoded `event` +
 * `payload[...]` (or JSON), so we parse both.
 *
 * Coverage MUST be confirmed against the live API version — the mapping/verify
 * MECHANISM is the deliverable, not the exhaustiveness.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeclineCode } from '@ax10m/canonical';

/** Ordered substring rules — specific first — matched against the lowercased message. */
const MAXIO_DECLINE_RULES: ReadonlyArray<readonly [string, DeclineCode]> = [
  ['insufficient', DeclineCode.InsufficientFunds],
  ['expired', DeclineCode.ExpiredCard],
  ['lost', DeclineCode.LostCard],
  ['stolen', DeclineCode.StolenCard],
  ['incorrect_number', DeclineCode.InvalidCard],
  ['incorrect number', DeclineCode.InvalidCard],
  ['invalid', DeclineCode.InvalidCard],
  ['do not honor', DeclineCode.DoNotHonor],
  ['do not honour', DeclineCode.DoNotHonor],
  ['card_declined', DeclineCode.DoNotHonor],
  ['declined', DeclineCode.DoNotHonor],
];

/** Map a raw Chargify/Maxio gateway decline message to a canonical decline code. */
export function mapMaxioDeclineCode(raw: string | null | undefined): DeclineCode {
  if (!raw) return DeclineCode.Unknown;
  const s = raw.trim().toLowerCase();
  for (const [needle, code] of MAXIO_DECLINE_RULES) {
    if (s.includes(needle)) return code;
  }
  return DeclineCode.Unknown;
}

/** Compute the Chargify webhook signature: HMAC-SHA256(sharedKey, rawBody), hex. */
export function computeMaxioSignature(rawBody: string, sharedKey: string): string {
  return createHmac('sha256', sharedKey).update(rawBody, 'utf8').digest('hex');
}

/** Constant-time verification of the `X-Chargify-Webhook-Signature-Hmac-Sha256` header. */
export function verifyMaxioSignature(rawBody: string, signature: string | undefined, sharedKey: string): boolean {
  if (!signature) return false;
  const expected = computeMaxioSignature(rawBody, sharedKey);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A Chargify webhook parsed into `event` + a nested `payload` object. */
export interface MaxioWebhookBody {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Parse a Chargify webhook body. Chargify posts urlencoded bodies of the form
 * `event=payment_failure&payload[subscription][id]=1&payload[transaction][id]=2`, but
 * some setups POST JSON — we accept both. Bracketed urlencoded keys are expanded into
 * a nested object so the adapter can read `payload.subscription.id` uniformly.
 */
export function parseMaxioWebhook(rawBody: string): MaxioWebhookBody | null {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as { event?: string; payload?: Record<string, unknown> };
      if (!j.event) return null;
      return { event: j.event, payload: j.payload ?? {} };
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams(trimmed);
  const event = params.get('event');
  if (!event) return null;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    const m = key.match(/^payload(\[.*\])?$/);
    if (!m) continue;
    const pathPart = m[1];
    if (!pathPart) continue;
    const segments = [...pathPart.matchAll(/\[([^\]]*)\]/g)].map((s) => s[1]!);
    setNested(payload, segments, value);
  }
  return { event, payload };
}

/** Set a value at a nested path (`['subscription','id']`) inside an object. */
function setNested(target: Record<string, unknown>, segments: string[], value: string): void {
  let node = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) node[last] = value;
}
