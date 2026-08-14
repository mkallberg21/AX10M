/**
 * Merchant connection store — maps an inbound webhook to the merchant + credentials
 * it belongs to. This is the core of per-merchant routing: a processor endpoint is
 * registered per (merchant, processor account) with a unique `connectionId` embedded
 * in the webhook URL, and this store resolves that id to the stored config the adapter
 * factory builds from.
 *
 * The interface is the seam; production backs it with encrypted Postgres/secrets. The
 * in-memory implementation here is the reference, seeded from env for single-tenant
 * deployments (the legacy `/webhooks/:processor` default connections).
 */

import type { AdapterCredentials } from '@ax10m/poal';

/** A merchant's connection to one processor account. */
export interface MerchantConnection {
  /** Unique per (merchant, processor account) — embedded in the webhook URL. */
  connectionId: string;
  /** AX10M-internal merchant id, stamped on canonical events (never trusted from webhook bodies). */
  merchantId: string;
  /** Processor id (must be webhook-capable in the adapter factory). */
  processor: string;
  /** Processor-specific credentials/settings the adapter factory reads. */
  config: AdapterCredentials;
}

/** DI token for the connection store. */
export const MERCHANT_CONNECTION_STORE = Symbol('MERCHANT_CONNECTION_STORE');

export interface MerchantConnectionStore {
  /** Resolve a connection by its id (from the webhook URL). */
  get(connectionId: string): MerchantConnection | undefined;
  /** The default connection for a processor (single-tenant `/webhooks/:processor`). */
  defaultFor(processor: string): MerchantConnection | undefined;
  /** Register/overwrite a connection. The first connection for a processor becomes its default. */
  register(connection: MerchantConnection): void;
  /** All registered connections (observability / admin). */
  list(): MerchantConnection[];
}

/** In-memory reference store. Swap for a persistent, encrypted store in production. */
export class InMemoryMerchantConnectionStore implements MerchantConnectionStore {
  private readonly byId = new Map<string, MerchantConnection>();
  private readonly defaults = new Map<string, string>(); // processor → connectionId

  get(connectionId: string): MerchantConnection | undefined {
    return this.byId.get(connectionId);
  }
  defaultFor(processor: string): MerchantConnection | undefined {
    const id = this.defaults.get(processor);
    return id ? this.byId.get(id) : undefined;
  }
  register(connection: MerchantConnection): void {
    this.byId.set(connection.connectionId, connection);
    if (!this.defaults.has(connection.processor)) this.defaults.set(connection.processor, connection.connectionId);
  }
  list(): MerchantConnection[] {
    return [...this.byId.values()];
  }
}

/**
 * Seed default connections from environment variables for single-tenant deployments,
 * so the legacy `/webhooks/:processor` endpoints keep working without registering a
 * connection. Only registers a processor whose required secret(s) are present, so an
 * unconfigured processor simply has no default (and its webhooks 404 until connected).
 */
export function seedConnectionsFromEnv(
  store: MerchantConnectionStore,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const def = (processor: string, merchantId: string | undefined, config: AdapterCredentials, required: string[]): void => {
    if (required.some((k) => !config[k])) return; // not configured → no default
    store.register({ connectionId: `${processor}-default`, merchantId: merchantId ?? 'mrc_default', processor, config });
  };

  def('stripe', env.STRIPE_MERCHANT_ID, { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, apiVersion: env.STRIPE_API_VERSION }, ['secretKey', 'webhookSecret']);
  def('chargebee', env.CHARGEBEE_MERCHANT_ID, { site: env.CHARGEBEE_SITE, apiKey: env.CHARGEBEE_API_KEY, webhookUser: env.CHARGEBEE_WEBHOOK_USER, webhookPassword: env.CHARGEBEE_WEBHOOK_PASSWORD }, ['site', 'apiKey']);
  def('adyen', env.ADYEN_MERCHANT_ID, { apiKey: env.ADYEN_API_KEY, merchantAccount: env.ADYEN_MERCHANT_ACCOUNT, hmacKey: env.ADYEN_HMAC_KEY, baseUrl: env.ADYEN_CHECKOUT_URL }, ['apiKey', 'merchantAccount']);
  def('braintree', env.BRAINTREE_AX10M_MERCHANT_ID, { braintreeMerchantId: env.BRAINTREE_MERCHANT_ID, publicKey: env.BRAINTREE_PUBLIC_KEY, privateKey: env.BRAINTREE_PRIVATE_KEY, environment: env.BRAINTREE_ENVIRONMENT }, ['braintreeMerchantId', 'publicKey', 'privateKey']);
  def('gocardless', env.GOCARDLESS_MERCHANT_ID, { accessToken: env.GOCARDLESS_ACCESS_TOKEN, webhookSecret: env.GOCARDLESS_WEBHOOK_SECRET, environment: env.GOCARDLESS_ENVIRONMENT }, ['accessToken', 'webhookSecret']);
}
