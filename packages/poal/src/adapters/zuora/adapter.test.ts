import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { ZuoraAdapter } from './adapter.js';
import { computeZuoraSignature, mapZuoraDeclineCode } from './decline-map.js';
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

/** Standard OAuth2 token response for the client-credentials call. */
const TOKEN_OK = res(200, { access_token: 'tok_123', token_type: 'bearer', expires_in: 3600 });

const baseCfg = {
  clientId: 'cid',
  clientSecret: 'secret',
  merchantId: 'mrc_1',
  webhookSecret: 'whsec',
  baseUrl: 'https://zuora.test',
};

const invoice: Invoice = {
  id: 'ax10m_inv_INV1', customerId: 'ax10m_cus_ACC1', merchantId: 'mrc_1', processorRef: 'INV1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_PM1', customerId: 'ax10m_cus_ACC1', processorRef: 'PM1', token: 'PM1' };

describe('mapZuoraDeclineCode', () => {
  it('maps keywords and defaults unknown to Unknown', () => {
    expect(mapZuoraDeclineCode('Insufficient Funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapZuoraDeclineCode('Card expired')).toBe(DeclineCode.ExpiredCard);
    expect(mapZuoraDeclineCode('Do Not Honor')).toBe(DeclineCode.DoNotHonor);
    expect(mapZuoraDeclineCode('pick up card')).toBe(DeclineCode.PickupCard);
    expect(mapZuoraDeclineCode('Invalid account number')).toBe(DeclineCode.InvalidCard);
    expect(mapZuoraDeclineCode('who knows')).toBe(DeclineCode.Unknown);
    expect(mapZuoraDeclineCode(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('attemptCharge', () => {
  it('gets a token, creates a payment applied to the invoice, passes the idempotency key, and reports success', async () => {
    const { fetch, calls } = makeFetch((url) => {
      if (url.includes('/oauth/token')) return TOKEN_OK;
      if (url.endsWith('/v1/payments')) return res(200, { success: true, id: 'PAY1', status: 'Processed' });
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = new ZuoraAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.attempt.status).toBe('succeeded');

    const payCall = calls.find((c) => c.url.endsWith('/v1/payments'))!;
    expect(payCall.init.headers?.Authorization).toBe('Bearer tok_123');
    expect(payCall.init.headers?.['Idempotency-Key']).toBe('ax10m_charge_abc');
    expect(payCall.init.body).toContain('"invoiceId":"INV1"');
    expect(payCall.init.body).toContain('"paymentMethodId":"PM1"');
    expect(payCall.init.body).toContain('"amount":149'); // 14900 minor → 149 major
    expect(payCall.init.body).not.toContain('pan');
    // token was fetched once and cached.
    expect(calls.filter((c) => c.url.includes('/oauth/token'))).toHaveLength(1);
  });

  it('treats a Payment left in Error status as a decline (not an error), with a mapped code', async () => {
    const { fetch } = makeFetch((url) => {
      if (url.includes('/oauth/token')) return TOKEN_OK;
      if (url.endsWith('/v1/payments')) return res(200, { success: true, id: 'PAY2', status: 'Error', gatewayResponse: 'Insufficient funds' });
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = new ZuoraAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.status).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.InsufficientFunds);
  });

  it('rethrows an infra/auth error so the saga can retry', async () => {
    const { fetch } = makeFetch((url) => {
      if (url.includes('/oauth/token')) return TOKEN_OK;
      if (url.endsWith('/v1/payments')) return res(500, { success: false, reasons: [{ message: 'internal error' }] });
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = new ZuoraAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow();
  });

  it('rethrows a success:false request rejection (validation) so the saga can retry', async () => {
    const { fetch } = makeFetch((url) => {
      if (url.includes('/oauth/token')) return TOKEN_OK;
      if (url.endsWith('/v1/payments')) return res(200, { success: false, reasons: [{ code: 5000, message: 'Invalid invoiceId' }] });
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = new ZuoraAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow();
  });
});

describe('ingestWebhook', () => {
  const failedBody = JSON.stringify({
    eventType: 'PaymentFailed',
    eventTime: '2026-08-14T10:00:00Z',
    invoice: { id: 'INV1', accountId: 'ACC1', balance: 149.0, currency: 'USD', status: 'Posted' },
    payment: { id: 'PAY9', status: 'Error', gatewayResponse: 'Do Not Honor', gatewayResponseCode: '05' },
  });
  const sign = (body: string) => ({ 'zuora-signature': computeZuoraSignature(body, 'whsec') });

  it('verifies the Zuora-Signature and normalizes a payment-failed callout to invoice.failed', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ZuoraAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: failedBody, headers: sign(failedBody) });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    expect(ev.processorEventId).toBe('PAY9');
    const p = ev.payload as { invoice: Invoice; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.processorRef).toBe('INV1');
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.decline?.code).toBe(DeclineCode.DoNotHonor);
    expect(p.decline?.family).toBe(DeclineFamily.Gray);
  });

  it('enriches contact from the account bill-to (GET /v1/accounts/:id) — work email + phone', async () => {
    const { fetch, calls } = makeFetch((url) => {
      if (url.includes('/oauth/token')) return TOKEN_OK;
      if (url.includes('/v1/accounts/ACC1')) return res(200, { billToContact: { workEmail: 'dana@example.test', workPhone: '+15555550123' } });
      return res(200, {});
    });
    const adapter = new ZuoraAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: failedBody, headers: sign(failedBody) });
    const p = events[0]!.payload as { customer?: { email?: string; phone?: string } };
    expect(p.customer?.email).toBe('dana@example.test');
    expect(p.customer?.phone).toBe('+15555550123');
    expect(calls.some((c) => c.url.includes('/v1/accounts/ACC1'))).toBe(true); // keyed off callout accountId
  });

  it('still emits invoice.failed when the account lookup fails (best-effort)', async () => {
    const { fetch } = makeFetch((url) => {
      if (url.includes('/oauth/token')) return TOKEN_OK;
      return res(500, { message: 'boom' }); // /v1/accounts fails
    });
    const adapter = new ZuoraAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: failedBody, headers: sign(failedBody) });
    expect(events).toHaveLength(1); // enrichment failure did NOT drop the event
    const p = events[0]!.payload as { customer?: { email?: string } };
    expect(p.customer?.email).toBeUndefined();
  });

  it('rejects a callout whose signature does not match', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ZuoraAdapter({ ...baseCfg, fetch });
    await expect(
      adapter.ingestWebhook({ body: failedBody, headers: { 'zuora-signature': 'deadbeef' } }),
    ).rejects.toThrow(/verification failed/);
  });

  it('refuses to process when no webhook secret is configured (fail closed)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ZuoraAdapter({ clientId: 'cid', clientSecret: 'secret', merchantId: 'mrc_1', baseUrl: 'https://zuora.test', fetch });
    await expect(adapter.ingestWebhook({ body: failedBody, headers: sign(failedBody) })).rejects.toThrow(/not configured/);
  });

  it('maps a payment-processed callout to invoice.paid', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new ZuoraAdapter({ ...baseCfg, fetch });
    const body = JSON.stringify({ eventType: 'PaymentProcessed', eventTime: '2026-08-14T10:00:00Z', invoice: { id: 'INV1', accountId: 'ACC1', balance: 0, currency: 'USD', status: 'Paid' }, payment: { id: 'PAY10', status: 'Processed' } });
    const paid = await adapter.ingestWebhook({ body, headers: sign(body) });
    expect(paid[0]!.type).toBe('invoice.paid');
  });
});

describe('reconciliation', () => {
  it('lists open failures (positive balance) and paginates via the nextPage token', async () => {
    const { fetch, calls } = makeFetch((url) => {
      if (url.includes('/oauth/token')) return TOKEN_OK;
      if (url.includes('/v1/invoices')) {
        return res(200, {
          success: true,
          invoices: [
            { id: 'INV9', accountId: 'ACC9', balance: 50.0, currency: 'USD', status: 'Posted', invoiceDate: '2026-08-01' },
            { id: 'INV0', accountId: 'ACC0', balance: 0, currency: 'USD', status: 'Posted', invoiceDate: '2026-08-01' }, // fully paid → excluded
          ],
          nextPage: 'https://zuora.test/v1/invoices?status=Posted&pageToken=TOK2',
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = new ZuoraAdapter({ ...baseCfg, fetch });
    const page = await adapter.listOpenFailures(null);
    expect(page.invoices).toHaveLength(1);
    expect(page.invoices[0]!.processorRef).toBe('INV9');
    expect(page.invoices[0]!.amount.amount).toBe(5000);
    expect(page.nextCursor).toBe('TOK2');
    expect(calls.find((c) => c.url.includes('/v1/invoices'))!.url).toContain('status=Posted');
  });
});
