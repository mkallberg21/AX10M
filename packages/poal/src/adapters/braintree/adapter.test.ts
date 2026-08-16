import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Customer, type Invoice, type PaymentMethod, type ReversalPayload } from '@ax10m/canonical';
import { BraintreeAdapter } from './adapter.js';
import { mapBraintreeDeclineCode, signBraintreePayload } from './response-map.js';
import type { FetchLike, FetchResponseLike } from './client.js';

const PUB = 'pubkey';
const PRIV = 'privkey';

function res(status: number, xml: string): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => xml,
    json: async () => ({}),
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

const baseCfg = {
  merchantId: 'mrc_1',
  braintreeMerchantId: 'bt_merchant',
  publicKey: PUB,
  privateKey: PRIV,
  baseUrl: 'https://bt.test',
};

const invoice: Invoice = {
  id: 'ax10m_inv_inv_1', customerId: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'inv_1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_TOKEN', customerId: 'ax10m_cus_c1', processorRef: 'TOKEN', token: 'TOKEN' };

function notificationBody(kind: string, opts: { status: string; code?: string; email?: string; phone?: string; intlPhone?: { countryCode: string; nationalNumber: string } } = { status: 'processor_declined' }): string {
  const customerInner =
    (opts.email ? `<email>${opts.email}</email>` : '') +
    (opts.intlPhone ? `<international-phone><country-code>${opts.intlPhone.countryCode}</country-code><national-number>${opts.intlPhone.nationalNumber}</national-number></international-phone>` : '') +
    (opts.phone ? `<phone>${opts.phone}</phone>` : '');
  const xml =
    `<notification><kind>${kind}</kind>` +
    `<timestamp type="datetime">2026-08-14T10:00:00Z</timestamp>` +
    `<subject><subscription><id>sub_1</id><transactions type="array"><transaction>` +
    `<id>txn_1</id><status>${opts.status}</status><amount>49.99</amount><currency-iso-code>USD</currency-iso-code>` +
    (customerInner ? `<customer>${customerInner}</customer>` : '') +
    (opts.code ? `<processor-response-code>${opts.code}</processor-response-code><processor-response-text>Reason</processor-response-text>` : '') +
    `</transaction></transactions></subscription></subject></notification>`;
  const b64 = Buffer.from(xml).toString('base64');
  const sig = signBraintreePayload(b64, PUB, PRIV);
  return `bt_signature=${encodeURIComponent(sig)}&bt_payload=${encodeURIComponent(b64)}`;
}

// Braintree `dispute_opened` webhook — <subject><dispute>…<transaction>…</transaction></dispute>.
// The disputed transaction's <order-id> is the invoice ref AX10M stamped at charge time
// (attemptCharge sets order-id = invoice.processorRef = the subscription ref), so it maps back
// to the recovery's invoice id. Currency is at the dispute level; there is NO <subscription-id>.
function disputeBody(opts: { disputeKind?: string; orderId?: string | null; amount?: string; currency?: string; reason?: string; disputeId?: string } = {}): string {
  const orderIdEl = opts.orderId === null ? '<order-id nil="true"/>' : `<order-id>${opts.orderId ?? 'sub_1'}</order-id>`;
  const xml =
    `<notification><kind>dispute_opened</kind>` +
    `<timestamp type="datetime">2026-08-14T10:00:00Z</timestamp>` +
    `<subject><dispute>` +
    `<id>${opts.disputeId ?? 'dsp_1'}</id>` +
    `<kind>${opts.disputeKind ?? 'chargeback'}</kind>` +
    `<amount>${opts.amount ?? '49.99'}</amount>` +
    `<currency-iso-code>${opts.currency ?? 'USD'}</currency-iso-code>` +
    (opts.reason ? `<reason>${opts.reason}</reason>` : '') +
    `<transaction><id>txn_1</id><amount>${opts.amount ?? '49.99'}</amount>` +
    `<created-at>2026-08-14T10:00:00Z</created-at>${orderIdEl}` +
    `<purchase-order-number nil="true"/><payment-instrument-subtype>Visa</payment-instrument-subtype>` +
    `</transaction>` +
    `</dispute></subject></notification>`;
  const b64 = Buffer.from(xml).toString('base64');
  const sig = signBraintreePayload(b64, PUB, PRIV);
  return `bt_signature=${encodeURIComponent(sig)}&bt_payload=${encodeURIComponent(b64)}`;
}

