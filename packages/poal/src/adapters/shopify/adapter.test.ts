import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { ShopifyAdapter } from './adapter.js';
import { computeShopifyHmac, mapShopifyDeclineCode } from './decline-map.js';
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

const SECRET = 'shpss_test';
const baseCfg = { shop: 'acme', accessToken: 'shpat_x', apiSecret: SECRET, merchantId: 'mrc_1', baseUrl: 'https://acme.test/admin/api/2024-07/graphql.json' };

const invoice: Invoice = {
  id: 'ax10m_inv_1', customerId: 'ax10m_cus_c1', merchantId: 'mrc_1',
  processorRef: 'gid://shopify/SubscriptionContract/1', // contract gid is the round-trip ref
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_pm_1', customerId: 'ax10m_cus_c1', processorRef: 'pm_1', token: 'pm_1' };

// A subscriptionBillingAttemptCreate response with the given attempt/userErrors fields.
function billingAttemptResponse(attempt: unknown, userErrors: unknown[] = []) {
  return { data: { subscriptionBillingAttemptCreate: { subscriptionBillingAttempt: attempt, userErrors } } };
}

describe('mapShopifyDeclineCode', () => {
  it('maps known codes and defaults unknown to Unknown', () => {
    expect(mapShopifyDeclineCode('PAYMENT_METHOD_DECLINED')).toBe(DeclineCode.DoNotHonor);
    expect(mapShopifyDeclineCode('INSUFFICIENT_FUNDS')).toBe(DeclineCode.InsufficientFunds);
    expect(mapShopifyDeclineCode('EXPIRED_PAYMENT_METHOD')).toBe(DeclineCode.ExpiredCard);
    expect(mapShopifyDeclineCode('INVALID_PAYMENT_METHOD')).toBe(DeclineCode.InvalidCard);
    expect(mapShopifyDeclineCode('AUTHENTICATION_ERROR')).toBe(DeclineCode.AuthenticationRequired);
    expect(mapShopifyDeclineCode('who_knows')).toBe(DeclineCode.Unknown);
    expect(mapShopifyDeclineCode(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('ingestWebhook', () => {
  const failureBody = JSON.stringify({
    id: 991, admin_graphql_api_id: 'gid://shopify/SubscriptionBillingAttempt/991',
    subscription_contract_id: 1, amount: '149.00', currency: 'USD',
    error_code: 'INSUFFICIENT_FUNDS', error_message: 'Not enough funds',
    customer: { id: 55 }, created_at: '2026-08-14T10:00:00.000Z',
  });

  function headers(topic: string, body: string, secret = SECRET) {
    return { 'X-Shopify-Topic': topic, 'X-Shopify-Hmac-Sha256': computeShopifyHmac(body, secret) };
  }

  it('normalizes a billing-attempt failure into invoice.failed with a mapped decline', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: failureBody, headers: headers('subscription_billing_attempts/failure', failureBody) });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    const p = ev.payload as { invoice: Invoice; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' }); // major-string → minor cents
    expect(p.invoice.processorRef).toBe('gid://shopify/SubscriptionContract/1');
    expect(p.invoice.firstFailedAt).toBe('2026-08-14T10:00:00.000Z');
    expect(p.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(p.decline?.family).toBe(DeclineFamily.Soft);
  });

  it('enriches contact from the subscription contract customer (email + E.164 phone)', async () => {
    const { fetch, calls } = makeFetch((url, init) => {
      const body = init.body ?? '';
      if (body.includes('subscriptionContractCustomer')) {
        return res(200, { data: { subscriptionContract: { customer: { email: 'dana@example.test', phone: '+15555550123' } } } });
      }
      return res(200, {});
    });
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: failureBody, headers: headers('subscription_billing_attempts/failure', failureBody) });
    const p = events[0]!.payload as { customer?: { email?: string; phone?: string } };
    expect(p.customer?.email).toBe('dana@example.test');
    expect(p.customer?.phone).toBe('+15555550123');
    // The enrichment query was keyed off the contract gid.
    expect(calls.some((c) => (c.init.body ?? '').includes('gid://shopify/SubscriptionContract/1'))).toBe(true);
  });

  it('still emits invoice.failed when the contact-enrichment query fails (best-effort)', async () => {
    const { fetch } = makeFetch((url, init) => {
      const body = init.body ?? '';
      if (body.includes('subscriptionContractCustomer')) return res(500, { errors: [{ message: 'boom' }] });
      return res(200, {});
    });
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: failureBody, headers: headers('subscription_billing_attempts/failure', failureBody) });
    expect(events).toHaveLength(1); // enrichment failure did NOT drop the event
    const p = events[0]!.payload as { customer?: { email?: string } };
    expect(p.customer?.email).toBeUndefined();
  });

  it('rejects a webhook whose HMAC does not match (fail closed on bad signature)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    await expect(
      adapter.ingestWebhook({ body: failureBody, headers: { 'X-Shopify-Topic': 'subscription_billing_attempts/failure', 'X-Shopify-Hmac-Sha256': 'wrong' } }),
    ).rejects.toThrow(/verification failed/);
  });

  it('refuses to process when no apiSecret is configured (fail closed)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ShopifyAdapter({ ...baseCfg, apiSecret: '', fetch });
    await expect(
      adapter.ingestWebhook({ body: failureBody, headers: headers('subscription_billing_attempts/failure', failureBody) }),
    ).rejects.toThrow(/not configured/);
  });

  it('maps a billing-attempt success and orders/paid to invoice.paid, ignores unknown topics', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    const successBody = JSON.stringify({ id: 992, subscription_contract_id: 1, amount: '149.00', currency: 'USD', created_at: '2026-08-14T10:05:00.000Z' });
    const success = await adapter.ingestWebhook({ body: successBody, headers: headers('subscription_billing_attempts/success', successBody) });
    expect(success[0]!.type).toBe('invoice.paid');

    const orderBody = JSON.stringify({ id: 500, total_price: '149.00', currency: 'USD', customer: { id: 55 } });
    const paid = await adapter.ingestWebhook({ body: orderBody, headers: headers('orders/paid', orderBody) });
    expect(paid[0]!.type).toBe('invoice.paid');
    expect((paid[0]!.payload as { invoice: Invoice }).invoice.amount.amount).toBe(14900);

    const noopBody = JSON.stringify({ id: 1 });
    const noop = await adapter.ingestWebhook({ body: noopBody, headers: headers('carts/update', noopBody) });
    expect(noop).toEqual([]);
  });
});

