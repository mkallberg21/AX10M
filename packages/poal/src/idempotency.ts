/**
 * Deterministic idempotency keys for charge attempts.
 *
 * Exactly-once charging is the correctness bar that makes or breaks a payments
 * company (ARCHITECTURE.md §4.3, §9). The key MUST be a pure function of the
 * (merchant, invoice, method, attempt) tuple so that a retry after a crash or
 * network partition produces the SAME key, and the processor de-dupes it into an
 * idempotent replay rather than a second charge.
 */

import { createHash } from 'node:crypto';

export interface IdempotencyKeyInput {
  merchantId: string;
  invoiceId: string;
  paymentMethodId: string;
  attemptNumber: number;
}

/**
 * Build a deterministic idempotency key. Same inputs → same key, forever.
 * Prefixed so it is greppable in processor dashboards and logs.
 */
export function idempotencyKey(input: IdempotencyKeyInput): string {
  const canonical = [
    input.merchantId,
    input.invoiceId,
    input.paymentMethodId,
    String(input.attemptNumber),
  ].join(':');
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return `ax10m_charge_${digest}`;
}
