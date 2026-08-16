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
    const body = webhook('payment_declined', {
      response_code: '20051',
      response_summary: 'Insufficient funds',
      customer: { id: 'cus_1', email: 'jane@example.com', phone: { country_code: '1', number: '4155552671' } },
    });
    const events = await adapter.ingestWebhook({ body, headers: { 'Cko-Signature': computeCheckoutSignature(body, SECRET) } });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    expect(ev.processorEventId).toBe('evt_1');
    const p = ev.payload as {
      invoice: Invoice;
      decline?: { code: DeclineCode; family: DeclineFamily };
      customer?: { email?: string; phone?: string };
    };
    expect(p.invoice.processorRef).toBe('inv_1');
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(p.decline?.family).toBe(DeclineFamily.Soft);
    // contact info flows into the dunning path: email verbatim, phone assembled to E.164
    expect(p.customer?.email).toBe('jane@example.com');
    expect(p.customer?.phone).toBe('+14155552671');
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

describe('reversals (refund / chargeback → payment.reversed)', () => {
  it('maps payment_refunded to payment.reversed (kind refund) with the original invoice id', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const body = webhook('payment_refunded', { amount: 14900, currency: 'USD', response_summary: 'Refunded' });
    const events = await adapter.ingestWebhook({ body, headers: { 'Cko-Signature': computeCheckoutSignature(body, SECRET) } });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('payment.reversed');
    expect(ev.merchantId).toBe('mrc_1');
    const r = ev.payload as { invoiceId: string; amount: number; currency: string; kind: string; reason?: string };
    // invoiceId MUST equal the invoice.id the adapter emits for the original payment (reference 'inv_1')
    expect(r.invoiceId).toBe('ax10m_inv_inv_1');
    expect(r.invoiceId).toBe(invoice.id);
    expect(r.amount).toBe(14900);
    expect(r.currency).toBe('USD');
    expect(r.kind).toBe('refund');
    expect(r.reason).toBe('Refunded');
  });

  it('maps a partial payment_refunded amount, still keyed to the original invoice id', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const body = webhook('payment_refunded', { amount: 5000 });
    const events = await adapter.ingestWebhook({ body, headers: { 'Cko-Signature': computeCheckoutSignature(body, SECRET) } });
    const r = events[0]!.payload as { invoiceId: string; amount: number; kind: string };
    expect(r.invoiceId).toBe('ax10m_inv_inv_1');
    expect(r.amount).toBe(5000); // MINOR units, the reversed delta
    expect(r.kind).toBe('refund');
  });

  it('maps legacy payment_chargeback (payment-shaped data) to payment.reversed (kind chargeback)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const body = webhook('payment_chargeback', { amount: 14900, currency: 'USD' });
    const events = await adapter.ingestWebhook({ body, headers: { 'Cko-Signature': computeCheckoutSignature(body, SECRET) } });
    const ev = events[0]!;
    expect(ev.type).toBe('payment.reversed');
    const r = ev.payload as { invoiceId: string; amount: number; kind: string };
    expect(r.invoiceId).toBe('ax10m_inv_inv_1');
    expect(r.amount).toBe(14900);
    expect(r.kind).toBe('chargeback');
  });

  it('maps dispute_received (dispute-shaped data: payment_reference) to payment.reversed (kind chargeback)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    // Dispute webhooks carry a DISPUTE object, not the payment object: id is the dispute (dsp_...),
    // the merchant reference is `payment_reference`, and amount/currency are the disputed values.
    const body = JSON.stringify({
      id: 'evt_9',
      type: 'dispute_received',
      created_on: '2026-08-14T10:00:00Z',
      data: {
        id: 'dsp_1',
        payment_id: 'pay_1',
        payment_reference: 'inv_1',
        amount: 14900,
        currency: 'USD',
        reason_code: '10.4',
        category: 'fraudulent',
      },
    });
    const events = await adapter.ingestWebhook({ body, headers: { 'Cko-Signature': computeCheckoutSignature(body, SECRET) } });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('payment.reversed');
    const r = ev.payload as { invoiceId: string; amount: number; kind: string; reason?: string };
    // Derived from payment_reference — still equals the original payment's invoice.id
    expect(r.invoiceId).toBe('ax10m_inv_inv_1');
    expect(r.invoiceId).toBe(invoice.id);
    expect(r.amount).toBe(14900);
    expect(r.kind).toBe('chargeback');
    expect(r.reason).toBe('10.4');
  });

  it('falls back to payment_id when a dispute carries no payment_reference', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const body = JSON.stringify({
      id: 'evt_10',
      type: 'dispute_received',
      created_on: '2026-08-14T10:00:00Z',
      data: { id: 'dsp_2', payment_id: 'pay_1', amount: 14900, currency: 'USD', reason_code: '10.4' },
    });
    const events = await adapter.ingestWebhook({ body, headers: { 'Cko-Signature': computeCheckoutSignature(body, SECRET) } });
    const r = events[0]!.payload as { invoiceId: string };
    expect(r.invoiceId).toBe('ax10m_inv_pay_1');
  });

  it('skips a reversal with no reference or non-positive amount', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const zero = webhook('payment_refunded', { amount: 0 });
    expect(await adapter.ingestWebhook({ body: zero, headers: { 'Cko-Signature': computeCheckoutSignature(zero, SECRET) } })).toEqual([]);
  });
});

