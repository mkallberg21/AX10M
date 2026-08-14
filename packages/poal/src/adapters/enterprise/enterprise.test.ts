import { describe, expect, it } from 'vitest';
import type { Invoice, PaymentMethod } from '@ax10m/canonical';
import type { BaseAdapter } from '../base.js';
import {
  AppDirectAdapter,
  AriaAdapter,
  BillingPlatformAdapter,
  BluLogixAdapter,
  FrisbiiAdapter,
  GotransverseAdapter,
  KeylightAdapter,
  LogiSenseAdapter,
  OneBillAdapter,
  OracleBrmAdapter,
  RecVueAdapter,
  SalesforceRevenueCloudAdapter,
  SapBrimAdapter,
} from './index.js';

/** Minimal, throwaway config that satisfies every adapter's required string fields. */
const cfg = {
  merchantId: 'mrc_1',
  apiKey: '',
  clientId: '',
  clientSecret: '',
  authKey: '',
  clientNo: '',
  baseUrl: '',
  instanceUrl: '',
  webhookSecret: '',
};

// [expected id, constructed adapter]
const adapters: Array<[string, BaseAdapter]> = [
  ['appdirect', new AppDirectAdapter(cfg)],
  ['aria', new AriaAdapter(cfg)],
  ['billingplatform', new BillingPlatformAdapter(cfg)],
  ['blulogix', new BluLogixAdapter(cfg)],
  ['frisbii', new FrisbiiAdapter(cfg)],
  ['gotransverse', new GotransverseAdapter(cfg)],
  ['keylight', new KeylightAdapter(cfg)],
  ['logisense', new LogiSenseAdapter(cfg)],
  ['oracle-brm', new OracleBrmAdapter(cfg)],
  ['recvue', new RecVueAdapter(cfg)],
  ['sap-brim', new SapBrimAdapter(cfg)],
  ['salesforce-revenue-cloud', new SalesforceRevenueCloudAdapter(cfg)],
  ['onebill', new OneBillAdapter(cfg)],
];

// Tiny throwaway records — enough to call attemptCharge; the co-drive path throws
// before it ever reads them.
const invoice = { processorRef: 'inv_1', amount: { amount: 100, currency: 'USD' } } as unknown as Invoice;
const method = {} as unknown as PaymentMethod;

describe('enterprise billing-platform adapters (skeletons)', () => {
  it.each(adapters)('%s advertises id + co-drive capabilities', (expectedId, adapter) => {
    expect(adapter.id).toBe(expectedId);
    const caps = adapter.capabilities();
    expect(caps.integrationMode).toBe('co-drive');
    expect(caps.webhooks).toBe(true);
  });

  it.each(adapters)('%s.attemptCharge rejects with a TODO (co-drive not yet wired)', async (_id, adapter) => {
    await expect(adapter.attemptCharge(invoice, method, 'idem_1')).rejects.toThrow(/TODO|not implemented/i);
  });
});
