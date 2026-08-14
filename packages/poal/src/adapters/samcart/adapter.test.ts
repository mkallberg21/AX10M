import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Invoice } from '@ax10m/canonical';
import { SamCartAdapter, mapSamCartDeclineReason } from './adapter.js';

const baseCfg = { merchantId: 'mrc_1', webhookSecret: 'whsec_samcart' };

function signHex(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}
function signB64(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

const failedBody = JSON.stringify({
  id: 'ev_sc_1',
  type: 'Subscription_Payment_Failed',
  created_at: 1_699_999_999,
  order: {
    id: 'ord_1',
    total: '149.00',
    currency: 'USD',
    decline_reason: 'insufficient_funds',
  },
  customer: { id: 'cus_9', email: 'buyer@example.com' },
  subscription: { id: 'sub_7' },
});

describe('mapSamCartDeclineReason', () => {
  it('maps known reasons by keyword and defaults unknown to Unknown', () => {
    expect(mapSamCartDeclineReason('insufficient_funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapSamCartDeclineReason('do not honor')).toBe(DeclineCode.DoNotHonor);
    expect(mapSamCartDeclineReason('who_knows')).toBe(DeclineCode.Unknown);
    expect(mapSamCartDeclineReason(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('ingestWebhook (fail-closed verification)', () => {
  it('refuses to process when no webhook secret is configured (fail closed)', async () => {
    const adapter = new SamCartAdapter({ merchantId: 'mrc_1', webhookSecret: '' });
    await expect(
      adapter.ingestWebhook({ body: failedBody, headers: { 'x-samcart-signature': 'anything' } }),
    ).rejects.toThrow(/not configured/);
  });

  it('rejects a webhook whose signature does not match', async () => {
    const adapter = new SamCartAdapter(baseCfg);
    await expect(
      adapter.ingestWebhook({ body: failedBody, headers: { 'x-samcart-signature': signHex(failedBody, 'WRONG') } }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it('normalizes Subscription_Payment_Failed into invoice.failed with a mapped decline (hex sig)', async () => {
    const adapter = new SamCartAdapter(baseCfg);
    const events = await adapter.ingestWebhook({
      body: failedBody,
      headers: { 'X-Samcart-Signature': signHex(failedBody, baseCfg.webhookSecret) },
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    expect(ev.processorEventId).toBe('ev_sc_1');
    const p = ev.payload as { invoice: Invoice; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.processorRef).toBe('ord_1');
    // 149.00 major units → 14900 minor units
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.invoice.customerId).toBe('ax10m_cus_cus_9');
    expect(p.invoice.subscriptionId).toBe('ax10m_sub_sub_7');
    expect(p.invoice.firstFailedAt).toBe('2023-11-14T22:13:19.000Z');
    expect(p.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(p.decline?.family).toBe(DeclineFamily.Soft);
  });

  it('accepts a base64-encoded signature too', async () => {
    const adapter = new SamCartAdapter(baseCfg);
    const events = await adapter.ingestWebhook({
      body: failedBody,
      headers: { 'x-samcart-signature': signB64(failedBody, baseCfg.webhookSecret) },
    });
    expect(events[0]!.type).toBe('invoice.failed');
  });

  it('maps Order_Completed to invoice.paid, Subscription_Cancelled to subscription.updated, ignores others', async () => {
    const adapter = new SamCartAdapter(baseCfg);

    const okBody = JSON.stringify({ id: 'ev_sc_2', type: 'Order_Completed', created_at: 1, order: { id: 'ord_2', total: '20.00', currency: 'USD' } });
    const paid = await adapter.ingestWebhook({ body: okBody, headers: { 'x-samcart-signature': signHex(okBody, baseCfg.webhookSecret) } });
    expect(paid[0]!.type).toBe('invoice.paid');

    const cancelBody = JSON.stringify({ id: 'ev_sc_3', type: 'Subscription_Cancelled', created_at: 1, subscription: { id: 'sub_7' }, order: { id: 'ord_3' } });
    const cancel = await adapter.ingestWebhook({ body: cancelBody, headers: { 'x-samcart-signature': signHex(cancelBody, baseCfg.webhookSecret) } });
    expect(cancel[0]!.type).toBe('subscription.updated');

    const otherBody = JSON.stringify({ id: 'ev_sc_4', type: 'Product_Created', order: {} });
    const noop = await adapter.ingestWebhook({ body: otherBody, headers: { 'x-samcart-signature': signHex(otherBody, baseCfg.webhookSecret) } });
    expect(noop).toEqual([]);
  });
});

describe('capabilities (advisory)', () => {
  it('advertises advisory with only webhooks enabled', () => {
    const caps = new SamCartAdapter(baseCfg).capabilities();
    expect(caps.integrationMode).toBe('advisory');
    expect(caps.webhooks).toBe(true);
    expect(caps.externalRetryControl).toBe(false);
  });

  it('inherits the advisory throw for attemptCharge (cannot drive a charge)', async () => {
    const adapter = new SamCartAdapter(baseCfg);
    const invoice = { processorRef: 'ord_1', amount: { amount: 100, currency: 'USD' } } as unknown as Invoice;
    await expect(adapter.attemptCharge(invoice, {} as never, 'k')).rejects.toThrow(/advisory mode/);
  });
});
