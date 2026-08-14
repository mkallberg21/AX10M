import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Customer, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { StripeAdapter } from './adapter.js';
import { buildStripeSignatureHeader } from './signature.js';
import { mapStripeDeclineCode } from './decline-map.js';
import type { FetchLike, FetchResponseLike } from './client.js';

const SECRET = 'whsec_test';
const T = 1_700_000_000;

function res(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => lower[n.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(text) : body),
  };
}

function makeFetch(handler: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => FetchResponseLike) {
  const calls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fetch: FetchLike = async (url, init) => {
    const i = init ?? {};
    calls.push({ url, init: i });
    return handler(url, i);
  };
  return { fetch, calls };
}

const baseCfg = { secretKey: 'sk_test', webhookSecret: SECRET, merchantId: 'mrc_1', baseUrl: 'https://stripe.test/v1' };

function signed(body: string): { 'stripe-signature': string } {
  return { 'stripe-signature': buildStripeSignatureHeader(T, body, SECRET) };
}

const invoice: Invoice = {
  id: 'ax10m_inv_in_1', customerId: 'ax10m_cus_cus_1', merchantId: 'mrc_1', processorRef: 'in_1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_pm_1', customerId: 'ax10m_cus_cus_1', processorRef: 'pm_1', token: 'pm_1' };

describe('mapStripeDeclineCode', () => {
  it('maps known decline codes', () => {
    expect(mapStripeDeclineCode('insufficient_funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapStripeDeclineCode('lost_card')).toBe(DeclineCode.LostCard);
    expect(mapStripeDeclineCode(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('ingestWebhook', () => {
  it('verifies the signature and normalizes invoice.payment_failed (with customer for clustering)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new StripeAdapter({ ...baseCfg, fetch });
    const body = JSON.stringify({ id: 'evt_1', type: 'invoice.payment_failed', created: T, data: { object: { id: 'in_1', customer: 'cus_1', subscription: 'sub_1', amount_due: 14900, currency: 'usd', status: 'open', created: 1_699_999_000 } } });
    const events = await adapter.ingestWebhook({ body, headers: signed(body) });
    expect(events).toHaveLength(1);
    const p = events[0]!.payload as { invoice: Invoice };
    expect(events[0]!.type).toBe('invoice.failed');
    expect(p.invoice.processorRef).toBe('in_1');
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.invoice.customerId).toBe('ax10m_cus_cus_1'); // real customer → customer-level holdout
    expect(p.invoice.subscriptionId).toBe('ax10m_sub_sub_1');
  });

  it('rejects a webhook with a bad signature', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new StripeAdapter({ ...baseCfg, fetch });
    const body = JSON.stringify({ id: 'evt_1', type: 'invoice.payment_failed', created: T, data: { object: { id: 'in_1' } } });
    await expect(adapter.ingestWebhook({ body, headers: { 'stripe-signature': `t=${T},v1=deadbeef` } })).rejects.toThrow(/verification failed/);
  });

  it('maps charge.failed with a decline and invoice.payment_succeeded to paid', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new StripeAdapter({ ...baseCfg, fetch });
    const failBody = JSON.stringify({ id: 'evt_2', type: 'charge.failed', created: T, data: { object: { id: 'ch_1', invoice: 'in_2', customer: 'cus_2', amount: 5000, currency: 'usd', decline_code: 'insufficient_funds' } } });
    const failed = await adapter.ingestWebhook({ body: failBody, headers: signed(failBody) });
    const fp = failed[0]!.payload as { decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(failed[0]!.type).toBe('invoice.failed');
    expect(fp.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(fp.decline?.family).toBe(DeclineFamily.Soft);

    const paidBody = JSON.stringify({ id: 'evt_3', type: 'invoice.payment_succeeded', created: T, data: { object: { id: 'in_1', customer: 'cus_1', amount_due: 0, currency: 'usd', status: 'paid' } } });
    const paid = await adapter.ingestWebhook({ body: paidBody, headers: signed(paidBody) });
    expect(paid[0]!.type).toBe('invoice.paid');
  });
});

describe('attemptCharge', () => {
  it('pays the invoice with the stored method + idempotency key and reports success', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/invoices/in_1/pay');
      return res(200, { id: 'in_1', status: 'paid', paid: true });
    });
    const adapter = new StripeAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(calls[0]!.init.headers?.['Idempotency-Key']).toBe('ax10m_charge_abc');
    expect(calls[0]!.init.body).toContain('payment_method=pm_1');
    expect(calls[0]!.init.body).toContain('off_session=true');
  });

  it('treats a 402 card_error as a decline, not an error', async () => {
    const { fetch } = makeFetch(() => res(402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } }));
    const adapter = new StripeAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.InsufficientFunds);
  });

  it('rethrows a non-card error (bad request / infra)', async () => {
    const { fetch } = makeFetch(() => res(400, { error: { type: 'invalid_request_error', message: 'No such invoice' } }));
    const adapter = new StripeAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow(/No such invoice/);
  });
});

describe('reconciliation & payment methods', () => {
  it('lists open failed invoices with a cursor', async () => {
    const { fetch, calls } = makeFetch(() => res(200, { data: [{ id: 'in_9', customer: 'cus_9', amount_due: 5000, currency: 'usd', status: 'open' }], has_more: true }));
    const adapter = new StripeAdapter({ ...baseCfg, fetch });
    const page = await adapter.listOpenFailures(null);
    expect(page.invoices[0]!.amount).toEqual({ amount: 5000, currency: 'USD' });
    expect(page.nextCursor).toBe('in_9');
    expect(calls[0]!.url).toContain('status=open');
  });

  it('lists a customer\'s stored cards (no PAN) and has nothing to fetch-update', async () => {
    const { fetch } = makeFetch(() => res(200, { data: [{ id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } }] }));
    const adapter = new StripeAdapter({ ...baseCfg, fetch });
    const customer: Customer = {
      id: 'ax10m_cus_cus_1', merchantId: 'mrc_1', processorRef: 'cus_1', issuerRegion: 'unknown',
      createdAt: '2026-01-01T00:00:00.000Z', consent: { email: true, sms: false, whatsapp: false, push: false, globallyOptedOut: false },
    };
    const methods = await adapter.listPaymentMethods(customer);
    expect(methods[0]!.token).toBe('pm_1');
    expect(methods[0]!.last4).toBe('4242');
    expect(methods[0]!.expMonth).toBe(12);
    expect(await adapter.fetchUpdatedCard(method)).toBeNull();
  });
});
