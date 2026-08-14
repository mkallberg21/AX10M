import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { WorldpayAdapter, computeWorldpaySignature, verifyWorldpaySignature } from './adapter.js';
import { mapWorldpayRefusal } from './decline-map.js';
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

const SECRET = 'whsec_test_worldpay';
const baseCfg = {
  username: 'user', password: 'pass', entity: 'PO123', merchantId: 'mrc_1',
  baseUrl: 'https://worldpay.test', webhookSecret: SECRET,
};

const invoice: Invoice = {
  id: 'ax10m_inv_inv_1', customerId: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'inv_1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_tok_1', customerId: 'ax10m_cus_c1', processorRef: 'tok_1', token: 'tok_1' };

function notification(type: string, detailOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: 'evt_1',
    eventTimestamp: '2026-08-14T10:00:00Z',
    eventDetails: { type, transactionReference: 'inv_1', amount: { value: 14900, currency: 'USD' }, ...detailOverrides },
  });
}

describe('mapWorldpayRefusal', () => {
  it('maps refusal codes and descriptions, defaulting to Unknown', () => {
    expect(mapWorldpayRefusal('51')).toBe(DeclineCode.InsufficientFunds);
    expect(mapWorldpayRefusal('54')).toBe(DeclineCode.ExpiredCard);
    expect(mapWorldpayRefusal('41')).toBe(DeclineCode.LostCard);
    expect(mapWorldpayRefusal('43')).toBe(DeclineCode.StolenCard);
    expect(mapWorldpayRefusal('4')).toBe(DeclineCode.PickupCard); // single-digit padded to "04"
    expect(mapWorldpayRefusal(undefined, 'Do not honour')).toBe(DeclineCode.DoNotHonor);
    expect(mapWorldpayRefusal(undefined, 'Insufficient funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapWorldpayRefusal('99', 'mystery')).toBe(DeclineCode.Unknown);
    expect(mapWorldpayRefusal(undefined, undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('webhook signature', () => {
  it('computes and verifies a hex HMAC-SHA256 signature (round-trip)', () => {
    const body = notification('payment.refused');
    const sig = computeWorldpaySignature(body, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWorldpaySignature(body, sig, SECRET)).toBe(true);
    expect(verifyWorldpaySignature(body, sig, 'wrong')).toBe(false);
  });
});

describe('ingestWebhook', () => {
  it('verifies the signature and normalizes payment.refused into invoice.failed with a mapped decline', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new WorldpayAdapter({ ...baseCfg, fetch });
    const body = notification('payment.refused', { refusalCode: '51', refusalDescription: 'Insufficient funds' });
    const events = await adapter.ingestWebhook({ body, headers: { 'X-WP-Signature': computeWorldpaySignature(body, SECRET) } });
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

  it('rejects a notification whose signature does not match (case-insensitive header)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new WorldpayAdapter({ ...baseCfg, fetch });
    const body = notification('payment.refused');
    await expect(
      adapter.ingestWebhook({ body, headers: { 'x-wp-signature': 'deadbeef' } }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it('refuses to process when no webhookSecret is configured (fail closed)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new WorldpayAdapter({ username: 'u', password: 'p', entity: 'PO1', merchantId: 'mrc_1', baseUrl: 'https://worldpay.test', fetch });
    const body = notification('payment.refused');
    await expect(adapter.ingestWebhook({ body, headers: { 'X-WP-Signature': 'x' } })).rejects.toThrow(/not configured/);
  });

  it('maps payment.settled to invoice.paid and ignores unhandled events', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new WorldpayAdapter({ ...baseCfg, fetch });
    const settledBody = notification('payment.settled');
    const settled = await adapter.ingestWebhook({ body: settledBody, headers: { 'X-WP-Signature': computeWorldpaySignature(settledBody, SECRET) } });
    expect(settled[0]!.type).toBe('invoice.paid');
    const noopBody = notification('payment.sentForSettlement');
    const noop = await adapter.ingestWebhook({ body: noopBody, headers: { 'X-WP-Signature': computeWorldpaySignature(noopBody, SECRET) } });
    expect(noop).toEqual([]);
  });
});

describe('attemptCharge', () => {
  it('posts the stored card token with the idempotency key and reports success', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/api/payments');
      return res(200, { outcome: 'authorized', paymentId: 'pay_ok', transactionReference: 'inv_1' });
    });
    const adapter = new WorldpayAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.idempotentReplay).toBe(false);
    expect(r.attempt.status).toBe('succeeded');
    expect(calls[0]!.init.headers?.['Idempotency-Key']).toBe('ax10m_charge_abc');
    expect(calls[0]!.init.body).toContain('"tokenId":"tok_1"'); // token, never a PAN
    expect(calls[0]!.init.body).toContain('"entity":"PO123"');
  });

  it('detects an idempotent replay from the response header', async () => {
    const { fetch } = makeFetch(() =>
      res(200, { outcome: 'authorized', paymentId: 'pay_ok' }, { 'idempotency-replayed': 'true' }),
    );
    const adapter = new WorldpayAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.idempotentReplay).toBe(true);
  });

  it('treats an HTTP 200 outcome:refused as a decline, not an error', async () => {
    const { fetch } = makeFetch(() => res(200, { outcome: 'refused', refusalCode: '51', refusalDescription: 'Insufficient funds' }));
    const adapter = new WorldpayAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.status).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.InsufficientFunds);
  });

  it('treats a 4xx refusal body as a decline, not an error', async () => {
    const { fetch } = makeFetch(() => res(400, { outcome: 'refused', refusalCode: '54', refusalDescription: 'Expired card' }));
    const adapter = new WorldpayAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.ExpiredCard);
  });

  it('rethrows a genuine infra/auth error so the saga can retry', async () => {
    const { fetch } = makeFetch(() => res(401, { errorName: 'unauthorized', message: 'Invalid credentials' }));
    const adapter = new WorldpayAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow(/Invalid credentials/);
  });
});

describe('gateway capabilities', () => {
  it('has no invoice ledger to poll, no enumerable methods, and no dunning to pause', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new WorldpayAdapter({ ...baseCfg, fetch });
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
