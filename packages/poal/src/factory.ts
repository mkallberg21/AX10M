/**
 * Adapter factory — build the right `ProcessorAdapter` from a merchant's stored
 * credentials, keyed by processor id.
 *
 * This is what per-merchant webhook routing needs: given the processor an inbound
 * webhook is for and THAT merchant's connection config, construct the adapter that
 * verifies + normalizes it. Only WEBHOOK-CAPABLE processors are registered here —
 * gateways with no signed webhooks (TSYS, Elavon) and the enterprise skeletons are
 * intentionally absent, so an attempt to route a webhook to them fails fast.
 *
 * Config is passed as an opaque bag (it comes from a per-merchant store / DB); each
 * builder reads the fields its adapter needs. `merchantId` is supplied separately by
 * the caller (from the resolved connection), never trusted from the webhook body.
 */

import type { ProcessorAdapter } from './adapter.js';
import { StripeAdapter } from './stripe/index.js';
import {
  AdyenAdapter,
  BigCommerceAdapter,
  BraintreeAdapter,
  ChargebeeAdapter,
  CheckoutAdapter,
  GoCardlessAdapter,
  KajabiAdapter,
  MaxioAdapter,
  PayPalAdapter,
  RecurlyAdapter,
  SamCartAdapter,
  ShopifyAdapter,
  ThriveCartAdapter,
  WooCommerceAdapter,
  WorldpayAdapter,
  ZuoraAdapter,
} from './adapters/index.js';

/** A merchant's processor credentials/settings (opaque bag from the connection store). */
export type AdapterCredentials = Record<string, unknown>;

/** Builds one adapter instance for a merchant. */
export type AdapterBuilder = (merchantId: string, config: AdapterCredentials) => ProcessorAdapter;

