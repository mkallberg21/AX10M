import { describe, expect, it } from 'vitest';
import { stripe } from '@ax10m/poal';
import { StripeEnrollmentService, buildStripeEnrollmentService } from './stripe-enrollment.service.js';

/** A fake Stripe transport that returns a scripted body per path. */
function fakeFetch(byPath: Record<string, unknown>) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, body: init?.body });
    const path = Object.keys(byPath).find((p) => url.includes(p));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async text() { return JSON.stringify(path ? byPath[path] : {}); },
      async json() { return path ? byPath[path] : {}; },
    };
  };
  return { fetch, calls };
}

describe('StripeEnrollmentService', () => {
  it('creates a customer then an off-session SetupIntent and returns the client secret', async () => {
    const { fetch, calls } = fakeFetch({
      '/customers': { id: 'cus_1' },
      '/setup_intents': { id: 'seti_1', client_secret: 'seti_1_secret_abc' },
    });
    const svc = new StripeEnrollmentService(new stripe.StripeClient({ secretKey: 'sk_test_x', fetch }));
    expect(svc.enabled).toBe(true);

    const res = await svc.createSetupIntent({ merchantId: 'mrc_1', email: 'ap@merchant.com', legalEntityName: 'Merchant Inc.' });
    expect(res).toEqual({ customerId: 'cus_1', clientSecret: 'seti_1_secret_abc', setupIntentId: 'seti_1' });

    expect(calls[0]!.url).toContain('/customers');
    expect(calls[0]!.body).toContain('metadata%5BmerchantId%5D=mrc_1'); // metadata[merchantId]
    expect(calls[1]!.url).toContain('/setup_intents');
    expect(calls[1]!.body).toContain('customer=cus_1');
    expect(calls[1]!.body).toContain('usage=off_session');
  });

  it('is disabled and throws ServiceUnavailable when no Stripe key is configured', async () => {
    const svc = new StripeEnrollmentService(undefined);
    expect(svc.enabled).toBe(false);
    await expect(svc.createSetupIntent({ merchantId: 'mrc_1', email: 'ap@merchant.com' })).rejects.toThrow(/not configured/);
  });
});

describe('buildStripeEnrollmentService', () => {
  it('is disabled without AX10M_BILLING_STRIPE_SECRET_KEY, enabled with it', () => {
    expect(buildStripeEnrollmentService({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(buildStripeEnrollmentService({ AX10M_BILLING_STRIPE_SECRET_KEY: 'sk_test_x' } as unknown as NodeJS.ProcessEnv).enabled).toBe(true);
  });
});
