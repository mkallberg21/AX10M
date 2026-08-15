/**
 * Merchant connection store — resolves an inbound webhook to the merchant + credentials
 * it belongs to (the seam for per-merchant routing). Two implementations:
 *
 *  - `InMemoryMerchantConnectionStore` — single-tenant default, seeded from env; used
 *    when no `DATABASE_URL` is configured (local dev, tests).
 *  - `DbMerchantConnectionStore` — Postgres-backed (@ax10m/persistence), credentials
 *    encrypted at rest, for production multi-tenant deployments.
 *
 * The interface is async so a DB lookup is a drop-in for the in-memory map.
 */

import type { AdapterCredentials } from '@ax10m/poal';
import type { ConnectionRepository } from '@ax10m/persistence';

/** A merchant's connection to one processor account. */
export interface MerchantConnection {
  connectionId: string;
  merchantId: string;
  processor: string;
  config: AdapterCredentials;
}

/** DI token for the connection store. */
export const MERCHANT_CONNECTION_STORE = Symbol('MERCHANT_CONNECTION_STORE');

export interface MerchantConnectionStore {
  get(connectionId: string): Promise<MerchantConnection | undefined>;
  defaultFor(processor: string): Promise<MerchantConnection | undefined>;
  register(connection: MerchantConnection & { isDefault?: boolean }): Promise<void>;
  list(): Promise<MerchantConnection[]>;
}

/** In-memory reference store. */
export class InMemoryMerchantConnectionStore implements MerchantConnectionStore {
  private readonly byId = new Map<string, MerchantConnection>();
  private readonly defaults = new Map<string, string>();

  async get(connectionId: string): Promise<MerchantConnection | undefined> {
    return this.byId.get(connectionId);
  }
  async defaultFor(processor: string): Promise<MerchantConnection | undefined> {
    const id = this.defaults.get(processor);
    return id ? this.byId.get(id) : undefined;
  }
  async register(connection: MerchantConnection & { isDefault?: boolean }): Promise<void> {
    this.byId.set(connection.connectionId, connection);
    if (connection.isDefault || !this.defaults.has(connection.processor)) {
      this.defaults.set(connection.processor, connection.connectionId);
    }
  }
  async list(): Promise<MerchantConnection[]> {
    return [...this.byId.values()];
  }
}

/** Postgres-backed store over @ax10m/persistence's ConnectionRepository (encrypted creds). */
export class DbMerchantConnectionStore implements MerchantConnectionStore {
  constructor(private readonly repo: ConnectionRepository) {}

  async get(connectionId: string): Promise<MerchantConnection | undefined> {
    const c = await this.repo.get(connectionId);
    return c ? { connectionId: c.connectionId, merchantId: c.merchantId, processor: c.processor, config: c.config } : undefined;
  }
  async defaultFor(processor: string): Promise<MerchantConnection | undefined> {
    const c = await this.repo.defaultFor(processor);
    return c ? { connectionId: c.connectionId, merchantId: c.merchantId, processor: c.processor, config: c.config } : undefined;
  }
  async register(connection: MerchantConnection & { isDefault?: boolean }): Promise<void> {
    await this.repo.upsert({
      connectionId: connection.connectionId,
      merchantId: connection.merchantId,
      processor: connection.processor,
      config: connection.config,
      isDefault: connection.isDefault,
    });
  }
  async list(): Promise<MerchantConnection[]> {
    return (await this.repo.list()).map((c) => ({ connectionId: c.connectionId, merchantId: c.merchantId, processor: c.processor, config: c.config }));
  }
}

/**
 * Seed default connections from environment variables for single-tenant deployments,
 * so the legacy `/webhooks/:processor` endpoints work without registering a connection.
 */
export async function seedConnectionsFromEnv(store: MerchantConnectionStore, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const def = async (processor: string, merchantId: string | undefined, config: AdapterCredentials, required: string[]): Promise<void> => {
    if (required.some((k) => !config[k])) return;
    await store.register({ connectionId: `${processor}-default`, merchantId: merchantId ?? 'mrc_default', processor, config, isDefault: true });
  };

  await def('stripe', env.STRIPE_MERCHANT_ID, { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, apiVersion: env.STRIPE_API_VERSION }, ['secretKey', 'webhookSecret']);
  await def('chargebee', env.CHARGEBEE_MERCHANT_ID, { site: env.CHARGEBEE_SITE, apiKey: env.CHARGEBEE_API_KEY, webhookUser: env.CHARGEBEE_WEBHOOK_USER, webhookPassword: env.CHARGEBEE_WEBHOOK_PASSWORD }, ['site', 'apiKey']);
  await def('adyen', env.ADYEN_MERCHANT_ID, { apiKey: env.ADYEN_API_KEY, merchantAccount: env.ADYEN_MERCHANT_ACCOUNT, hmacKey: env.ADYEN_HMAC_KEY, baseUrl: env.ADYEN_CHECKOUT_URL }, ['apiKey', 'merchantAccount']);
  await def('braintree', env.BRAINTREE_AX10M_MERCHANT_ID, { braintreeMerchantId: env.BRAINTREE_MERCHANT_ID, publicKey: env.BRAINTREE_PUBLIC_KEY, privateKey: env.BRAINTREE_PRIVATE_KEY, environment: env.BRAINTREE_ENVIRONMENT }, ['braintreeMerchantId', 'publicKey', 'privateKey']);
  await def('gocardless', env.GOCARDLESS_MERCHANT_ID, { accessToken: env.GOCARDLESS_ACCESS_TOKEN, webhookSecret: env.GOCARDLESS_WEBHOOK_SECRET, environment: env.GOCARDLESS_ENVIRONMENT }, ['accessToken', 'webhookSecret']);
}
