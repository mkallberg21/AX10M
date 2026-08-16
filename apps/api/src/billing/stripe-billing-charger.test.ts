import { describe, expect, it } from 'vitest';
import { buildBillingAccount, type BillingAccount, type OptInInput } from '@ax10m/billing';
import { NoopBillingCharger } from './charger.js';
import { StripeBillingCharger, buildBillingCharger, type BillingAccountLookup } from './stripe-billing-charger.js';

/** A fake Stripe transport: captures the request, returns a scripted response. */
function fakeFetch(script: { status?: number; body: unknown; headerReplayed?: boolean }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body });
    return {
      ok: (script.status ?? 200) < 400,
      status: script.status ?? 200,
      headers: { get: (n: string) => (n.toLowerCase() === 'idempotent-replayed' && script.headerReplayed ? 'true' : null) },
      async text() { return JSON.stringify(script.body); },
      async json() { return script.body; },
    };
  };
  return { fetch, calls };
}

const autoPayInput: OptInInput = {
  merchantId: 'mrc_1',
  legalEntityName: 'Merchant Inc.',
  billingAddress: { line1: '1 Market St', city: 'SF', region: 'CA', postalCode: '94105', country: 'US' },
  apContactEmail: 'ap@merchant.com',
  poRequired: false,
  payerTrack: 'auto_pay',
  paymentMethodRef: 'pm_123',
  customerRef: 'cus_123',
  autoPayAuthorized: true,
  signer: { name: 'Dana', title: 'CFO', email: 'dana@merchant.com' },
};

const lookupFor = (account: BillingAccount | undefined): BillingAccountLookup => async () => account;
const REQ = { merchantId: 'mrc_1', period: '2026-07', amountMinor: 12_000, currency: 'USD', statementHash: 'deadbeefcafebabe0123456789' };

describe('StripeBillingCharger', () => {
  it('charges the stored method off-session with an idempotency key and returns the PaymentIntent id', async () => {
    const account = buildBillingAccount(autoPayInput, 'acct_1', '2026-08-01T00:00:00.000Z');
    const { fetch, calls } = fakeFetch({ body: { id: 'pi_1', status: 'succeeded' } });
    const charger = new StripeBillingCharger({ secretKey: 'sk_test_x', fetch }, lookupFor(account));

    const receipt = await charger.charge(REQ);
    expect(receipt).toMatchObject({ status: 'charged', provider: 'stripe', reference: 'pi_1' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/payment_intents');
    expect(calls[0]!.headers['Idempotency-Key']).toBe('ax10m-bill-mrc_1-2026-07-deadbeefcafebabe01234567');
    const body = calls[0]!.body ?? '';
    expect(body).toContain('amount=12000');
    expect(body).toContain('currency=usd');
    expect(body).toContain('customer=cus_123');
    expect(body).toContain('payment_method=pm_123');
    expect(body).toContain('off_session=true');
    expect(body).toContain('confirm=true');
  });

  it('reports a card decline (402 card_error) as failed with the decline code — never throws', async () => {
    const account = buildBillingAccount(autoPayInput, 'acct_1', '2026-08-01T00:00:00.000Z');
    const { fetch } = fakeFetch({ status: 402, body: { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } } });
    const receipt = await new StripeBillingCharger({ secretKey: 'sk_test_x', fetch }, lookupFor(account)).charge(REQ);
    expect(receipt.status).toBe('failed');
    expect(receipt.reason).toContain('insufficient_funds');
  });

  it('skips an invoice-track merchant (never charges)', async () => {
    const account = buildBillingAccount({ ...autoPayInput, payerTrack: 'invoice', paymentMethodRef: undefined, customerRef: undefined, autoPayAuthorized: undefined }, 'acct_1', '2026-08-01T00:00:00.000Z');
    const { fetch, calls } = fakeFetch({ body: {} });
    const receipt = await new StripeBillingCharger({ secretKey: 'sk_test_x', fetch }, lookupFor(account)).charge(REQ);
    expect(receipt.status).toBe('skipped');
    expect(receipt.reason).toContain('invoice track');
    expect(calls).toHaveLength(0); // no charge attempt
  });

  it('skips when the customer/payment method is missing (SetupIntent not completed)', async () => {
    // auto_pay account but customerRef absent (only pm captured) → cannot charge off-session.
    const partial = { ...buildBillingAccount(autoPayInput, 'acct_1', '2026-08-01T00:00:00.000Z'), customerRef: undefined };
    const { fetch, calls } = fakeFetch({ body: {} });
    const receipt = await new StripeBillingCharger({ secretKey: 'sk_test_x', fetch }, lookupFor(partial)).charge(REQ);
    expect(receipt.status).toBe('skipped');
    expect(receipt.reason).toContain('SetupIntent not completed');
    expect(calls).toHaveLength(0);
  });

  it('skips when the merchant has no billing account', async () => {
    const { fetch } = fakeFetch({ body: {} });
    const receipt = await new StripeBillingCharger({ secretKey: 'sk_test_x', fetch }, lookupFor(undefined)).charge(REQ);
    expect(receipt.status).toBe('skipped');
    expect(receipt.reason).toContain('no billing account');
  });
});

describe('buildBillingCharger', () => {
  it('returns the Noop charger when no AX10M_BILLING_STRIPE_SECRET_KEY is set', () => {
    const charger = buildBillingCharger({} as NodeJS.ProcessEnv, lookupFor(undefined));
    expect(charger).toBeInstanceOf(NoopBillingCharger);
  });

  it('returns a StripeBillingCharger when the key is set', () => {
    const charger = buildBillingCharger({ AX10M_BILLING_STRIPE_SECRET_KEY: 'sk_test_x' } as unknown as NodeJS.ProcessEnv, lookupFor(undefined));
    expect(charger).toBeInstanceOf(StripeBillingCharger);
  });
});
