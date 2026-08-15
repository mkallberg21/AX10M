import { describe, expect, it } from 'vitest';
import type { CanonicalEvent, Customer, Invoice, PaymentMethod, Subscription } from '@ax10m/canonical';
import type { Cursor, OpenFailuresPage, ProcessorAdapter, RawWebhook, CapabilityMatrix, ChargeResult } from './adapter.js';
import { extractContact, validateContactFor, maskEmail, maskPhone, formatReport } from './validate-contact.js';

const invoice: Invoice = { id: 'ax10m_inv_1', customerId: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'in_1', amount: { amount: 1299, currency: 'USD' }, status: 'open', createdAt: '2026-08-15T00:00:00.000Z' };

function failedEvent(customer?: { email?: string; phone?: string }): CanonicalEvent {
  return { id: 'evt_1', type: 'invoice.failed', merchantId: 'mrc_1', processorEventId: 'evt_1', occurredAt: '2026-08-15T00:00:00.000Z', payload: { invoice, customer } };
}

/** A stub adapter that returns pre-scripted events (or throws) from ingestWebhook. */
class StubAdapter implements ProcessorAdapter {
  readonly id = 'stub';
  constructor(private readonly behavior: () => Promise<CanonicalEvent[]>) {}
  async ingestWebhook(_raw: RawWebhook): Promise<CanonicalEvent[]> { return this.behavior(); }
  async listOpenFailures(_c: Cursor): Promise<OpenFailuresPage> { return { invoices: [], nextCursor: null }; }
  async attemptCharge(): Promise<ChargeResult> { throw new Error('n/a'); }
  async fetchUpdatedCard(): Promise<PaymentMethod | null> { return null; }
  async listPaymentMethods(_c: Customer): Promise<PaymentMethod[]> { return []; }
  async pauseNativeDunning(_s: Subscription): Promise<void> {}
  capabilities(): CapabilityMatrix {
    return { integrationMode: 'drive', externalRetryControl: true, accountUpdater: false, networkTokens: false, partialCapture: false, pauseNativeDunning: false, webhooks: true, listPaymentMethods: false };
  }
}

const raw: RawWebhook = { body: '{}', headers: {} };

describe('extractContact', () => {
  it('pulls email/phone off the invoice.failed event', () => {
    expect(extractContact([failedEvent({ email: 'a@b.test', phone: '+15555550123' })])).toEqual({ found: true, email: 'a@b.test', phone: '+15555550123' });
  });
  it('reports found with no contact when the customer is bare', () => {
    expect(extractContact([failedEvent(undefined)])).toEqual({ found: true, email: undefined, phone: undefined });
  });
  it('reports not-found when there is no invoice.failed event', () => {
    expect(extractContact([])).toEqual({ found: false });
  });
});

describe('validateContactFor', () => {
  it('classifies a payload that carries contact', async () => {
    const row = await validateContactFor('stripe', new StubAdapter(async () => [failedEvent({ email: 'a@b.test', phone: '+15555550123' })]), raw);
    expect(row).toMatchObject({ processor: 'stripe', status: 'contact', email: 'a@b.test', phone: '+15555550123' });
  });
  it('classifies a payload with no contact', async () => {
    const row = await validateContactFor('worldpay', new StubAdapter(async () => [failedEvent(undefined)]), raw);
    expect(row.status).toBe('no-contact');
  });
  it('classifies when no invoice.failed is produced', async () => {
    const row = await validateContactFor('x', new StubAdapter(async () => []), raw);
    expect(row.status).toBe('no-failed-event');
  });
  it('reports an ingest error (e.g. bad signature) without throwing', async () => {
    const row = await validateContactFor('adyen', new StubAdapter(async () => { throw new Error('HMAC verification failed'); }), raw);
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/HMAC/);
  });
});

describe('masking + report', () => {
  it('masks email and phone so validation output never leaks PII', () => {
    expect(maskEmail('dana@example.test')).toBe('d***@e***');
    expect(maskEmail(undefined)).toBe('—');
    expect(maskPhone('+15555550123')).toBe('+1***0123');
    expect(maskPhone(undefined)).toBe('—');
  });
  it('renders a table with masked values and a per-row note', () => {
    const report = formatReport([
      { processor: 'stripe', status: 'contact', email: 'dana@example.test', phone: '+15555550123' },
      { processor: 'worldpay', status: 'no-contact' },
      { processor: 'adyen', status: 'error', error: 'HMAC verification failed' },
    ]);
    expect(report).toContain('d***@e***');
    expect(report).toContain('+1***0123');
    expect(report).not.toContain('dana@example.test'); // raw PII never in the report
    expect(report).toContain('HMAC verification failed');
  });
});
