import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Customer, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { AdyenAdapter } from './adapter.js';
import { computeAdyenHmac, mapAdyenRefusalReason, type AdyenNotificationItem } from './notification-map.js';
import type { FetchLike, FetchResponseLike } from './client.js';

const KEY = '00112233445566778899aabbccddeeff';

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

const baseCfg = { apiKey: 'test', merchantAccount: 'MyMerchant', merchantId: 'mrc_1', baseUrl: 'https://adyen.test/v71' };

function signedItem(overrides: Partial<AdyenNotificationItem> = {}): AdyenNotificationItem {
  const item: AdyenNotificationItem = {
    pspReference: 'psp_1',
    originalReference: '',
    merchantAccountCode: 'MyMerchant',
    merchantReference: 'inv_1',
    amount: { value: 14900, currency: 'USD' },
    eventCode: 'AUTHORISATION',
    success: 'false',
    reason: '6 Expired Card',
    paymentMethod: 'visa',
    eventDate: '2026-08-14T10:00:00+00:00',
    additionalData: {},
    ...overrides,
  };
  item.additionalData = { ...item.additionalData, hmacSignature: computeAdyenHmac(item, KEY) };
  return item;
}

function notification(item: AdyenNotificationItem): string {
  return JSON.stringify({ live: 'false', notificationItems: [{ NotificationRequestItem: item }] });
}

const invoice: Invoice = {
  id: 'ax10m_inv_inv_1', customerId: 'ax10m_cus_shopper1', merchantId: 'mrc_1', processorRef: 'inv_1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_TOKEN', customerId: 'ax10m_cus_shopper1', processorRef: 'TOKEN', token: 'TOKEN' };

describe('mapAdyenRefusalReason', () => {
  it('maps text and numeric-coded reasons, defaulting to Unknown', () => {
    expect(mapAdyenRefusalReason('Insufficient funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapAdyenRefusalReason('6 Expired Card')).toBe(DeclineCode.ExpiredCard);
    expect(mapAdyenRefusalReason('12')).toBe(DeclineCode.InsufficientFunds);
    expect(mapAdyenRefusalReason('Refused')).toBe(DeclineCode.DoNotHonor);
    expect(mapAdyenRefusalReason('who knows')).toBe(DeclineCode.Unknown);
  });
});

describe('ingestWebhook', () => {
  it('verifies the HMAC and normalizes a failed AUTHORISATION to invoice.failed', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new AdyenAdapter({ ...baseCfg, fetch, hmacKey: KEY });
    const events = await adapter.ingestWebhook({ body: notification(signedItem()), headers: {} });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    const p = ev.payload as { invoice: Invoice; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.processorRef).toBe('inv_1');
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.decline?.code).toBe(DeclineCode.ExpiredCard);
    expect(p.decline?.family).toBe(DeclineFamily.Gray);
  });

  it('rejects a notification whose HMAC signature is wrong', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new AdyenAdapter({ ...baseCfg, fetch, hmacKey: KEY });
    const item = signedItem();
    item.additionalData!.hmacSignature = 'tampered==';
    await expect(adapter.ingestWebhook({ body: notification(item), headers: {} })).rejects.toThrow(/HMAC verification failed/);
  });

  it('maps a successful AUTHORISATION to invoice.paid', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new AdyenAdapter({ ...baseCfg, fetch, hmacKey: KEY });
    const events = await adapter.ingestWebhook({ body: notification(signedItem({ success: 'true', reason: '' })), headers: {} });
    expect(events[0]!.type).toBe('invoice.paid');
  });

  it('refuses to process a notification when no hmacKey is configured (fail closed)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new AdyenAdapter({ ...baseCfg, fetch }); // no hmacKey
    await expect(adapter.ingestWebhook({ body: notification(signedItem()), headers: {} })).rejects.toThrow(/not configured/);
  });

  it('ignores non-AUTHORISATION events (still HMAC-verified)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new AdyenAdapter({ ...baseCfg, fetch, hmacKey: KEY });
    const refund = signedItem({ eventCode: 'REFUND', success: 'true', reason: '' });
    const none = await adapter.ingestWebhook({ body: notification(refund), headers: {} });
    expect(none).toEqual([]);
  });
});

describe('attemptCharge', () => {
  it('posts a stored-token payment with the idempotency key and reports success', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/payments');
      return res(200, { resultCode: 'Authorised', pspReference: 'psp_ok' });
    });
    const adapter = new AdyenAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.attempt.status).toBe('succeeded');
    expect(calls[0]!.init.headers?.['Idempotency-Key']).toBe('ax10m_charge_abc');
    expect(calls[0]!.init.body).toContain('"storedPaymentMethodId":"TOKEN"');
    expect(calls[0]!.init.body).toContain('"shopperReference":"shopper1"'); // derived from ax10m_cus_ prefix
  });

  it('treats a Refused resultCode (HTTP 200) as a decline, not an error', async () => {
    const { fetch } = makeFetch(() => res(200, { resultCode: 'Refused', refusalReason: 'Insufficient funds', pspReference: 'psp_x' }));
    const adapter = new AdyenAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.InsufficientFunds);
  });

  it('rethrows a genuine HTTP error (bad key / infra) for the saga to retry', async () => {
    const { fetch } = makeFetch(() => res(401, { status: 401, errorCode: '101', message: 'Invalid API key' }));
    const adapter = new AdyenAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow(/Invalid API key/);
  });
});

describe('stored payment methods', () => {
  it('lists a shopper\'s tokenized stored methods (no PAN)', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/storedPaymentMethods');
      return res(200, { storedPaymentMethods: [{ id: 'SP1', brand: 'visa', lastFour: '4242', expiryMonth: '12', expiryYear: '2030' }] });
    });
    const adapter = new AdyenAdapter({ ...baseCfg, fetch });
    const customer: Customer = {
      id: 'ax10m_cus_shopper1', merchantId: 'mrc_1', processorRef: 'shopper1', issuerRegion: 'unknown',
      createdAt: '2026-01-01T00:00:00.000Z', consent: { email: true, sms: false, whatsapp: false, push: false, globallyOptedOut: false },
    };
    const methods = await adapter.listPaymentMethods(customer);
    expect(methods).toHaveLength(1);
    expect(methods[0]!.token).toBe('SP1');
    expect(methods[0]!.last4).toBe('4242');
    expect(methods[0]!.expMonth).toBe(12);
    expect(calls[0]!.url).toContain('shopperReference=shopper1');

    // Adyen auto-updates network tokens server-side → nothing to explicitly fetch.
    expect(await adapter.fetchUpdatedCard(method)).toBeNull();
  });
});