describe('won disputes (dispute_won / dispute_canceled → payment.reversal_reverted)', () => {
  function disputeWebhook(type: string, data: Record<string, unknown>): string {
    return JSON.stringify({ id: 'evt_w', type, created_on: '2026-08-14T10:00:00Z', data });
  }

  it('maps dispute_won (dispute-shaped data: payment_reference) to payment.reversal_reverted with the original invoice id', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const body = disputeWebhook('dispute_won', {
      id: 'dsp_1', payment_id: 'pay_1', payment_reference: 'inv_1', amount: 14900, currency: 'USD', reason_code: '10.4',
    });
    const events = await adapter.ingestWebhook({ body, headers: { 'Cko-Signature': computeCheckoutSignature(body, SECRET) } });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('payment.reversal_reverted');
    expect(ev.merchantId).toBe('mrc_1');
    const r = ev.payload as { invoiceId: string; amount: number; currency: string; kind: string; reason?: string };
    // invoiceId MUST equal the invoice.id emitted for the original payment AND the chargeback it undoes
    expect(r.invoiceId).toBe('ax10m_inv_inv_1');
    expect(r.invoiceId).toBe(invoice.id);
    expect(r.amount).toBe(14900);
    expect(r.currency).toBe('USD');
    expect(r.kind).toBe('chargeback');
    expect(r.reason).toBe('dispute_won');
  });

  it('maps dispute_canceled (issuer cancelled → funds returned) to payment.reversal_reverted', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const body = disputeWebhook('dispute_canceled', {
      id: 'dsp_2', payment_id: 'pay_1', payment_reference: 'inv_1', amount: 14900, currency: 'USD',
    });
    const events = await adapter.ingestWebhook({ body, headers: { 'Cko-Signature': computeCheckoutSignature(body, SECRET) } });
    const ev = events[0]!;
    expect(ev.type).toBe('payment.reversal_reverted');
    const r = ev.payload as { invoiceId: string; kind: string; reason?: string };
    expect(r.invoiceId).toBe('ax10m_inv_inv_1');
    expect(r.kind).toBe('chargeback');
    expect(r.reason).toBe('dispute_canceled');
  });

  it('falls back to payment_id for the reinstatement when no payment_reference is present', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const body = disputeWebhook('dispute_won', { id: 'dsp_3', payment_id: 'pay_1', amount: 14900, currency: 'USD' });
    const events = await adapter.ingestWebhook({ body, headers: { 'Cko-Signature': computeCheckoutSignature(body, SECRET) } });
    const r = events[0]!.payload as { invoiceId: string };
    expect(r.invoiceId).toBe('ax10m_inv_pay_1');
  });

  it('skips a won dispute with no reference or non-positive amount', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const zero = disputeWebhook('dispute_won', { id: 'dsp_4', payment_reference: 'inv_1', amount: 0, currency: 'USD' });
    expect(await adapter.ingestWebhook({ body: zero, headers: { 'Cko-Signature': computeCheckoutSignature(zero, SECRET) } })).toEqual([]);
  });

  it('does not emit for dispute_resolved (customer already refunded → no funds return)', async () => {
    const { fetch } = makeFetch(() => res(200, {}));
    const adapter = new CheckoutAdapter({ ...baseCfg, fetch });
    const body = disputeWebhook('dispute_resolved', { id: 'dsp_5', payment_reference: 'inv_1', amount: 14900, currency: 'USD' });
    expect(await adapter.ingestWebhook({ body, headers: { 'Cko-Signature': computeCheckoutSignature(body, SECRET) } })).toEqual([]);
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
