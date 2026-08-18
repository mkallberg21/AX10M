import { describe, expect, it } from 'vitest';
import type { BaseAdapter } from '../base.js';
import { PROCESSOR_REGISTRY, getProcessor } from '../registry.js';
import {
  AppleIapAdapter,
  AuthorizeNetAdapter,
  CybersourceAdapter,
  FiservAdapter,
  GlobalPaymentsAdapter,
  GooglePlayAdapter,
  MollieAdapter,
  NuveiAdapter,
  PayUAdapter,
  RazorpayAdapter,
  SquareAdapter,
  StripeBillingAdapter,
  VindiciaAdapter,
} from './index.js';

/** Minimal throwaway config — every adapter's only required field is `merchantId`. */
const cfg = { merchantId: 'mrc_1' };

// [expected id, constructed adapter]
const adapters: Array<[string, BaseAdapter]> = [
  ['cybersource', new CybersourceAdapter(cfg)],
  ['authorizenet', new AuthorizeNetAdapter(cfg)],
  ['fiserv', new FiservAdapter(cfg)],
  ['globalpayments', new GlobalPaymentsAdapter(cfg)],
  ['square', new SquareAdapter(cfg)],
  ['mollie', new MollieAdapter(cfg)],
  ['nuvei', new NuveiAdapter(cfg)],
  ['razorpay', new RazorpayAdapter(cfg)],
  ['payu', new PayUAdapter(cfg)],
  ['stripe-billing', new StripeBillingAdapter(cfg)],
  ['vindicia', new VindiciaAdapter(cfg)],
  ['apple-iap', new AppleIapAdapter(cfg)],
  ['google-play', new GooglePlayAdapter(cfg)],
];

describe('planned-processor adapters (skeletons)', () => {
  it.each(adapters)('%s advertises its expected id', (expectedId, adapter) => {
    expect(adapter.id).toBe(expectedId);
  });

  it.each(adapters)("%s advertised mode matches its registry entry", (_id, adapter) => {
    const entry = getProcessor(adapter.id);
    expect(entry, `registry entry for ${adapter.id}`).toBeDefined();
    expect(adapter.capabilities().integrationMode).toBe(entry!.mode);
  });

  it.each(adapters)('%s.attemptCharge rejects with the mode-appropriate error', async (_id, adapter) => {
    const mode = adapter.capabilities().integrationMode;
    if (mode === 'advisory') {
      await expect(adapter.attemptCharge({} as never, {} as never, 'k')).rejects.toThrow(/advisory mode/i);
    } else {
      await expect(adapter.attemptCharge({} as never, {} as never, 'k')).rejects.toThrow(/TODO\(ax10m\)/);
    }
  });

  it.each(adapters)('%s still ingests webhooks (measurement path), returning []', async (_id, adapter) => {
    await expect(adapter.ingestWebhook({ body: '{}', headers: {} })).resolves.toEqual([]);
  });
});

describe('registry roll-forward', () => {
  it('has no remaining processors with status "planned"', () => {
    const stillPlanned = PROCESSOR_REGISTRY.filter((p) => p.status === 'planned').map((p) => p.id);
    expect(stillPlanned).toEqual([]);
  });
});
