import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Customer, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { GoCardlessAdapter } from './adapter.js';
import { computeGoCardlessSignature, mapGoCardlessCause } from './cause-map.js';
import type { FetchLike, FetchResponseLike } from './client.js';

const SECRET = 'whsec_test';

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

const baseCfg = { accessToken: 'tok', webhookSecret: SECRET, merchantId: 'mrc_1', baseUrl: 'https://gc.test' };

const invoice: Invoice = {
  id: 'ax10m_inv_PM1', customerId: 'ax10m_cus_CU1', merchantId: 'mrc_1', processorRef: 'PM1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_MD1', customerId: 'ax10m_cus_CU1', processorRef: 'MD1', token: 'MD1', brand: 'ach' };

function webhookBody(action: string, cause = 'insufficient_funds'): string {
  return JSON.stringify({
    events: [
      { id: 'EV1', created_at: '2026-08-14T10:00:00.000Z', resource_type: 'payments', action, links: { payment: 'PM1' }, details: { cause, description: 'reason', scheme: 'ach' } },
    ],
  });
}

describe('mapGoCardlessCause', () => {
  it('maps bank-debit causes, defaulting unknown to Unknown', () => {
    expect(mapGoCardlessCause('insufficient_funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapGoCardlessCause('mandate_cancelled')).toBe(DeclineCode.RevocationOfAuthorization);
    expect(mapGoCardlessCause('bank_account_closed')).toBe(DeclineCode.ClosedAccount);
    expect(mapGoCardlessCause('mystery')).toBe(DeclineCode.Unknown);
  });
});

describe('ingestWebhook', () => {
  it('verifies the signature, fetches the payment, and flags Success+ auto-retry', async () => {
    const { fetch } = makeFetch((url, init) => {
      if (init.method === 'GET' && url.includes('/payments/PM1')) {
        return res(200, { payments: { id: 'PM1', amount: 14900, currency: 'USD', status: 'failed', retry_if_possible: true, links: { mandate: 'MD1', subscription: 'SUB1', customer: 'CU1' }, created_at: '2026-08-14T10:00:00.000Z' } });
      }
      return res(404, { error: { message: 'not found' } });
    });
    const adapter = new GoCardlessAdapter({ ...baseCfg, fetch });
    const body = webhookBody('failed');
    const sig = computeGoCardlessSignature(body, SECRET);
    const events = await adapter.ingestWebhook({ body, headers: { 'webhook-signature': sig } });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    const p = ev.payload as { invoice: Invoice; decline?: { code: DeclineCode; family: DeclineFamily }; willAutoRetry?: boolean };
    expect(p.invoice.processorRef).toBe('PM1');
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(p.decline?.family).toBe(DeclineFamily.Soft);
    expect(p.willAutoRetry).toBe(true); // deconflict with Success+
  });

  it('rejects a webhook with a bad signature', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new GoCardlessAdapter({ ...baseCfg, fetch });
    await expect(adapter.ingestWebhook({ body: webhookBody('failed'), headers: { 'webhook-signature': 'wrong' } })).rejects.toThrow(/verification failed/);
  });

  it('maps a confirmed payment to invoice.paid', async () => {
    const { fetch } = makeFetch(() => res(200, { payments: { id: 'PM1', amount: 14900, currency: 'USD', status: 'confirmed', links: {} } }));
    const adapter = new GoCardlessAdapter({ ...baseCfg, fetch });
    const body = webhookBody('confirmed');
    const events = await adapter.ingestWebhook({ body, headers: { 'webhook-signature': computeGoCardlessSignature(body, SECRET) } });
    expect(events[0]!.type).toBe('invoice.paid');
  });
});

describe('attemptCharge (retry)', () => {
  it('retries the payment and resolves to pending (bank debit is async)', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/payments/PM1/actions/retry');
      return res(200, { payments: { id: 'PM1', status: 'submitted' } });
    });
    const adapter = new GoCardlessAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('pending');
    expect(r.idempotentReplay).toBe(false);
    expect(calls[0]!.init.headers?.['Idempotency-Key']).toBe('ax10m_charge_abc');
  });

  it('treats an idempotent-conflict (409) as a replay', async () => {
    const { fetch } = makeFetch(() => res(409, { error: { type: 'invalid_state', code: 409, errors: [{ reason: 'idempotent_creation_conflict' }] } }));
    const adapter = new GoCardlessAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.idempotentReplay).toBe(true);
    expect(r.outcome).toBe('pending');
  });

  it('rethrows a non-idempotent error (e.g. inactive mandate)', async () => {
    const { fetch } = makeFetch(() => res(422, { error: { message: 'mandate is not active', code: 422 } }));
    const adapter = new GoCardlessAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow(/mandate is not active/);
  });
});

describe('reconciliation & mandates', () => {
  it('polls failed payments with a cursor', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/payments');
      return res(200, { payments: [{ id: 'PMX', amount: 5000, currency: 'GBP', status: 'failed', links: {} }], meta: { cursors: { after: 'CUR2' } } });
    });
    const adapter = new GoCardlessAdapter({ ...baseCfg, fetch });
    const page = await adapter.listOpenFailures(null);
    expect(page.invoices).toHaveLength(1);
    expect(page.invoices[0]!.amount).toEqual({ amount: 5000, currency: 'GBP' });
    expect(page.nextCursor).toBe('CUR2');
    expect(calls[0]!.url).toContain('status=failed');
  });

  it('lists a customer\'s mandates as payment methods (no card, no PAN)', async () => {
    const { fetch } = makeFetch((url) => {
      expect(url).toContain('/mandates');
      return res(200, { mandates: [{ id: 'MD1', scheme: 'bacs', status: 'active' }] });
    });
    const adapter = new GoCardlessAdapter({ ...baseCfg, fetch });
    const customer: Customer = {
      id: 'ax10m_cus_CU1', merchantId: 'mrc_1', processorRef: 'CU1', issuerRegion: 'unknown',
      createdAt: '2026-01-01T00:00:00.000Z', consent: { email: true, sms: false, whatsapp: false, push: false, globallyOptedOut: false },
    };
    const methods = await adapter.listPaymentMethods(customer);
    expect(methods).toHaveLength(1);
    expect(methods[0]!.token).toBe('MD1');
    expect(methods[0]!.brand).toBe('bacs');
    expect(methods[0]).not.toHaveProperty('last4');

    expect(await adapter.fetchUpdatedCard(method)).toBeNull();
  });
});
