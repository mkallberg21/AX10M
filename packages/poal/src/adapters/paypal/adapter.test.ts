import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { PayPalAdapter } from './adapter.js';
import { mapPaypalDeclineCode } from './decline-map.js';
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
const TOKEN_OK = res(200, { access_token: 'tok_123', token_type: 'Bearer', expires_in: 32400 });

const baseCfg = {
  clientId: 'cid',
  clientSecret: 'secret',
  merchantId: 'mrc_1',
  baseUrl: 'https://paypal.test',
};

const invoice: Invoice = {
  id: 'ax10m_inv_inv_1', customerId: 'ax10m_cus_PAYER1', merchantId: 'mrc_1', processorRef: 'inv_1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_TOKEN', customerId: 'ax10m_cus_PAYER1', processorRef: 'TOKEN', token: 'TOKEN' };

describe('mapPaypalDeclineCode', () => {
  it('maps known issue names / codes and defaults unknown to Unknown', () => {
    expect(mapPaypalDeclineCode('INSTRUMENT_DECLINED')).toBe(DeclineCode.DoNotHonor);
    expect(mapPaypalDeclineCode('INSUFFICIENT_FUNDS')).toBe(DeclineCode.InsufficientFunds);
    expect(mapPaypalDeclineCode('51')).toBe(DeclineCode.InsufficientFunds);
    expect(mapPaypalDeclineCode('EXPIRED_CARD')).toBe(DeclineCode.ExpiredCard);
    expect(mapPaypalDeclineCode('CARD_CLOSED')).toBe(DeclineCode.ClosedAccount);
    expect(mapPaypalDeclineCode('PAYER_ACTION_REQUIRED')).toBe(DeclineCode.AuthenticationRequired);
    expect(mapPaypalDeclineCode('TRY_AGAIN_LATER')).toBe(DeclineCode.TryAgainLater);
    expect(mapPaypalDeclineCode('who_knows')).toBe(DeclineCode.Unknown);
    expect(mapPaypalDeclineCode(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('attemptCharge', () => {
  it('gets an access token, creates+captures an order, passes the idempotency key, and reports success', async () => {
    const { fetch, calls } = makeFetch((url) => {
      if (url.includes('/v1/oauth2/token')) return TOKEN_OK;
      // Single-response COMPLETED order: we tolerate this and skip the capture call.
      if (url.endsWith('/v2/checkout/orders')) {
        return res(200, {
          id: 'ORDER1',
          status: 'COMPLETED',
          purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED' }] } }],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = new PayPalAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.attempt.status).toBe('succeeded');
    expect(r.idempotentReplay).toBe(false);

    // OAuth token was fetched once (Basic auth) and cached; the order carried the
    // deterministic idempotency key on PayPal-Request-Id + the vault token (no PAN).
    const tokenCall = calls.find((c) => c.url.includes('/v1/oauth2/token'))!;
    expect(tokenCall.init.headers?.Authorization).toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`);
    const orderCall = calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
    expect(orderCall.init.headers?.Authorization).toBe('Bearer tok_123');
    expect(orderCall.init.headers?.['PayPal-Request-Id']).toBe('ax10m_charge_abc');
    expect(orderCall.init.body).toContain('"id":"TOKEN"');
    expect(orderCall.init.body).toContain('"value":"149.00"');
    expect(orderCall.init.body).not.toContain('pan');
  });

  it('captures a CREATED order with the SAME idempotency key and reports a decline as an outcome (not an error)', async () => {
    const { fetch, calls } = makeFetch((url) => {
      if (url.includes('/v1/oauth2/token')) return TOKEN_OK;
      if (url.endsWith('/v2/checkout/orders')) return res(201, { id: 'ORDER1', status: 'CREATED' });
      if (url.includes('/v2/checkout/orders/ORDER1/capture')) {
        // 422 UNPROCESSABLE_ENTITY with an issuer decline → a decline, not an error.
        return res(422, {
          name: 'UNPROCESSABLE_ENTITY',
          message: 'The instrument was declined.',
          details: [{ issue: 'INSTRUMENT_DECLINED', description: 'The instrument was declined.' }],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = new PayPalAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.status).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.DoNotHonor);

    // Both the create and the capture carried the identical PayPal-Request-Id.
    const captureCall = calls.find((c) => c.url.includes('/capture'))!;
    expect(captureCall.init.headers?.['PayPal-Request-Id']).toBe('ax10m_charge_abc');
    // Token was fetched once and reused across create + capture (in-memory cache).
    expect(calls.filter((c) => c.url.includes('/v1/oauth2/token'))).toHaveLength(1);
  });

  it('rethrows an infra/auth error so the saga can retry', async () => {
    const { fetch } = makeFetch((url) => {
      if (url.includes('/v1/oauth2/token')) return TOKEN_OK;
      if (url.endsWith('/v2/checkout/orders')) return res(500, { name: 'INTERNAL_SERVER_ERROR', message: 'oops' });
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = new PayPalAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow();
  });
});

describe('ingestWebhook', () => {
  const deniedBody = JSON.stringify({
    id: 'ev_1',
    event_type: 'PAYMENT.CAPTURE.DENIED',
    create_time: '2026-08-14T10:00:00Z',
    resource: {
      id: 'CAP1',
      status: 'DECLINED',
      amount: { value: '149.00', currency_code: 'USD' },
      invoice_id: 'inv_1',
      payer: { payer_id: 'PAYER1', email_address: 'dana@example.test', phone: { phone_number: { national_number: '5555550123' } } },
      status_details: { reason: 'INSTRUMENT_DECLINED' },
    },
  });
  const txHeaders = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.paypal.com/cert',
    'paypal-transmission-id': 't_1',
    'paypal-transmission-sig': 'sig',
    'paypal-transmission-time': '2026-08-14T10:00:00Z',
  };

  it('verifies via the verify-webhook-signature API (SUCCESS) and normalizes CAPTURE.DENIED to invoice.failed', async () => {
    const { fetch, calls } = makeFetch((url) => {
      if (url.includes('/v1/oauth2/token')) return TOKEN_OK;
      if (url.includes('/v1/notifications/verify-webhook-signature')) return res(200, { verification_status: 'SUCCESS' });
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = new PayPalAdapter({ ...baseCfg, fetch, webhookId: 'WH-123' });
    const events = await adapter.ingestWebhook({ body: deniedBody, headers: txHeaders });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    expect(ev.processorEventId).toBe('ev_1');
    const p = ev.payload as { invoice: Invoice; customer?: { email?: string; phone?: string }; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.processorRef).toBe('inv_1');
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.invoice.customerId).toBe('ax10m_cus_PAYER1');
    expect(p.decline?.code).toBe(DeclineCode.DoNotHonor);
    expect(p.decline?.family).toBe(DeclineFamily.Gray);
    // Email is the reliable PayPal contact; the payer phone is national-only → dropped by toE164.
    expect(p.customer?.email).toBe('dana@example.test');
    expect(p.customer?.phone).toBeUndefined();

    // The verify call forwarded the webhook id + transmission headers.
    const verifyCall = calls.find((c) => c.url.includes('/verify-webhook-signature'))!;
    expect(verifyCall.init.body).toContain('"webhook_id":"WH-123"');
    expect(verifyCall.init.body).toContain('"transmission_id":"t_1"');
  });

  it('fails closed when verify-webhook-signature does NOT return SUCCESS', async () => {
    const { fetch } = makeFetch((url) => {
      if (url.includes('/v1/oauth2/token')) return TOKEN_OK;
      if (url.includes('/v1/notifications/verify-webhook-signature')) return res(200, { verification_status: 'FAILURE' });
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = new PayPalAdapter({ ...baseCfg, fetch, webhookId: 'WH-123' });
    await expect(adapter.ingestWebhook({ body: deniedBody, headers: txHeaders })).rejects.toThrow(/did not return SUCCESS/);
  });

  it('refuses to process when no webhookId is configured (fail closed)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new PayPalAdapter({ ...baseCfg, fetch }); // no webhookId
    await expect(adapter.ingestWebhook({ body: deniedBody, headers: txHeaders })).rejects.toThrow(/not configured/);
  });

  it('normalizes CAPTURE.COMPLETED to invoice.paid', async () => {
    const { fetch } = makeFetch((url) => {
      if (url.includes('/v1/oauth2/token')) return TOKEN_OK;
      if (url.includes('/v1/notifications/verify-webhook-signature')) return res(200, { verification_status: 'SUCCESS' });
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = new PayPalAdapter({ ...baseCfg, fetch, webhookId: 'WH-123' });
    const paid = await adapter.ingestWebhook({
      body: JSON.stringify({
        id: 'ev_2',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        create_time: '2026-08-14T10:00:00Z',
        resource: { id: 'CAP2', status: 'COMPLETED', amount: { value: '149.00', currency_code: 'USD' }, invoice_id: 'inv_1' },
      }),
      headers: txHeaders,
    });
    expect(paid[0]!.type).toBe('invoice.paid');
  });
});

describe('ingestWebhook — reversals (refund / dispute → payment.reversed)', () => {
  const txHeaders = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.paypal.com/cert',
    'paypal-transmission-id': 't_1',
    'paypal-transmission-sig': 'sig',
    'paypal-transmission-time': '2026-08-14T10:00:00Z',
  };
  const okFetch = () =>
    makeFetch((url) => {
      if (url.includes('/v1/oauth2/token')) return TOKEN_OK;
      if (url.includes('/v1/notifications/verify-webhook-signature')) return res(200, { verification_status: 'SUCCESS' });
      throw new Error(`unexpected url ${url}`);
    });

  it('normalizes PAYMENT.CAPTURE.REFUNDED to payment.reversed (kind refund) using the merchant invoice_id', async () => {
    const { fetch } = okFetch();
    const adapter = new PayPalAdapter({ ...baseCfg, fetch, webhookId: 'WH-123' });
    const events = await adapter.ingestWebhook({
      body: JSON.stringify({
        id: 'ev_r1',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        create_time: '2026-08-14T11:00:00Z',
        resource: {
          id: 'REF1', // refund id — deliberately NOT the capture id
          status: 'COMPLETED',
          amount: { value: '149.00', currency_code: 'USD' },
          invoice_id: 'inv_1',
          links: [{ rel: 'up', href: 'https://paypal.test/v2/payments/captures/CAP1', method: 'GET' }],
        },
      }),
      headers: txHeaders,
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('payment.reversed');
    expect(ev.processorEventId).toBe('ev_r1');
    const r = ev.payload as { invoiceId: string; amount: number; currency: string; kind: string };
    // SAME id mapResourceInvoice built for the original (invoice_id-based) capture.
    expect(r.invoiceId).toBe('ax10m_inv_inv_1');
    expect(r.amount).toBe(14900);
    expect(r.currency).toBe('USD');
    expect(r.kind).toBe('refund');
  });

  it('maps a driven-charge PARTIAL refund (no invoice_id) to the SAME id via the capture up-link — round-trips with the original invoice.id', async () => {
    const { fetch } = okFetch();
    const adapter = new PayPalAdapter({ ...baseCfg, fetch, webhookId: 'WH-123' });
    // A driven capture carries NO invoice_id/custom_id → invoice.id falls back to the capture id.
    const paid = await adapter.ingestWebhook({
      body: JSON.stringify({
        id: 'ev_p1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        create_time: '2026-08-14T10:00:00Z',
        resource: { id: 'CAP1', status: 'COMPLETED', amount: { value: '80.00', currency_code: 'USD' } },
      }),
      headers: txHeaders,
    });
    const originalId = (paid[0]!.payload as { invoice: Invoice }).invoice.id;
    expect(originalId).toBe('ax10m_inv_CAP1');

    // A partial refund of that capture → clawback of the refunded delta, SAME invoice id
    // (resolved from the rel:"up" capture link, NOT the refund's own id REF2).
    const events = await adapter.ingestWebhook({
      body: JSON.stringify({
        id: 'ev_r2',
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        create_time: '2026-08-14T12:00:00Z',
        resource: {
          id: 'REF2',
          status: 'COMPLETED',
          amount: { value: '50.00', currency_code: 'USD' },
          links: [{ rel: 'up', href: 'https://paypal.test/v2/payments/captures/CAP1', method: 'GET' }],
        },
      }),
      headers: txHeaders,
    });
    expect(events[0]!.type).toBe('payment.reversed');
    const r = events[0]!.payload as { invoiceId: string; amount: number; kind: string };
    expect(r.invoiceId).toBe(originalId); // clawback lands on the recovery we drove
    expect(r.amount).toBe(5000); // partial-refund delta in minor units
    expect(r.kind).toBe('refund');
  });

  it('normalizes CUSTOMER.DISPUTE.CREATED to payment.reversed (kind chargeback) via seller_transaction_id', async () => {
    const { fetch } = okFetch();
    const adapter = new PayPalAdapter({ ...baseCfg, fetch, webhookId: 'WH-123' });
    const events = await adapter.ingestWebhook({
      body: JSON.stringify({
        id: 'ev_d1',
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        create_time: '2026-08-14T13:00:00Z',
        resource: {
          dispute_id: 'PP-D-1',
          reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          status: 'OPEN',
          dispute_amount: { value: '149.00', currency_code: 'USD' },
          disputed_transactions: [{ seller_transaction_id: 'CAP1', buyer_transaction_id: 'B1' }],
        },
      }),
      headers: txHeaders,
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('payment.reversed');
    const r = ev.payload as { invoiceId: string; amount: number; kind: string; reason?: string };
    // seller_transaction_id == the capture id → matches the driven capture's invoice.id fallback.
    expect(r.invoiceId).toBe('ax10m_inv_CAP1');
    expect(r.amount).toBe(14900);
    expect(r.kind).toBe('chargeback');
    expect(r.reason).toBe('MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
  });

  it('skips a dispute it cannot map to a recovery invoice id (no seller_transaction_id / invoice_number / custom)', async () => {
    const { fetch } = okFetch();
    const adapter = new PayPalAdapter({ ...baseCfg, fetch, webhookId: 'WH-123' });
    const events = await adapter.ingestWebhook({
      body: JSON.stringify({
        id: 'ev_d2',
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        create_time: '2026-08-14T13:00:00Z',
        resource: { dispute_id: 'PP-D-2', dispute_amount: { value: '10.00', currency_code: 'USD' }, disputed_transactions: [{}] },
      }),
      headers: txHeaders,
    });
    expect(events).toEqual([]);
  });

  it('normalizes a SELLER-favour CUSTOMER.DISPUTE.RESOLVED to payment.reversal_reverted (kind chargeback, SAME id/amount as CREATED)', async () => {
    const { fetch } = okFetch();
    const adapter = new PayPalAdapter({ ...baseCfg, fetch, webhookId: 'WH-123' });
    const events = await adapter.ingestWebhook({
      body: JSON.stringify({
        id: 'ev_d3',
        event_type: 'CUSTOMER.DISPUTE.RESOLVED',
        create_time: '2026-08-14T14:00:00Z',
        resource: {
          dispute_id: 'PP-D-1',
          reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          status: 'RESOLVED',
          dispute_amount: { value: '149.00', currency_code: 'USD' },
          // Resolved in the MERCHANT's favour → funds reinstated.
          dispute_outcome: { outcome_code: 'RESOLVED_SELLER_FAVOUR' },
          disputed_transactions: [{ seller_transaction_id: 'CAP1', buyer_transaction_id: 'B1' }],
        },
      }),
      headers: txHeaders,
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('payment.reversal_reverted');
    expect(ev.processorEventId).toBe('ev_d3');
    const r = ev.payload as { invoiceId: string; amount: number; currency: string; kind: string };
    // Reinstatement lands on the SAME recovery invoice id the CREATED reversal used
    // (seller_transaction_id == capture id == the driven-capture invoice.id fallback).
    expect(r.invoiceId).toBe('ax10m_inv_CAP1');
    expect(r.amount).toBe(14900);
    expect(r.currency).toBe('USD');
    expect(r.kind).toBe('chargeback');
  });

  it('does NOT emit for a BUYER-favour CUSTOMER.DISPUTE.RESOLVED (chargeback stands → no-op)', async () => {
    const { fetch } = okFetch();
    const adapter = new PayPalAdapter({ ...baseCfg, fetch, webhookId: 'WH-123' });
    const events = await adapter.ingestWebhook({
      body: JSON.stringify({
        id: 'ev_d4',
        event_type: 'CUSTOMER.DISPUTE.RESOLVED',
        create_time: '2026-08-14T14:30:00Z',
        resource: {
          dispute_id: 'PP-D-2',
          status: 'RESOLVED',
          dispute_amount: { value: '149.00', currency_code: 'USD' },
          // Resolved in the CUSTOMER's favour → the chargeback stands, no reinstatement.
          dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR' },
          disputed_transactions: [{ seller_transaction_id: 'CAP1' }],
        },
      }),
      headers: txHeaders,
    });
    expect(events).toEqual([]);
  });
});
