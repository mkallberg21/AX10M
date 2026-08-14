import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { MaxioAdapter } from './adapter.js';
import { computeMaxioSignature, mapMaxioDeclineCode } from './decline-map.js';
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
const baseCfg = { apiKey: 'test_key', subdomain: 'acme', merchantId: 'mrc_1', webhookSecret: 'whsec', baseUrl: 'https://acme.test' };

const invoice: Invoice = {
  id: 'ax10m_inv_101', subscriptionId: 'ax10m_sub_101', customerId: 'ax10m_cus_9', merchantId: 'mrc_1', processorRef: '101',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_pp1', customerId: 'ax10m_cus_9', processorRef: 'pp1', token: 'pp1' };

describe('mapMaxioDeclineCode', () => {
  it('maps keywords and defaults unknown to Unknown', () => {
    expect(mapMaxioDeclineCode('Insufficient funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapMaxioDeclineCode('card_declined')).toBe(DeclineCode.DoNotHonor);
    expect(mapMaxioDeclineCode('incorrect_number')).toBe(DeclineCode.InvalidCard);
    expect(mapMaxioDeclineCode('Card is expired')).toBe(DeclineCode.ExpiredCard);
    expect(mapMaxioDeclineCode('who knows')).toBe(DeclineCode.Unknown);
    expect(mapMaxioDeclineCode(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('attemptCharge', () => {
  it('retries the subscription, passes the idempotency key + Basic auth, and reports success', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/subscriptions/101/retry.json');
      return res(200, { subscription: { id: 101, state: 'active' } });
    });
    const adapter = new MaxioAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.attempt.status).toBe('succeeded');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers?.['Idempotency-Key']).toBe('ax10m_charge_abc');
    expect(calls[0]!.init.headers?.Authorization).toBe(basicAuth('test_key', 'x'));
  });

  it('treats a 422 payment error as a decline, not an error, with a mapped code', async () => {
    const { fetch } = makeFetch(() => res(422, { errors: ['Payment: Insufficient funds.'] }));
    const adapter = new MaxioAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.status).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.InsufficientFunds);
  });

  it('rethrows an infra/auth error so the saga can retry', async () => {
    const { fetch } = makeFetch(() => res(500, { error: 'internal error' }));
    const adapter = new MaxioAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow();
  });
});

describe('ingestWebhook', () => {
  // Chargify posts urlencoded `event` + `payload[...]` bodies.
  const failedBody =
    'event=payment_failure&payload[subscription][id]=101&payload[subscription][currency]=USD&payload[subscription][customer][id]=9' +
    '&payload[transaction][id]=555&payload[transaction][amount_in_cents]=14900&payload[transaction][memo]=Insufficient%20funds';
  const sign = (body: string) => ({ 'x-chargify-webhook-signature-hmac-sha256': computeMaxioSignature(body, 'whsec') });

  it('verifies the HMAC signature and normalizes payment_failure to invoice.failed with a mapped decline', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new MaxioAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: failedBody, headers: sign(failedBody) });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    const p = ev.payload as { invoice: Invoice; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.processorRef).toBe('101');
    expect(p.invoice.subscriptionId).toBe('ax10m_sub_101');
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(p.decline?.family).toBe(DeclineFamily.Soft);
  });

  it('rejects a webhook whose signature does not match', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new MaxioAdapter({ ...baseCfg, fetch });
    await expect(
      adapter.ingestWebhook({ body: failedBody, headers: { 'x-chargify-webhook-signature-hmac-sha256': 'deadbeef' } }),
    ).rejects.toThrow(/verification failed/);
  });

  it('refuses to process when no webhook secret is configured (fail closed)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new MaxioAdapter({ apiKey: 'k', subdomain: 'acme', merchantId: 'mrc_1', baseUrl: 'https://acme.test', fetch });
    await expect(adapter.ingestWebhook({ body: failedBody, headers: sign(failedBody) })).rejects.toThrow(/not configured/);
  });

  it('maps a JSON payment_success webhook to invoice.paid', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new MaxioAdapter({ ...baseCfg, fetch });
    const body = JSON.stringify({
      event: 'payment_success',
      payload: { subscription: { id: 101, currency: 'USD', customer: { id: 9 } }, transaction: { id: 556, amount_in_cents: 14900 } },
    });
    const paid = await adapter.ingestWebhook({ body, headers: sign(body) });
    expect(paid[0]!.type).toBe('invoice.paid');
  });
});

describe('reconciliation', () => {
  it('lists past_due subscriptions as open failures and paginates by page number', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/subscriptions.json');
      return res(200, [
        { subscription: { id: 77, state: 'past_due', currency: 'USD', balance_in_cents: 5000, customer: { id: 3 }, created_at: '2026-08-01T00:00:00Z' } },
      ]);
    });
    const adapter = new MaxioAdapter({ ...baseCfg, fetch });
    const page = await adapter.listOpenFailures(null);
    expect(page.invoices).toHaveLength(1);
    expect(page.invoices[0]!.processorRef).toBe('77');
    expect(page.invoices[0]!.subscriptionId).toBe('ax10m_sub_77');
    expect(page.invoices[0]!.amount.amount).toBe(5000);
    expect(page.invoices[0]!.status).toBe('open');
    // A short page (< per_page) ends pagination.
    expect(page.nextCursor).toBeNull();
    expect(calls[0]!.url).toContain('state=past_due');
  });
});
