import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Customer, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { ChargebeeAdapter } from './adapter.js';
import { mapChargebeeDeclineCode } from './decline-map.js';
import type { FetchLike, FetchResponseLike } from './client.js';

// ── fake transport ────────────────────────────────────────────────────────────
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

const basicAuth = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const baseCfg = { site: 'acme', apiKey: 'test_key', merchantId: 'mrc_1', baseUrl: 'https://acme.test/api/v2', webhookUser: 'u', webhookPassword: 'p' };
const AUTH = { authorization: basicAuth('u', 'p') };

const invoice: Invoice = {
  id: 'ax10m_inv_inv_1', customerId: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'inv_1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_pm_1', customerId: 'ax10m_cus_c1', processorRef: 'pm_1', token: 'pm_1' };

describe('mapChargebeeDeclineCode', () => {
  it('maps known codes and defaults unknown to Unknown', () => {
    expect(mapChargebeeDeclineCode('insufficient_funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapChargebeeDeclineCode('LOST_CARD')).toBe(DeclineCode.LostCard);
    expect(mapChargebeeDeclineCode('who_knows')).toBe(DeclineCode.Unknown);
    expect(mapChargebeeDeclineCode(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('ingestWebhook', () => {
  const failedBody = JSON.stringify({
    id: 'ev_1',
    occurred_at: 1_699_999_999,
    event_type: 'payment_failed',
    content: {
      invoice: { id: 'inv_1', customer_id: 'c1', subscription_id: 'sub_1', currency_code: 'USD', amount_due: 14900, status: 'payment_due', date: 1_699_990_000 },
      transaction: { id: 'txn_1', status: 'failure', error_code: 'insufficient_funds', error_text: 'Not enough funds', amount: 14900, currency_code: 'USD', payment_source_id: 'pm_1', date: 1_699_999_999 },
      customer: { id: 'c1', email: 'jane@example.com', phone: '+14155551234' },
    },
  });

  it('normalizes payment_failed into a canonical invoice.failed with a mapped decline', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: failedBody, headers: AUTH });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    expect(ev.processorEventId).toBe('ev_1');
    const p = ev.payload as { invoice: Invoice; customer?: Customer; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.processorRef).toBe('inv_1');
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.invoice.firstFailedAt).toBe('2023-11-14T22:13:19.000Z');
    expect(p.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(p.decline?.family).toBe(DeclineFamily.Soft);
    // contact from content.customer feeds the dunning channels
    expect(p.customer?.email).toBe('jane@example.com');
    expect(p.customer?.phone).toBe('+14155551234');
  });

  it('rejects a webhook whose Basic auth does not match the configured credentials', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch, webhookUser: 'u', webhookPassword: 'p' });
    await expect(
      adapter.ingestWebhook({ body: failedBody, headers: { authorization: basicAuth('u', 'WRONG') } }),
    ).rejects.toThrow(/auth verification failed/);
  });

  it('accepts a webhook with correct Basic auth (case-insensitive header)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch, webhookUser: 'u', webhookPassword: 'p' });
    const events = await adapter.ingestWebhook({ body: failedBody, headers: { Authorization: basicAuth('u', 'p') } });
    expect(events).toHaveLength(1);
  });

  it('refuses to process when no webhook credentials are configured (fail closed)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ChargebeeAdapter({ site: 'acme', apiKey: 'k', merchantId: 'mrc_1', baseUrl: 'https://acme.test/api/v2', fetch });
    await expect(adapter.ingestWebhook({ body: failedBody, headers: {} })).rejects.toThrow(/not configured/);
  });

  it('normalizes payment_refunded into a payment.reversed clawback keyed to the original invoice', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({
      body: JSON.stringify({
        id: 'ev_r1',
        occurred_at: 1_700_000_500,
        event_type: 'payment_refunded',
        content: {
          invoice: { id: 'inv_1', customer_id: 'c1', currency_code: 'USD', status: 'paid' },
          transaction: { id: 'txn_ref_1', type: 'refund', status: 'success', amount: 14900, currency_code: 'USD', date: 1_700_000_500 },
        },
      }),
      headers: AUTH,
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('payment.reversed');
    const p = ev.payload as { invoiceId: string; amount: number; currency: string; kind: string };
    // invoiceId MUST match the id mapInvoice stamps on the original payment (ax10m_inv_<invoice.id>)
    expect(p.invoiceId).toBe('ax10m_inv_inv_1');
    expect(p.amount).toBe(14900);
    expect(p.currency).toBe('USD');
    expect(p.kind).toBe('refund');
  });

  it('ignores a payment_refunded with a non-refund or zero-amount transaction', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch });
    const zero = await adapter.ingestWebhook({
      body: JSON.stringify({ id: 'ev_r2', occurred_at: 1, event_type: 'payment_refunded', content: { invoice: { id: 'inv_1', currency_code: 'USD' }, transaction: { id: 't', type: 'refund', amount: 0 } } }),
      headers: AUTH,
    });
    expect(zero).toEqual([]);
  });

  it('maps payment_succeeded to invoice.paid and ignores unhandled events', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch });
    const paid = await adapter.ingestWebhook({
      body: JSON.stringify({ id: 'ev_2', occurred_at: 1, event_type: 'payment_succeeded', content: { invoice: { id: 'inv_1', customer_id: 'c1', currency_code: 'USD', amount_due: 0, status: 'paid' } } }),
      headers: AUTH,
    });
    expect(paid[0]!.type).toBe('invoice.paid');
    const noop = await adapter.ingestWebhook({ body: JSON.stringify({ id: 'ev_3', event_type: 'something_else', content: {} }), headers: AUTH });
    expect(noop).toEqual([]);
  });
});

