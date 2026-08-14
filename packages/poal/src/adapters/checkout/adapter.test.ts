import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { CheckoutAdapter, computeCheckoutSignature, verifyCheckoutSignature } from './adapter.js';
import { mapCheckoutResponseCode } from './decline-map.js';
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

const SECRET = 'whsec_test_checkout';
const baseCfg = { secretKey: 'sk_test_123', merchantId: 'mrc_1', baseUrl: 'https://checkout.test', webhookSecret: SECRET };

const invoice: Invoice = {
  id: 'ax10m_inv_inv_1', customerId: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'inv_1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_src_1', customerId: 'ax10m_cus_c1', processorRef: 'src_1', token: 'src_1' };

function webhook(type: string, dataOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_1',
    type,
    created_on: '2026-08-14T10:00:00Z',
    data: { id: 'pay_1', reference: 'inv_1', amount: 14900, currency: 'USD', source: { id: 'src_1' }, ...dataOverrides },
  });
}

describe('mapCheckoutResponseCode', () => {
  it('maps known response codes and defaults unknown to Unknown', () => {
    expect(mapCheckoutResponseCode('20051')).toBe(DeclineCode.InsufficientFunds);
    expect(mapCheckoutResponseCode('20054')).toBe(DeclineCode.ExpiredCard);
    expect(mapCheckoutResponseCode('20001')).toBe(DeclineCode.RevocationOfAuthorization);
    expect(mapCheckoutResponseCode('99999')).toBe(DeclineCode.Unknown);
    expect(mapCheckoutResponseCode(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('webhook signature', () => {
  it('computes and verifies a hex HMAC-SHA256 signature (round-trip)', () => {
    const body = webhook('payment_declined');
    const sig = computeCheckoutSignature(body, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyCheckoutSignature(body, sig, SECRET)).toBe(true);
    expect(verifyCheckoutSignature(body, sig, 'wrong_secret')).toBe(false);
  });
});

describe('ingestWebhook', () => {
  it('verifies Cko-Signature and normalizes payment_declined into invoice.failed with a mapped decline', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const body = webhook('payment_declined', { response_code: '20051', response_summary: 'Insufficient funds' });
    const events = await adapter.ingestWebhook({ body, headers: { 'Cko-Signature': computeCheckoutSignature(body, SECRET) } });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    expect(ev.processorEventId).toBe('evt_1');
    const p = ev.payload as { invoice: Invoice; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.processorRef).toBe('inv_1');
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(p.decline?.family).toBe(DeclineFamily.Soft);
  });

  it('rejects a webhook whose signature does not match (case-insensitive header)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const body = webhook('payment_declined');
    await expect(
      adapter.ingestWebhook({ body, headers: { 'cko-signature': 'deadbeef' } }),
    ).rejects.toThrow(/Cko-Signature verification failed/);
  });

  it('refuses to process when no webhookSecret is configured (fail closed)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ secretKey: 'sk', merchantId: 'mrc_1', baseUrl: 'https://checkout.test', fetch });
    const body = webhook('payment_declined');
    await expect(adapter.ingestWebhook({ body, headers: { 'Cko-Signature': 'x' } })).rejects.toThrow(/not configured/);
  });

  it('maps payment_captured to invoice.paid and ignores unhandled events', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const paidBody = webhook('payment_captured');
    const paid = await adapter.ingestWebhook({ body: paidBody, headers: { 'Cko-Signature': computeCheckoutSignature(paidBody, SECRET) } });
    expect(paid[0]!.type).toBe('invoice.paid');
    const noopBody = webhook('payment_pending');
    const noop = await adapter.ingestWebhook({ body: noopBody, headers: { 'Cko-Signature': computeCheckoutSignature(noopBody, SECRET) } });
    expect(noop).toEqual([]);
  });
});

describe('attemptCharge', () => {
  it('posts the stored source token with the idempotency key and reports success', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/payments');
      return res(201, { id: 'pay_ok', status: 'Authorized', amount: 14900, currency: 'USD' });
    });
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.idempotentReplay).toBe(false);
    expect(r.attempt.status).toBe('succeeded');
    expect(calls[0]!.init.headers?.['Cko-Idempotency-Key']).toBe('ax10m_charge_abc');
    expect(calls[0]!.init.body).toContain('"id":"src_1"'); // token, never a PAN
    expect(calls[0]!.init.body).toContain('"payment_type":"Recurring"');
  });

  it('detects an idempotent replay from the response header', async () => {
    const { fetch } = makeFetch(() =>
      res(201, { id: 'pay_ok', status: 'Authorized' }, { 'cko-idempotency-replayed': 'true' }),
    );
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.idempotentReplay).toBe(true);
  });

  it('treats a Declined status (HTTP 201) as a decline, not an error', async () => {
    const { fetch } = makeFetch(() => res(201, { id: 'pay_d', status: 'Declined', response_code: '20051', response_summary: 'Insufficient funds' }));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.status).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.InsufficientFunds);
  });

  it('treats a 4xx decline body as a decline, not an error', async () => {
    const { fetch } = makeFetch(() => res(422, { status: 'Declined', response_code: '20054', response_summary: 'Expired card' }));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.ExpiredCard);
  });

  it('rethrows a genuine infra/auth error so the saga can retry', async () => {
    const { fetch } = makeFetch(() => res(401, { error_type: 'unauthorized', message: 'Invalid API key' }));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow(/Invalid API key/);
  });
});

describe('gateway capabilities', () => {
  it('has no invoice ledger to poll, no enumerable methods, and no dunning to pause', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const page = await adapter.listOpenFailures(null);
    expect(page).toEqual({ invoices: [], nextCursor: null });
    expect(await adapter.fetchUpdatedCard(method)).toBeNull();
    expect(
      await adapter.listPaymentMethods({
        id: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'c1', issuerRegion: 'unknown',
        createdAt: '2026-01-01T00:00:00.000Z', consent: { email: true, sms: false, whatsapp: false, push: false, globallyOptedOut: false },
      }),
    ).toEqual([]);
    await expect(
      adapter.pauseNativeDunning({
        id: 'ax10m_sub_s1', customerId: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 's1',
        status: 'past_due', mrr: { amount: 14900, currency: 'USD' }, mrrTier: 'small', currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined();
    const caps = adapter.capabilities();
    expect(caps.integrationMode).toBe('drive');
    expect(caps.listPaymentMethods).toBe(false);
    expect(caps.pauseNativeDunning).toBe(false);
  });
});
