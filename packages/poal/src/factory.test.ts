import { describe, expect, it } from 'vitest';
import { buildAdapter, isWebhookCapable, webhookCapableProcessors, type AdapterCredentials } from './factory.js';

/** Minimal valid credentials per processor (only required fields matter). */
const CREDS: Record<string, AdapterCredentials> = {
  stripe: { secretKey: 'sk_test', webhookSecret: 'whsec' },
  adyen: { apiKey: 'k', merchantAccount: 'MA' },
  braintree: { braintreeMerchantId: 'bt', publicKey: 'pk', privateKey: 'sk' },
  paypal: { clientId: 'cid', clientSecret: 'cs' },
  checkout: { secretKey: 'sk' },
  worldpay: { username: 'u', password: 'p', entity: 'e' },
  chargebee: { site: 'acme', apiKey: 'k' },
  recurly: { apiKey: 'k' },
  zuora: { clientId: 'cid', clientSecret: 'cs' },
  maxio: { apiKey: 'k', subdomain: 'acme' },
  gocardless: { accessToken: 'tok', webhookSecret: 'whs' },
  shopify: { shop: 'acme', accessToken: 'tok', apiSecret: 'sec' },
  woocommerce: { storeUrl: 'https://s', consumerKey: 'ck', consumerSecret: 'cs', webhookSecret: 'whs' },
  bigcommerce: { webhookSecret: 'whs' },
  kajabi: { webhookSecret: 'whs' },
  thrivecart: { webhookSecret: 'whs' },
  samcart: { webhookSecret: 'whs' },
};

describe('adapter factory', () => {
  it('every registered processor builds an adapter whose id matches', () => {
    for (const processor of webhookCapableProcessors()) {
      const creds = CREDS[processor];
      expect(creds, `no test creds for ${processor}`).toBeDefined();
      const adapter = buildAdapter(processor, 'mrc_1', creds!);
      expect(adapter.id).toBe(processor);
    }
  });

  it('covers the full webhook-capable roster', () => {
    expect(new Set(webhookCapableProcessors())).toEqual(new Set(Object.keys(CREDS)));
  });

  it('throws a clear error for a non-webhook-capable processor', () => {
    expect(isWebhookCapable('tsys')).toBe(false);
    expect(isWebhookCapable('oracle-brm')).toBe(false);
    expect(() => buildAdapter('tsys', 'mrc_1', {})).toThrow(/webhook routing unsupported/);
  });

  it('throws when a required credential is missing', () => {
    expect(() => buildAdapter('stripe', 'mrc_1', {})).toThrow(/missing required string field 'secretKey'/);
  });

  it('stamps the caller-supplied merchantId, never trusting the config bag', () => {
    // A hostile config trying to spoof merchantId is ignored — the resolved connection wins.
    const adapter = buildAdapter('chargebee', 'mrc_real', { site: 'acme', apiKey: 'k', merchantId: 'mrc_spoof' });
    expect(adapter.id).toBe('chargebee');
  });
});
