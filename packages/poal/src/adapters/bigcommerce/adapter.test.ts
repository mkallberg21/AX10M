import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Invoice } from '@ax10m/canonical';
import { BigCommerceAdapter, mapBigCommerceDeclineReason } from './adapter.js';

const baseCfg = { merchantId: 'mrc_1', webhookSecret: 'whsec_bc' };

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

const declinedBody = JSON.stringify({
  scope: 'store/order/statusUpdated',
  store_id: '1001',
  hash: 'ev_bc_1',
  created_at: 1_699_999_999,
  data: {
    type: 'order',
    id: 'ord_1',
    order_id: 'ord_1',
    status: 'Declined',
    customer_id: 'cus_9',
    currency_code: 'USD',
    total_inc_tax: '149.00',
    subscription_id: 'sub_7',
    decline_reason: 'insufficient_funds',
  },
});

describe('mapBigCommerceDeclineReason', () => {
  it('maps known reasons by keyword and defaults unknown to Unknown', () => {
    expect(mapBigCommerceDeclineReason('insufficient_funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapBigCommerceDeclineReason('Card was reported LOST')).toBe(DeclineCode.LostCard);
    expect(mapBigCommerceDeclineReason('who_knows')).toBe(DeclineCode.Unknown);
    expect(mapBigCommerceDeclineReason(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('ingestWebhook (fail-closed verification)', () => {
  it('refuses to process when no webhook secret is configured (fail closed)', async () => {
    const adapter = new BigCommerceAdapter({ merchantId: 'mrc_1', webhookSecret: '' });
    await expect(
      adapter.ingestWebhook({ body: declinedBody, headers: { 'x-bc-signature': 'anything' } }),
    ).rejects.toThrow(/not configured/);
  });

  it('rejects a webhook whose signature does not match', async () => {
    const adapter = new BigCommerceAdapter(baseCfg);
    await expect(
      adapter.ingestWebhook({ body: declinedBody, headers: { 'x-bc-signature': sign(declinedBody, 'WRONG') } }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it('normalizes a declined order into invoice.failed with a mapped decline (case-insensitive header)', async () => {
    const adapter = new BigCommerceAdapter(baseCfg);
    const events = await adapter.ingestWebhook({
      body: declinedBody,
      headers: { 'X-Bc-Signature': sign(declinedBody, baseCfg.webhookSecret) },
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    expect(ev.processorEventId).toBe('ev_bc_1');
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

  it('maps a completed order to invoice.paid and ignores unhandled scopes', async () => {
    const adapter = new BigCommerceAdapter(baseCfg);
    const paidBody = JSON.stringify({
      scope: 'store/order/statusUpdated',
      hash: 'ev_bc_2',
      created_at: 1,
      data: { id: 'ord_2', status: 'Completed', currency_code: 'USD', total: '20.00' },
    });
    const paid = await adapter.ingestWebhook({ body: paidBody, headers: { 'x-bc-signature': sign(paidBody, baseCfg.webhookSecret) } });
    expect(paid[0]!.type).toBe('invoice.paid');

    const otherBody = JSON.stringify({ scope: 'store/product/updated', hash: 'ev_bc_3', data: {} });
    const noop = await adapter.ingestWebhook({ body: otherBody, headers: { 'x-bc-signature': sign(otherBody, baseCfg.webhookSecret) } });
    expect(noop).toEqual([]);
  });
});

describe('capabilities (advisory)', () => {
  it('advertises advisory with only webhooks enabled', () => {
    const caps = new BigCommerceAdapter(baseCfg).capabilities();
    expect(caps.integrationMode).toBe('advisory');
    expect(caps.webhooks).toBe(true);
    expect(caps.externalRetryControl).toBe(false);
    expect(caps.pauseNativeDunning).toBe(false);
  });

  it('inherits the advisory throw for attemptCharge (cannot drive a charge)', async () => {
    const adapter = new BigCommerceAdapter(baseCfg);
    const invoice = { processorRef: 'ord_1', amount: { amount: 100, currency: 'USD' } } as unknown as Invoice;
    await expect(adapter.attemptCharge(invoice, {} as never, 'k')).rejects.toThrow(/advisory mode/);
  });
});
