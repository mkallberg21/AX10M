import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Customer, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { RecurlyAdapter } from './adapter.js';
import { mapRecurlyDeclineCode } from './decline-map.js';
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
const baseCfg = { apiKey: 'test_key', merchantId: 'mrc_1', baseUrl: 'https://recurly.test', webhookUser: 'u', webhookPassword: 'p' };
const AUTH = { authorization: basicAuth('u', 'p') };

const invoice: Invoice = {
  id: 'ax10m_inv_inv_1', customerId: 'ax10m_cus_acct1', merchantId: 'mrc_1', processorRef: 'inv_1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_bi_1', customerId: 'ax10m_cus_acct1', processorRef: 'bi_1', token: 'bi_1' };

describe('mapRecurlyDeclineCode', () => {
  it('maps known codes and defaults unknown to Unknown', () => {
    expect(mapRecurlyDeclineCode('insufficient_funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapRecurlyDeclineCode('EXPIRED_CARD')).toBe(DeclineCode.ExpiredCard);
    expect(mapRecurlyDeclineCode('call_issuer')).toBe(DeclineCode.DoNotHonor);
    expect(mapRecurlyDeclineCode('fraud')).toBe(DeclineCode.Fraudulent);
    expect(mapRecurlyDeclineCode('who_knows')).toBe(DeclineCode.Unknown);
    expect(mapRecurlyDeclineCode(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('attemptCharge', () => {
  it('collects the invoice, passes the idempotency key, and reports success', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/invoices/inv_1/collect');
      return res(200, { id: 'inv_1', state: 'paid', currency: 'USD', transactions: [{ uuid: 'txn_ok', status: 'success' }] });
    });
    const adapter = new RecurlyAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.idempotentReplay).toBe(false);
    expect(r.attempt.status).toBe('succeeded');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.init.headers?.['Idempotency-Key']).toBe('ax10m_charge_abc');
    expect(calls[0]!.init.headers?.Authorization).toBe(basicAuth('test_key', ''));
    expect(calls[0]!.init.headers?.Accept).toContain('application/vnd.recurly');
    expect(calls[0]!.init.body).toContain('transaction');
  });

  it('treats a 422 transaction error as a decline, not an error, with a mapped code', async () => {
    const { fetch } = makeFetch(() =>
      res(422, { error: { type: 'transaction', message: 'Your card was declined.', transaction_error: { transaction_id: 'txn_x', code: 'insufficient_funds', decline_code: 'insufficient_funds' } } }),
    );
    const adapter = new RecurlyAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.status).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.InsufficientFunds);
  });

  it('rethrows an infra error so the saga can retry', async () => {
    const { fetch } = makeFetch(() => res(500, { error: { type: 'internal_server_error', message: 'oops' } }));
    const adapter = new RecurlyAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow();
  });
});

describe('ingestWebhook', () => {
  const failedXml = `<?xml version="1.0"?>
    <failed_payment_notification>
      <account><account_code>acct1</account_code></account>
      <invoice><uuid>inv_1</uuid><state>past_due</state><currency>USD</currency><total_in_cents>14900</total_in_cents></invoice>
      <transaction><uuid>txn_1</uuid><status>declined</status><error_code>insufficient_funds</error_code><message>Not enough funds</message></transaction>
    </failed_payment_notification>`;

  it('normalizes failed_payment_notification into a canonical invoice.failed with a mapped decline', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new RecurlyAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: failedXml, headers: AUTH });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    const p = ev.payload as { invoice: Invoice; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.processorRef).toBe('inv_1');
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(p.decline?.family).toBe(DeclineFamily.Soft);
  });

  it('rejects a webhook whose Basic auth does not match', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new RecurlyAdapter({ ...baseCfg, fetch });
    await expect(
      adapter.ingestWebhook({ body: failedXml, headers: { authorization: basicAuth('u', 'WRONG') } }),
    ).rejects.toThrow(/auth verification failed/);
  });

  it('refuses to process when no webhook credentials are configured (fail closed)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new RecurlyAdapter({ apiKey: 'k', merchantId: 'mrc_1', baseUrl: 'https://recurly.test', fetch });
    await expect(adapter.ingestWebhook({ body: failedXml, headers: {} })).rejects.toThrow(/not configured/);
  });

  it('maps successful_payment_notification to invoice.paid and ignores unhandled notifications', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new RecurlyAdapter({ ...baseCfg, fetch });
    const paidXml = `<successful_payment_notification><invoice><uuid>inv_1</uuid><state>paid</state><currency>USD</currency><total_in_cents>0</total_in_cents></invoice></successful_payment_notification>`;
    const paid = await adapter.ingestWebhook({ body: paidXml, headers: AUTH });
    expect(paid[0]!.type).toBe('invoice.paid');
    const noop = await adapter.ingestWebhook({ body: `<new_dunning_event_notification></new_dunning_event_notification>`, headers: AUTH });
    expect(noop).toEqual([]);
  });
});

describe('reconciliation & payment methods', () => {
  it('lists open failures and paginates via the next cursor link', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/invoices');
      return res(200, {
        object: 'list',
        has_more: true,
        next: '/invoices?state=past_due&cursor=CURSOR2',
        data: [{ uuid: 'inv_9', account: { code: 'acct9' }, currency: 'USD', total_in_cents: 5000, state: 'past_due', created_at: '2026-08-01T00:00:00Z' }],
      });
    });
    const adapter = new RecurlyAdapter({ ...baseCfg, fetch });
    const page = await adapter.listOpenFailures(null);
    expect(page.invoices).toHaveLength(1);
    expect(page.invoices[0]!.processorRef).toBe('inv_9');
    expect(page.invoices[0]!.amount.amount).toBe(5000);
    expect(page.invoices[0]!.status).toBe('open');
    expect(page.nextCursor).toBe('CURSOR2');
    expect(calls[0]!.url).toContain('state=past_due');
  });

  it("lists an account's tokenized billing infos (no PAN)", async () => {
    const { fetch } = makeFetch(() =>
      res(200, { object: 'list', data: [{ id: 'bi_1', account_id: 'acct1', payment_method: { card_type: 'Visa', first_six: '424242', last_four: '4242', exp_month: 12, exp_year: 2030, gateway_token: 'tok_gw' } }] }),
    );
    const adapter = new RecurlyAdapter({ ...baseCfg, fetch });
    const customer: Customer = {
      id: 'ax10m_cus_acct1', merchantId: 'mrc_1', processorRef: 'acct1', issuerRegion: 'unknown',
      createdAt: '2026-01-01T00:00:00.000Z', consent: { email: true, sms: false, whatsapp: false, push: false, globallyOptedOut: false },
    };
    const methods = await adapter.listPaymentMethods(customer);
    expect(methods).toHaveLength(1);
    expect(methods[0]!.token).toBe('tok_gw');
    expect(methods[0]!.last4).toBe('4242');
    expect(methods[0]).not.toHaveProperty('pan');
  });
});
