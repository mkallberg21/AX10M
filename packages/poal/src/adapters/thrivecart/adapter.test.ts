import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type Invoice } from '@ax10m/canonical';
import { ThriveCartAdapter, mapThriveCartDeclineReason } from './adapter.js';

const baseCfg = { merchantId: 'mrc_1', webhookSecret: 'tc_secret_abc' };

// ThriveCart posts application/x-www-form-urlencoded by default.
function urlencoded(fields: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) p.append(k, v);
  return p.toString();
}

const failedForm = urlencoded({
  thrivecart_secret: 'tc_secret_abc',
  event: 'order.rebill_failed',
  order_id: 'ord_1',
  created_at: '1699999999',
  currency: 'usd',
  'order[total]': '149.00',
  'customer[id]': 'cus_9',
  'customer[email]': 'buyer@example.com',
  'subscription[id]': 'sub_7',
  decline_reason: 'insufficient_funds',
});
const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

describe('mapThriveCartDeclineReason', () => {
  it('maps known reasons by keyword and defaults unknown to Unknown', () => {
    expect(mapThriveCartDeclineReason('insufficient_funds')).toBe(DeclineCode.InsufficientFunds);
    expect(mapThriveCartDeclineReason('stolen card')).toBe(DeclineCode.StolenCard);
    expect(mapThriveCartDeclineReason('who_knows')).toBe(DeclineCode.Unknown);
    expect(mapThriveCartDeclineReason(undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('ingestWebhook (fail-closed verification)', () => {
  it('refuses to process when no webhook secret is configured (fail closed)', async () => {
    const adapter = new ThriveCartAdapter({ merchantId: 'mrc_1', webhookSecret: '' });
    await expect(adapter.ingestWebhook({ body: failedForm, headers: formHeaders })).rejects.toThrow(/not configured/);
  });

  it('rejects a webhook whose secret does not match', async () => {
    const adapter = new ThriveCartAdapter(baseCfg);
    const badForm = urlencoded({ thrivecart_secret: 'WRONG', event: 'order.rebill_failed', order_id: 'ord_1' });
    await expect(adapter.ingestWebhook({ body: badForm, headers: formHeaders })).rejects.toThrow(/secret verification failed/);
  });

  it('normalizes order.rebill_failed (urlencoded) into invoice.failed with a mapped decline', async () => {
    const adapter = new ThriveCartAdapter(baseCfg);
    const events = await adapter.ingestWebhook({ body: failedForm, headers: formHeaders });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe('invoice.failed');
    expect(ev.merchantId).toBe('mrc_1');
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

  it('treats a subscription_payment with a failed flag as invoice.failed (JSON body)', async () => {
    const adapter = new ThriveCartAdapter(baseCfg);
    const jsonBody = JSON.stringify({
      thrivecart_secret: 'tc_secret_abc',
      event: 'order.subscription_payment',
      order_id: 'ord_2',
      created_at: 1699999999,
      status: 'failed',
      order: { total: '50.00', currency: 'USD' },
      customer: { email: 'a@b.com' },
    });
    const events = await adapter.ingestWebhook({ body: jsonBody, headers: { 'content-type': 'application/json' } });
    expect(events[0]!.type).toBe('invoice.failed');
  });

  it('maps order.success to invoice.paid and ignores unhandled events', async () => {
    const adapter = new ThriveCartAdapter(baseCfg);
    const okForm = urlencoded({ thrivecart_secret: 'tc_secret_abc', event: 'order.success', order_id: 'ord_3', 'order[total]': '20.00' });
    const paid = await adapter.ingestWebhook({ body: okForm, headers: formHeaders });
    expect(paid[0]!.type).toBe('invoice.paid');

    const otherForm = urlencoded({ thrivecart_secret: 'tc_secret_abc', event: 'order.refund_requested', order_id: 'ord_4' });
    const noop = await adapter.ingestWebhook({ body: otherForm, headers: formHeaders });
    expect(noop).toEqual([]);
  });

  it('maps order.subscription_cancelled to subscription.updated', async () => {
    const adapter = new ThriveCartAdapter(baseCfg);
    const cancelForm = urlencoded({ thrivecart_secret: 'tc_secret_abc', event: 'order.subscription_cancelled', order_id: 'ord_5', 'subscription[id]': 'sub_7' });
    const events = await adapter.ingestWebhook({ body: cancelForm, headers: formHeaders });
    expect(events[0]!.type).toBe('subscription.updated');
  });
});

describe('capabilities (advisory)', () => {
  it('advertises advisory with only webhooks enabled', () => {
    const caps = new ThriveCartAdapter(baseCfg).capabilities();
    expect(caps.integrationMode).toBe('advisory');
    expect(caps.webhooks).toBe(true);
    expect(caps.externalRetryControl).toBe(false);
  });

  it('inherits the advisory throw for attemptCharge (cannot drive a charge)', async () => {
    const adapter = new ThriveCartAdapter(baseCfg);
    const invoice = { processorRef: 'ord_1', amount: { amount: 100, currency: 'USD' } } as unknown as Invoice;
    await expect(adapter.attemptCharge(invoice, {} as never, 'k')).rejects.toThrow(/advisory mode/);
  });
});