describe('attemptCharge (trigger a subscription billing attempt)', () => {
  it('submits the billing attempt, passes the idempotencyKey, and resolves to pending (async charge)', async () => {
    const { fetch, calls } = makeFetch((url, init) => {
      expect(url).toContain('/graphql.json');
      const parsed = JSON.parse(init.body ?? '{}');
      expect(parsed.variables.subscriptionContractId).toBe('gid://shopify/SubscriptionContract/1');
      expect(parsed.variables.input.idempotencyKey).toBe('ax10m_charge_abc');
      return res(200, billingAttemptResponse({ id: 'gid://shopify/SubscriptionBillingAttempt/1', ready: false, errorCode: null }));
    });
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('pending'); // co-drive: Shopify's gateway charges asynchronously
    expect(r.attempt.status).toBe('pending');
    expect(r.idempotentReplay).toBe(false);
    expect(calls[0]!.init.headers?.['X-Shopify-Access-Token']).toBe('shpat_x');
  });

  it('reports a completed successful attempt as succeeded', async () => {
    const { fetch } = makeFetch(() =>
      res(200, billingAttemptResponse({ id: 'gid://shopify/SubscriptionBillingAttempt/2', ready: true, errorCode: null, transactions: { edges: [{ node: { id: 't1', status: 'SUCCESS' } }] } })),
    );
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.attempt.status).toBe('succeeded');
  });

  it('maps a synchronous gateway decline (errorCode) to failed with a mapped code', async () => {
    const { fetch } = makeFetch(() =>
      res(200, billingAttemptResponse({ id: 'gid://shopify/SubscriptionBillingAttempt/3', ready: false, errorCode: 'PAYMENT_METHOD_DECLINED', errorMessage: 'Declined' })),
    );
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.DoNotHonor);
  });

  it('throws on userErrors (validation), not a decline', async () => {
    const { fetch } = makeFetch(() =>
      res(200, billingAttemptResponse(null, [{ field: ['subscriptionContractId'], message: 'Contract is not active' }])),
    );
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow(/userErrors/);
  });

  it('rethrows a top-level GraphQL error (infra/auth) so the saga can retry', async () => {
    const { fetch } = makeFetch(() => res(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }));
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow(/Throttled/);
  });

  it('rethrows a non-2xx HTTP error so the saga can retry', async () => {
    const { fetch } = makeFetch(() => res(401, { errors: [{ message: 'Invalid API key or access token' }] }));
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow();
  });
});

describe('capabilities & platform-owned surfaces', () => {
  it('advertises co-drive and Shopify-owned method vault', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    const caps = adapter.capabilities();
    expect(caps.integrationMode).toBe('co-drive');
    expect(caps.externalRetryControl).toBe(true);
    expect(caps.listPaymentMethods).toBe(false);
    expect(caps.pauseNativeDunning).toBe(false);
  });

  it('returns empty/no-op for the surfaces Shopify owns', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ShopifyAdapter({ ...baseCfg, fetch });
    expect(await adapter.fetchUpdatedCard(method)).toBeNull();
    expect(await adapter.listOpenFailures(null)).toEqual({ invoices: [], nextCursor: null });
    const customer = {
      id: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'c1', issuerRegion: 'unknown' as const,
      createdAt: '2026-01-01T00:00:00.000Z', consent: { email: true, sms: false, whatsapp: false, push: false, globallyOptedOut: false },
    };
    expect(await adapter.listPaymentMethods(customer)).toEqual([]);
    await expect(adapter.pauseNativeDunning({} as never)).resolves.toBeUndefined();
  });
});