describe('mapBraintreeDeclineCode', () => {
  it('maps processor-response codes and defaults unknown to Unknown', () => {
    expect(mapBraintreeDeclineCode('2001')).toBe(DeclineCode.InsufficientFunds);
    expect(mapBraintreeDeclineCode('2004')).toBe(DeclineCode.ExpiredCard);
    expect(mapBraintreeDeclineCode('2013')).toBe(DeclineCode.StolenCard);
    expect(mapBraintreeDeclineCode('9999')).toBe(DeclineCode.Unknown);
    expect(mapBraintreeDeclineCode(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('ingestWebhook', () => {
  it('verifies the signature and normalizes a failed subscription charge', async () => {
    const { fetch } = makeFetch(() => res(200, ''));
    const adapter = new BraintreeAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({
      body: notificationBody('subscription_charged_unsuccessfully', { status: 'processor_declined', code: '2001', email: 'dana@example.test', phone: '+15555550123' }),
      headers: {},
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    const p = ev.payload as { invoice: Invoice; customer?: { email?: string; phone?: string }; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.processorRef).toBe('sub_1');
    expect(p.invoice.amount).toEqual({ amount: 4999, currency: 'USD' });
    expect(p.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(p.decline?.family).toBe(DeclineFamily.Soft);
    // Contact info from the transaction's <customer> block feeds the dunning channels.
    expect(p.customer?.email).toBe('dana@example.test');
    expect(p.customer?.phone).toBe('+15555550123'); // flat <phone> (already E.164) via fallback
  });

  it('prefers the structured international-phone (assembled to E.164) over the deprecated flat phone', async () => {
    const { fetch } = makeFetch(() => res(200, ''));
    const adapter = new BraintreeAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({
      body: notificationBody('subscription_charged_unsuccessfully', { status: 'processor_declined', code: '2001', email: 'dana@example.test', phone: '555-1234', intlPhone: { countryCode: '1', nationalNumber: '5555550123' } }),
      headers: {},
    });
    const p = events[0]!.payload as { customer?: { phone?: string } };
    expect(p.customer?.phone).toBe('+15555550123'); // international-phone assembled; deprecated flat <phone> ignored
  });

  it('rejects a webhook with a bad signature', async () => {
    const { fetch } = makeFetch(() => res(200, ''));
    const adapter = new BraintreeAdapter({ ...baseCfg, fetch });
    const good = notificationBody('subscription_charged_unsuccessfully', { status: 'processor_declined', code: '2001' });
    const tampered = good.replace('bt_signature=', 'bt_signature=' + encodeURIComponent('pubkey|deadbeef') + '&x=');
    await expect(adapter.ingestWebhook({ body: tampered, headers: {} })).rejects.toThrow(/signature verification failed/);
  });

  it('maps a successful subscription charge to invoice.paid', async () => {
    const { fetch } = makeFetch(() => res(200, ''));
    const adapter = new BraintreeAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({
      body: notificationBody('subscription_charged_successfully', { status: 'submitted_for_settlement' }),
      headers: {},
    });
    expect(events[0]!.type).toBe('invoice.paid');
  });

  it('normalizes a dispute_opened chargeback into a payment.reversed keyed on the recovery invoice id', async () => {
    const { fetch } = makeFetch(() => res(200, ''));
    const adapter = new BraintreeAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({
      body: disputeBody({ orderId: 'sub_1', amount: '49.99', currency: 'USD', reason: 'fraud' }),
      headers: {},
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('payment.reversed');
    const r = ev.payload as ReversalPayload;
    expect(r.kind).toBe('chargeback');
    // order-id (sub_1) == the ref buildInvoice keyed the original invoice on → same invoice.id.
    expect(r.invoiceId).toBe('ax10m_inv_sub_1');
    expect(r.amount).toBe(4999); // decimal 49.99 → minor units
    expect(r.currency).toBe('USD');
    expect(r.reason).toBe('fraud');
  });

  it('skips a dispute whose transaction has no order-id (unmappable to a recovery)', async () => {
    const { fetch } = makeFetch(() => res(200, ''));
    const adapter = new BraintreeAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: disputeBody({ orderId: null }), headers: {} });
    expect(events).toHaveLength(0);
  });

  it('ignores a non-chargeback dispute (retrieval / pre_arbitration are not a funds clawback)', async () => {
    const { fetch } = makeFetch(() => res(200, ''));
    const adapter = new BraintreeAdapter({ ...baseCfg, fetch });
    const events = await adapter.ingestWebhook({ body: disputeBody({ disputeKind: 'retrieval' }), headers: {} });
    expect(events).toHaveLength(0);
  });
});

describe('attemptCharge', () => {
  it('sales against the vault token and reports success', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/merchants/bt_merchant/transactions');
      return res(201, '<transaction><id>txn_ok</id><status>submitted_for_settlement</status></transaction>');
    });
    const adapter = new BraintreeAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.attempt.status).toBe('succeeded');
    expect(calls[0]!.init.body).toContain('<payment-method-token>TOKEN</payment-method-token>');
    expect(calls[0]!.init.body).toContain('<amount>149.00</amount>');
    expect(calls[0]!.init.body).toContain('<order-id>inv_1</order-id>');
  });

  it('treats a 422 with a declined transaction as a decline, not an error', async () => {
    const { fetch } = makeFetch(() =>
      res(422, '<api-error-response><message>Declined</message><transaction><id>txn_d</id><status>processor_declined</status><processor-response-code>2001</processor-response-code></transaction></api-error-response>'),
    );
    const adapter = new BraintreeAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.InsufficientFunds);
  });

  it('rethrows an auth/validation error (no transaction in the body)', async () => {
    const { fetch } = makeFetch(() => res(401, '<api-error-response><message>Authentication Error</message></api-error-response>'));
    const adapter = new BraintreeAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow(/Authentication Error/);
  });
});

describe('vaulted payment methods', () => {
  it('lists a customer\'s vaulted cards (no PAN)', async () => {
    const { fetch, calls } = makeFetch((url) => {
      expect(url).toContain('/merchants/bt_merchant/customers/c1');
      return res(200,
        '<customer><id>c1</id><credit-cards type="array"><credit-card>' +
        '<token>tok1</token><last-4>4242</last-4><card-type>Visa</card-type>' +
        '<expiration-month>12</expiration-month><expiration-year>2030</expiration-year><bin>411111</bin>' +
        '</credit-card></credit-cards></customer>');
    });
    const adapter = new BraintreeAdapter({ ...baseCfg, fetch });
    const customer: Customer = {
      id: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'c1', issuerRegion: 'unknown',
      createdAt: '2026-01-01T00:00:00.000Z', consent: { email: true, sms: false, whatsapp: false, push: false, globallyOptedOut: false },
    };
    const methods = await adapter.listPaymentMethods(customer);
    expect(methods).toHaveLength(1);
    expect(methods[0]!.token).toBe('tok1');
    expect(methods[0]!.last4).toBe('4242');
    expect(methods[0]!.brand).toBe('Visa');
    expect(methods[0]!.expMonth).toBe(12);
    expect(calls[0]!.init.method).toBe('GET');

    expect(await adapter.fetchUpdatedCard(method)).toBeNull();
  });
});