describe('attemptCharge', () => {
  it('collects via the invoice, passes the idempotency key, and reports success', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/invoices/inv_1/collect_payment');
      return res(200, { invoice: { id: 'inv_1', status: 'paid' }, transaction: { id: 'txn_ok', status: 'success', amount: 14900, currency_code: 'USD' } });
    });
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.idempotentReplay).toBe(false);
    expect(r.attempt.status).toBe('succeeded');
    // idempotency key + payment source were sent
    expect(calls[0]!.init.headers?.['chargebee-idempotency-key']).toBe('ax10m_charge_abc');
    expect(calls[0]!.init.body).toContain('payment_source_id=pm_1');
  });

  it('detects an idempotent replay from the response header', async () => {
    const { fetch } = makeFetch(() =>
      res(200, { transaction: { id: 'txn_ok', status: 'success' } }, { 'chargebee-idempotency-replayed': 'true' }),
    );
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.idempotentReplay).toBe(true);
  });

  it('treats a payment-layer rejection as a decline, not an error', async () => {
    const { fetch } = makeFetch(() =>
      res(400, { message: 'Payment declined', type: 'payment', api_error_code: 'payment_processing_failed', error_code: 'do_not_honor' }),
    );
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.status).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.DoNotHonor);
  });

  it('rethrows an infra/operation error so the saga can retry', async () => {
    const { fetch } = makeFetch(() => res(500, { message: 'gateway timeout', type: 'operation_failed' }));
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow();
  });
});

describe('reconciliation & payment methods', () => {
  it('lists open failures and paginates via next_offset', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/invoices');
      return res(200, {
        list: [{ invoice: { id: 'inv_9', customer_id: 'c9', currency_code: 'USD', amount_due: 5000, status: 'payment_due', date: 1_699_990_000 } }],
        next_offset: 'off2',
      });
    });
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch });
    const page = await adapter.listOpenFailures(null);
    expect(page.invoices).toHaveLength(1);
    expect(page.invoices[0]!.processorRef).toBe('inv_9');
    expect(page.invoices[0]!.amount.amount).toBe(5000);
    expect(page.invoices[0]!.status).toBe('open');
    expect(page.nextCursor).toBe('off2');
    expect(calls[0]!.url).toContain('status%5Bin%5D'); // status[in] filter, url-encoded
  });

  it('returns a refreshed card only when it actually changed', async () => {
    const { fetch } = makeFetch(() =>
      res(200, { payment_source: { id: 'pm_1', customer_id: 'c1', card: { last4: '4242', brand: 'visa', expiry_month: 12, expiry_year: 2030 } } }),
    );
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch });
    const changed = await adapter.fetchUpdatedCard({ ...method, expMonth: 11, expYear: 2030 });
    expect(changed?.autoUpdated).toBe(true);
    expect(changed?.expMonth).toBe(12);
    const unchanged = await adapter.fetchUpdatedCard({ ...method, expMonth: 12, expYear: 2030, last4: '4242' });
    expect(unchanged).toBeNull();
  });

  it('lists a customer\'s tokenized payment methods (no PAN)', async () => {
    const { fetch } = makeFetch(() =>
      res(200, { list: [{ payment_source: { id: 'pm_1', customer_id: 'c1', card: { last4: '4242', brand: 'visa', iin: '424242' } } }] }),
    );
    const adapter = new ChargebeeAdapter({ ...baseCfg, fetch });
    const customer: Customer = {
      id: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'c1', issuerRegion: 'unknown',
      createdAt: '2026-01-01T00:00:00.000Z', consent: { email: true, sms: false, whatsapp: false, push: false, globallyOptedOut: false },
    };
    const methods = await adapter.listPaymentMethods(customer);
    expect(methods).toHaveLength(1);
    expect(methods[0]!.token).toBe('pm_1');
    expect(methods[0]!.last4).toBe('4242');
    expect(methods[0]).not.toHaveProperty('pan');
  });
});
