import { describe, expect, it } from 'vitest';
import type { CanonicalEvent, Customer, Invoice, PaymentMethod, Subscription } from '@ax10m/canonical';
import type { ChargeResult, Cursor, OpenFailuresPage, ProcessorAdapter, RawWebhook } from '@ax10m/poal';
import { RecoveryCaseService } from '../recovery/recovery-case.service.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';
import { WebhookRouterService } from './webhook-router.service.js';
import { InMemoryMerchantConnectionStore, seedConnectionsFromEnv } from './merchant-connections.js';

/** Records which raw webhook it ingested + the merchant/config it was built with. */
class SpyAdapter implements ProcessorAdapter {
  ingested: RawWebhook[] = [];
  constructor(readonly id: string) {}
  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    this.ingested.push(raw);
    return [];
  }
  async listOpenFailures(_c: Cursor): Promise<OpenFailuresPage> {
    return { invoices: [], nextCursor: null };
  }
  async attemptCharge(_i: Invoice, _m: PaymentMethod, _k: string): Promise<ChargeResult> {
    throw new Error('n/a');
  }
  async fetchUpdatedCard(): Promise<PaymentMethod | null> {
    return null;
  }
  async listPaymentMethods(_c: Customer): Promise<PaymentMethod[]> {
    return [];
  }
  async pauseNativeDunning(_s: Subscription): Promise<void> {}
  capabilities() {
    return { integrationMode: 'drive' as const, externalRetryControl: true, accountUpdater: false, networkTokens: false, partialCapture: false, pauseNativeDunning: false, webhooks: true, listPaymentMethods: true };
  }
}

function router(store = new InMemoryMerchantConnectionStore()) {
  const built: Array<{ processor: string; merchantId: string; config: Record<string, unknown> }> = [];
  const svc = new WebhookRouterService(
    new RecoveryCaseService(new OnboardingService()),
    store,
    (processor, merchantId, config) => {
      built.push({ processor, merchantId, config });
      return new SpyAdapter(processor);
    },
  );
  return { svc, store, built };
}

describe('WebhookRouterService', () => {
  it('routes by connection id to the right merchant + credentials', async () => {
    const { svc, store, built } = router();
    await store.register({ connectionId: 'conn_A', merchantId: 'mrc_A', processor: 'stripe', config: { secretKey: 'sk_A', webhookSecret: 'wh_A' } });
    await store.register({ connectionId: 'conn_B', merchantId: 'mrc_B', processor: 'stripe', config: { secretKey: 'sk_B', webhookSecret: 'wh_B' } });

    await svc.ingest('stripe', 'conn_B', { body: '{}', headers: {} });

    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ processor: 'stripe', merchantId: 'mrc_B', config: { secretKey: 'sk_B' } });
  });

  it('falls back to the processor default for single-tenant ingress', async () => {
    const { svc, store, built } = router();
    await store.register({ connectionId: 'stripe-default', merchantId: 'mrc_1', processor: 'stripe', config: { secretKey: 'sk', webhookSecret: 'wh' } });
    await svc.ingest('stripe', null, { body: '{}', headers: {} });
    expect(built[0]!.merchantId).toBe('mrc_1');
  });

  it('404s an unknown connection id', async () => {
    const { svc } = router();
    await expect(svc.ingest('stripe', 'nope', { body: '{}', headers: {} })).rejects.toThrow(/Unknown connection/);
  });

  it('404s a single-tenant processor with no default configured', async () => {
    const { svc } = router();
    await expect(svc.ingest('worldpay', null, { body: '{}', headers: {} })).rejects.toThrow(/No default connection/);
  });

  it('rejects a URL that pairs a connection with the wrong processor', async () => {
    const { svc, store } = router();
    await store.register({ connectionId: 'conn_A', merchantId: 'mrc_A', processor: 'stripe', config: {} });
    await expect(svc.ingest('adyen', 'conn_A', { body: '{}', headers: {} })).rejects.toThrow(/is for 'stripe', not 'adyen'/);
  });
});

describe('seedConnectionsFromEnv', () => {
  it('registers a default only when the required secrets are present', async () => {
    const store = new InMemoryMerchantConnectionStore();
    await seedConnectionsFromEnv(store, {
      STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh', STRIPE_MERCHANT_ID: 'mrc_env',
      // chargebee left unconfigured → no default
    } as NodeJS.ProcessEnv);

    expect((await store.defaultFor('stripe'))?.merchantId).toBe('mrc_env');
    expect(await store.defaultFor('chargebee')).toBeUndefined();
  });
});