function str(c: AdapterCredentials, key: string): string {
  const v = c[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`adapter config: missing required string field '${key}'`);
  }
  return v;
}
function opt(c: AdapterCredentials, key: string): string | undefined {
  const v = c[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Every webhook-capable processor → its adapter builder. */
export const ADAPTER_FACTORIES: Readonly<Record<string, AdapterBuilder>> = {
  // Card gateways
  stripe: (merchantId, c) =>
    new StripeAdapter({ merchantId, secretKey: str(c, 'secretKey'), webhookSecret: str(c, 'webhookSecret'), apiVersion: opt(c, 'apiVersion') }),
  adyen: (merchantId, c) =>
    new AdyenAdapter({ merchantId, apiKey: str(c, 'apiKey'), merchantAccount: str(c, 'merchantAccount'), hmacKey: opt(c, 'hmacKey'), baseUrl: opt(c, 'baseUrl') }),
  braintree: (merchantId, c) =>
    new BraintreeAdapter({
      merchantId,
      braintreeMerchantId: str(c, 'braintreeMerchantId'),
      publicKey: str(c, 'publicKey'),
      privateKey: str(c, 'privateKey'),
      environment: opt(c, 'environment') === 'production' ? 'production' : 'sandbox',
      baseUrl: opt(c, 'baseUrl'),
    }),
  paypal: (merchantId, c) =>
    new PayPalAdapter({ merchantId, clientId: str(c, 'clientId'), clientSecret: str(c, 'clientSecret'), webhookId: opt(c, 'webhookId'), baseUrl: opt(c, 'baseUrl') }),
  checkout: (merchantId, c) =>
    new CheckoutAdapter({ merchantId, secretKey: str(c, 'secretKey'), webhookSecret: opt(c, 'webhookSecret'), baseUrl: opt(c, 'baseUrl') }),
  worldpay: (merchantId, c) =>
    new WorldpayAdapter({
      merchantId,
      username: str(c, 'username'),
      password: str(c, 'password'),
      entity: str(c, 'entity'),
      webhookSecret: opt(c, 'webhookSecret'),
      signatureHeader: opt(c, 'signatureHeader'),
      baseUrl: opt(c, 'baseUrl'),
    }),

  // Subscription-billing platforms
  chargebee: (merchantId, c) =>
    new ChargebeeAdapter({
      merchantId,
      site: str(c, 'site'),
      apiKey: str(c, 'apiKey'),
      webhookUser: opt(c, 'webhookUser'),
      webhookPassword: opt(c, 'webhookPassword'),
      baseUrl: opt(c, 'baseUrl'),
    }),
  recurly: (merchantId, c) =>
    new RecurlyAdapter({
      merchantId,
      apiKey: str(c, 'apiKey'),
      webhookUser: opt(c, 'webhookUser'),
      webhookPassword: opt(c, 'webhookPassword'),
      baseUrl: opt(c, 'baseUrl'),
    }),
  zuora: (merchantId, c) =>
    new ZuoraAdapter({ merchantId, clientId: str(c, 'clientId'), clientSecret: str(c, 'clientSecret'), webhookSecret: opt(c, 'webhookSecret'), baseUrl: opt(c, 'baseUrl') }),
  maxio: (merchantId, c) =>
    new MaxioAdapter({ merchantId, apiKey: str(c, 'apiKey'), subdomain: str(c, 'subdomain'), webhookSecret: opt(c, 'webhookSecret'), baseUrl: opt(c, 'baseUrl') }),

  // Bank debit
  gocardless: (merchantId, c) =>
    new GoCardlessAdapter({
      merchantId,
      accessToken: str(c, 'accessToken'),
      webhookSecret: str(c, 'webhookSecret'),
      environment: opt(c, 'environment') === 'live' ? 'live' : 'sandbox',
      baseUrl: opt(c, 'baseUrl'),
    }),

  // E-commerce / storefront platforms
  shopify: (merchantId, c) =>
    new ShopifyAdapter({
      merchantId,
      shop: str(c, 'shop'),
      accessToken: str(c, 'accessToken'),
      apiSecret: str(c, 'apiSecret'),
      apiVersion: opt(c, 'apiVersion'),
      baseUrl: opt(c, 'baseUrl'),
    }),
  woocommerce: (merchantId, c) =>
    new WooCommerceAdapter({
      merchantId,
      storeUrl: str(c, 'storeUrl'),
      consumerKey: str(c, 'consumerKey'),
      consumerSecret: str(c, 'consumerSecret'),
      webhookSecret: str(c, 'webhookSecret'),
      baseUrl: opt(c, 'baseUrl'),
    }),
  bigcommerce: (merchantId, c) =>
    new BigCommerceAdapter({ merchantId, webhookSecret: str(c, 'webhookSecret'), storeHash: opt(c, 'storeHash'), signatureHeader: opt(c, 'signatureHeader') }),

  // Creator-commerce / cart platforms (advisory)
  kajabi: (merchantId, c) => new KajabiAdapter({ merchantId, webhookSecret: str(c, 'webhookSecret'), signatureHeader: opt(c, 'signatureHeader') }),
  thrivecart: (merchantId, c) => new ThriveCartAdapter({ merchantId, webhookSecret: str(c, 'webhookSecret'), secretHeader: opt(c, 'secretHeader') }),
  samcart: (merchantId, c) => new SamCartAdapter({ merchantId, webhookSecret: str(c, 'webhookSecret'), signatureHeader: opt(c, 'signatureHeader') }),
};

/** True if the processor has a webhook-capable adapter registered. */
export function isWebhookCapable(processor: string): boolean {
  return Object.prototype.hasOwnProperty.call(ADAPTER_FACTORIES, processor);
}

/** List every processor id that can receive webhooks through the factory. */
export function webhookCapableProcessors(): string[] {
  return Object.keys(ADAPTER_FACTORIES);
}

/**
 * Build the adapter for a processor from a merchant's credentials. Throws if the
 * processor isn't webhook-capable or a required credential field is missing.
 */
export function buildAdapter(processor: string, merchantId: string, config: AdapterCredentials): ProcessorAdapter {
  const builder = ADAPTER_FACTORIES[processor];
  if (!builder) {
    throw new Error(`No webhook-capable adapter for processor '${processor}' (webhook routing unsupported).`);
  }
  return builder(merchantId, config);
}
