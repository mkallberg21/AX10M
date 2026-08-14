import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { WooCommerceAdapter } from './adapter.js';
import { computeWooSignature, mapWooDeclineCode } from './decline-map.js';
import type { FetchLike, FetchResponseLike } from './client.js';

// ── fake transport ────────────────────────────────────────────────────────────
function res(status: number, body: unknown): FetchResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
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

const SECRET = 'wc_whsec_test';
const baseCfg = { storeUrl: 'https://shop.example.com', consumerKey: 'ck_x', consumerSecret: 'cs_y', webhookSecret: SECRET, merchantId: 'mrc_1', baseUrl: 'https://shop.test/wp-json/wc/v3' };

const invoice: Invoice = {
  id: 'ax10m_inv_500', customerId: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: '500',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_pm_1', customerId: 'ax10m_cus_c1', processorRef: 'pm_1', token: 'pm_1' };

describe('mapWooDeclineCode', () => {
  it('maps free-text gateway strings on keywords, defaulting unknown to Unknown', () => {
    expect(mapWooDeclineCode('Card was declined: insufficient funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapWooDeclineCode('The card has expired')).toBe(DeclineCode.ExpiredCard);
    expect(mapWooDeclineCode('Do not honor')).toBe(DeclineCode.DoNotHonor);
    expect(mapWooDeclineCode('Reported lost')).toBe(DeclineCode.LostCard);
    expect(mapWooDeclineCode('Reported stolen')).toBe(DeclineCode.StolenCard);
    expect(mapWooDeclineCode('Invalid account number')).toBe(DeclineCode.InvalidCard);
    expect(mapWooDeclineCode('Card declined')).toBe(DeclineCode.DoNotHonor);
    expect(mapWooDeclineCode('something odd')).toBe(DeclineCode.Unknown);
    expect(mapWooDeclineCode(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('ingestWebhook', () => {
  function headers(topic: string, body: string, secret = SECRET) {
    return { 'X-WC-Webhook-Topic': topic, 'X-WC-Webhook-Signature': computeWooSignature(body, secret) };
  }

  const failedOrder = JSON.stringify({
    id: 500, status: 'failed', currency: 'USD', total: '149.00', customer_id: 55, subscription_id: 9,
    failure_message: 'Card declined: insufficient funds', date_modified_gmt: '2026-08-14T10:00:00.000Z', date_created_gmt: '2026-08-01T00:00:00.000Z',
  });

  it('normalizes a failed order into invoice.failed with a mapped decline and minor-unit amount', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new WooCommerceAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: failedOrder, headers: headers('order.updated', failedOrder) });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    const p = ev.payload as { invoice: Invoice; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' }); // "149.00" → 14900 cents
    expect(p.invoice.processorRef).toBe('500');
    expect(p.invoice.subscriptionId).toBe('ax10m_sub_9');
    expect(p.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(p.decline?.family).toBe(DeclineFamily.Soft);
  });

  it('rejects a webhook whose signature does not match (fail closed on bad signature)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new WooCommerceAdapter({ ...baseCfg, fetch });
    await expect(
      adapter.ingestWebhook({ body: failedOrder, headers: { 'X-WC-Webhook-Topic': 'order.updated', 'X-WC-Webhook-Signature': 'wrong' } }),
    ).rejects.toThrow(/verification failed/);
  });

  it('refuses to process when no webhookSecret is configured (fail closed)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new WooCommerceAdapter({ ...baseCfg, webhookSecret: '', fetch });
    await expect(
      adapter.ingestWebhook({ body: failedOrder, headers: headers('order.updated', failedOrder) }),
    ).rejects.toThrow(/not configured/);
  });

  it('maps completed/processing orders to invoice.paid and subscription.updated through', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new WooCommerceAdapter({ ...baseCfg, fetch });

    const completed = JSON.stringify({ id: 501, status: 'completed', currency: 'USD', total: '149.00', customer_id: 55 });
    const paid = await adapter.ingestWebhook({ body: completed, headers: headers('order.updated', completed) });
    expect(paid[0]!.type).toBe('invoice.paid');

    const sub = JSON.stringify({ id: 9, subscription_id: 9, status: 'active' });
    const subEvents = await adapter.ingestWebhook({ body: sub, headers: headers('subscription.updated', sub) });
    expect(subEvents[0]!.type).toBe('subscription.updated');
    expect((subEvents[0]!.payload as { status: string }).status).toBe('active');

    const pending = JSON.stringify({ id: 502, status: 'pending' });
    const none = await adapter.ingestWebhook({ body: pending, headers: headers('order.updated', pending) });
    expect(none).toEqual([]);
  });
});

describe('attemptCharge (trigger a renewal retry)', () => {
  it('submits the retry, passes the idempotency header, and resolves to pending (async gateway)', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/orders/500/retry-payment');
      return res(200, { status: 'pending' });
    });
    const adapter = new WooCommerceAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('pending'); // co-drive: the store's gateway charges asynchronously
    expect(r.attempt.status).toBe('pending');
    expect(r.idempotentReplay).toBe(false);
    expect(calls[0]!.init.headers?.['X-Idempotency-Key']).toBe('ax10m_charge_abc');
  });

  it('reports a processing/completed retry as succeeded', async () => {
    const { fetch } = makeFetch(() => res(200, { status: 'completed' }));
    const adapter = new WooCommerceAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
  });

  it('maps a failed retry to a mapped decline', async () => {
    const { fetch } = makeFetch(() => res(200, { status: 'failed', failure_message: 'Card expired' }));
    const adapter = new WooCommerceAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.ExpiredCard);
  });

  it('rethrows a non-2xx (infra/auth/validation) so the saga can retry', async () => {
    const { fetch } = makeFetch(() => res(401, { code: 'woocommerce_rest_authentication_error', message: 'Invalid signature' }));
    const adapter = new WooCommerceAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow();
  });
});

describe('reconciliation, capabilities & platform-owned surfaces', () => {
  it('lists failed orders and pages via a numeric page cursor', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: 600 + i, status: 'failed', currency: 'USD', total: '50.00', customer_id: 1 }));
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/orders');
      return res(200, fullPage);
    });
    const adapter = new WooCommerceAdapter({ ...baseCfg, fetch });
    const page = await adapter.listOpenFailures(null);
    expect(page.invoices).toHaveLength(100);
    expect(page.invoices[0]!.amount).toEqual({ amount: 5000, currency: 'USD' });
    expect(page.nextCursor).toBe('2'); // full page → there may be another
    expect(calls[0]!.url).toContain('status=failed');
  });

  it('stops paging when a short page returns', async () => {
    const { fetch } = makeFetch(() => res(200, [{ id: 700, status: 'failed', currency: 'USD', total: '9.99', customer_id: 1 }]));
    const adapter = new WooCommerceAdapter({ ...baseCfg, fetch });
    const page = await adapter.listOpenFailures('3');
    expect(page.invoices).toHaveLength(1);
    expect(page.invoices[0]!.amount.amount).toBe(999);
    expect(page.nextCursor).toBeNull();
  });

  it('advertises co-drive and store-owned surfaces', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new WooCommerceAdapter({ ...baseCfg, fetch });
    const caps = adapter.capabilities();
    expect(caps.integrationMode).toBe('co-drive');
    expect(caps.externalRetryControl).toBe(true);
    expect(caps.accountUpdater).toBe(false);
    expect(caps.networkTokens).toBe(false);
    expect(caps.listPaymentMethods).toBe(false);
    expect(await adapter.fetchUpdatedCard(method)).toBeNull();
    const customer = {
      id: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'c1', issuerRegion: 'unknown' as const,
      createdAt: '2026-01-01T00:00:00.000Z', consent: { email: true, sms: false, whatsapp: false, push: false, globallyOptedOut: false },
    };
    expect(await adapter.listPaymentMethods(customer)).toEqual([]);
    await expect(adapter.pauseNativeDunning({} as never)).resolves.toBeUndefined();
  });
});
