import { describe, expect, it } from 'vitest';
import { PROCESSOR_REGISTRY, coverageSummary, getProcessor } from './registry.js';
import { AdyenAdapter } from './adyen/index.js';
import { BraintreeAdapter } from './braintree.js';
import { ChargebeeAdapter } from './chargebee/index.js';
import { GoCardlessAdapter } from './gocardless.js';
import { PaddleAdapter } from './paddle.js';

describe('processor registry', () => {
  it('every processor is drive, co-drive, or advisory and the counts sum to the total', () => {
    const s = coverageSummary();
    expect(s.drive + s.coDrive + s.advisory).toBe(s.total);
    expect(s.total).toBe(PROCESSOR_REGISTRY.length);
    // We can actually recover (drive or co-drive) on the large majority.
    expect(s.drive + s.coDrive).toBeGreaterThan(s.advisory);
  });

  it('has unique processor ids', () => {
    const ids = PROCESSOR_REGISTRY.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves a known processor and misses an unknown one', () => {
    expect(getProcessor('adyen')?.mode).toBe('drive');
    expect(getProcessor('paddle')?.mode).toBe('advisory');
    expect(getProcessor('nope')).toBeUndefined();
  });
});

describe('adapter ↔ registry consistency', () => {
  const cases = [
    new AdyenAdapter({ apiKey: 'x', merchantAccount: 'x', merchantId: 'm', hmacKey: 'x' }),
    new BraintreeAdapter({ merchantId: 'x', publicKey: 'x', privateKey: 'x' }),
    new ChargebeeAdapter({ site: 'x', apiKey: 'x', merchantId: 'm' }),
    new GoCardlessAdapter({ accessToken: 'x', webhookSecret: 'x' }),
    new PaddleAdapter({ apiKey: 'x', webhookSecret: 'x' }),
  ];

  it("each adapter's advertised mode matches its registry entry", () => {
    for (const adapter of cases) {
      const entry = getProcessor(adapter.id);
      expect(entry, `registry entry for ${adapter.id}`).toBeDefined();
      expect(adapter.capabilities().integrationMode).toBe(entry!.mode);
    }
  });
});

describe('advisory-mode safety', () => {
  const paddle = new PaddleAdapter({ apiKey: 'x', webhookSecret: 'x' });

  it('refuses to drive a charge (platform owns the token/retry)', async () => {
    await expect(
      paddle.attemptCharge({} as never, {} as never, 'idem_1'),
    ).rejects.toThrow(/advisory mode/i);
  });

  it('refuses to pause platform-owned dunning', async () => {
    await expect(paddle.pauseNativeDunning({} as never)).rejects.toThrow(/advisory mode/i);
  });

  it('still ingests webhooks (measurement is always available)', async () => {
    await expect(paddle.ingestWebhook({ body: '{}', headers: {} })).resolves.toEqual([]);
  });
});

describe('skeleton drive adapters', () => {
  it('surface an unimplemented (not advisory) error on attemptCharge', async () => {
    // Braintree is still a capability-only skeleton; Adyen & Chargebee are implemented.
    const braintree = new BraintreeAdapter({ merchantId: 'x', publicKey: 'x', privateKey: 'x' });
    await expect(braintree.attemptCharge({} as never, {} as never, 'idem_2')).rejects.toThrow(/TODO\(lift\)/);
  });
});
