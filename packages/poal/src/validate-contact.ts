/**
 * Contact-field validation harness (core).
 *
 * Runs a REAL captured webhook through an adapter's `ingestWebhook` and reports the customer
 * contact (email / phone) that came out — so an operator can confirm, against a live sandbox,
 * that our field paths still match the processor's real payload (webhook adapters) AND that the
 * enrichment API lookup returns contact (Shopify / GoCardless / Zuora, which fetch during
 * ingest). This is the live-sandbox counterpart to the docs review in CONTACT-FIELDS.md.
 *
 * This module is PURE and side-effect-free (no env, no fs, no network of its own) — the adapter
 * it's given carries the credentials + transport. The CLI wrapper (scripts/validate-contact-
 * fields.mjs) supplies real adapters + captured webhooks from env; these functions are what CI
 * unit-tests. Reported contact is MASKED so validation output never leaks PII.
 */

import type { CanonicalEvent } from '@ax10m/canonical';
import type { ProcessorAdapter, RawWebhook } from './adapter.js';

export type ContactStatus = 'contact' | 'no-contact' | 'no-failed-event' | 'error';

export interface ContactValidationRow {
  processor: string;
  status: ContactStatus;
  /** Present (unmasked) so the caller can mask/format; do not log raw. */
  email?: string;
  phone?: string;
  error?: string;
}

/** Pull the customer email/phone off the first `invoice.failed` event, if any. */
export function extractContact(events: CanonicalEvent[]): { found: boolean; email?: string; phone?: string } {
  const failed = events.find((e) => e.type === 'invoice.failed');
  if (!failed) return { found: false };
  const customer = (failed.payload as { customer?: { email?: string; phone?: string } }).customer;
  return { found: true, email: customer?.email, phone: customer?.phone };
}

/**
 * Run one captured webhook through an adapter and classify what contact resolved. Never throws —
 * an ingest error (bad signature, failed lookup) is reported as an `error` row.
 */
export async function validateContactFor(processor: string, adapter: ProcessorAdapter, raw: RawWebhook): Promise<ContactValidationRow> {
  try {
    const events = await adapter.ingestWebhook(raw);
    const c = extractContact(events);
    if (!c.found) return { processor, status: 'no-failed-event' };
    if (!c.email && !c.phone) return { processor, status: 'no-contact' };
    return { processor, status: 'contact', email: c.email, phone: c.phone };
  } catch (err) {
    return { processor, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Mask an email for safe display: `dana@example.test` → `d***@e***`. */
export function maskEmail(email: string | undefined): string {
  if (!email) return '—';
  const [user, domain] = email.split('@');
  return `${user?.[0] ?? ''}***@${domain ? `${domain[0]}***` : '***'}`;
}

/** Mask a phone for safe display: `+15555550123` → `+1***0123`. */
export function maskPhone(phone: string | undefined): string {
  if (!phone) return '—';
  return phone.length <= 4 ? '***' : `${phone.slice(0, 2)}***${phone.slice(-4)}`;
}

/** Render rows as a fixed-width table (contact values masked). */
export function formatReport(rows: ContactValidationRow[]): string {
  const header = ['processor', 'status', 'email', 'phone', 'note'];
  const body = rows.map((r) => [
    r.processor,
    r.status,
    maskEmail(r.email),
    maskPhone(r.phone),
    r.status === 'error' ? (r.error ?? '') : r.status === 'no-contact' ? 'ingested, no contact on payload' : r.status === 'no-failed-event' ? 'no invoice.failed produced' : 'OK',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}
