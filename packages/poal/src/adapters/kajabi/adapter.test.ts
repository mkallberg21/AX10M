import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Invoice } from '@ax10m/canonical';
import { KajabiAdapter, mapKajabiDeclineReason } from './adapter.js';

const baseCfg = { merchantId: 'mrc_1', webhookSecret: 'whsec_kajabi' };

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

const failedBody = JSON.stringify({
  id: 'ev_kj_1',
  event: 'payment.failed',
  created_at: 1_699_999_999,
  data: {
    id: 'pay_1',
    amount: '149.00',
    currency: 'USD',
    subscription_id: 'sub_7',
    member: { id: 'mem_9', email: 'buyer@example.com' },
    decline_code: 'insufficient_funds',
  },
});

describe('mapKajabiDeclineReason', () => {
  it('maps known reasons by keyword and defaults unknown to Unknown', () => {
    expect(mapKajabiDeclineReason('insufficient_funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapKajabiDeclineReason('expired card')).toBe(DeclineCode.ExpiredCard);
    expect(mapKajabiDeclineReason('who_knows')).toBe(DeclineCode.Unknown);
    expect(mapKajabiDeclineReason(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('ingestWebhook (fail-closed verification)', () => {
  it('refuses to process when no webhook secret is configured (fail closed)', async () => {
    const adapter = new KajabiAdapter({ merchantId: 'mrc_1', webhookSecret: '' });
    await expect(
      adapter.ingestWebhook({ body: failedBody, headers: { 'kajabi-signature': 'anything' } }),
    ).rejects.toThrow(/not configured/);
  });

  it('rejects a webhook whose signature does not match', async () => {
    const adapter = new KajabiAdapter(baseCfg);
    await expect(
      adapter.ingestWebhook({ body: failedBody, headers: { 'kajabi-signature': sign(failedBody, 'WRONG') } }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it('normalizes payment.failed into invoice.failed with a mapped decline (case-insensitive header)', async () => {
    const adapter = new KajabiAdapter(baseCfg);
    const events = await adapter.ingestWebhook({
      body: failedBody,
      headers: { 'Kajabi-Signature': sign(failedBody, baseCfg.webhookSecret) },
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
    expect(ev.processorEventId).toBe('ev_kj_1');
    const p = ev.payload as { invoice: Invoice; decline?: { code: DeclineCode; family: DeclineFamily } };
    expect(p.invoice.processorRef).toBe('pay_1');
    // 149.00 major units → 14900 minor units
    expect(p.invoice.amount).toEqual({ amount: 14900, currency: 'USD' });
    expect(p.invoice.customerId).toBe('ax10m_cus_mem_9');
    expect(p.invoice.firstFailedAt).toBe('2023-11-14T22:13:19.000Z');
    expect(p.decline?.code).toBe(DeclineCode.InsufficientFunds);
    expect(p.decline?.family).toBe(DeclineFamily.Soft);
  });

  it('maps payment.succeeded to invoice.paid and ignores unhandled events', async () => {
    const adapter = new KajabiAdapter(baseCfg);
    const paidBody = JSON.stringify({ id: 'ev_kj_2', event: 'payment.succeeded', created_at: 1, data: { id: 'pay_2', amount: '20.00', currency: 'USD' } });
    const paid = await adapter.ingestWebhook({ body: paidBody, headers: { 'kajabi-signature': sign(paidBody, baseCfg.webhookSecret) } });
    expect(paid[0]!.type).toBe('invoice.paid');

    const otherBody = JSON.stringify({ id: 'ev_kj_3', event: 'contact.created', data: {} });
    const noop = await adapter.ingestWebhook({ body: otherBody, headers: { 'kajabi-signature': sign(otherBody, baseCfg.webhookSecret) } });
    expect(noop).toEqual([]);
  });

  it('maps subscription.cancelled to subscription.updated', async () => {
    const adapter = new KajabiAdapter(baseCfg);
    const cancelBody = JSON.stringify({ id: 'ev_kj_4', event: 'subscription.cancelled', created_at: 1, data: { id: 'sub_7', subscription_id: 'sub_7', status: 'canceled' } });
    const events = await adapter.ingestWebhook({ body: cancelBody, headers: { 'kajabi-signature': sign(cancelBody, baseCfg.webhookSecret) } });
    expect(events[0]!.type).toBe('subscription.updated');
  });
});

describe('capabilities (advisory)', () => {
  it('advertises advisory with only webhooks enabled', () => {
    const caps = new KajabiAdapter(baseCfg).capabilities();
    expect(caps.integrationMode).toBe('advisory');
    expect(caps.webhooks).toBe(true);
    expect(caps.externalRetryControl).toBe(false);
  });

  it('inherits the advisory throw for attemptCharge (cannot drive a charge)', async () => {
    const adapter = new KajabiAdapter(baseCfg);
    const invoice = { processorRef: 'pay_1', amount: { amount: 100, currency: 'USD' } } as unknown as Invoice;
    await expect(adapter.attemptCharge(invoice, {} as never, 'k')).rejects.toThrow(/advisory mode/);
  });
});
