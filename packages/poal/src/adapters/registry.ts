/**
 * Processor registry — the enumerable roster of everything AX10M targets.
 *
 * This is the machine-readable companion to PROCESSORS.md §2. Every processor AX10M
 * intends to support is listed with its integration mode, segment, and adapter
 * status, so onboarding / dashboards can answer "do you support X?" from data, and
 * so "works with every processor" is a checklist, not a slogan.
 *
 * `status`:
 *  - 'implemented' — adapter wired end-to-end against the processor's real API.
 *  - 'skeleton'    — an adapter class exists (capability matrix real, calls TODO).
 *  - 'planned'     — on the roadmap; capability profile documented in PROCESSORS.md.
 */

import type { IntegrationMode } from '../adapter.js';

export type ProcessorSegment =
  | 'card-gateway'
  | 'billing-platform'
  | 'bank-debit'
  | 'merchant-of-record'
  | 'ecommerce-platform'
  | 'creator-commerce'
  | 'app-store';

export type AdapterStatus = 'implemented' | 'skeleton' | 'planned';

export interface ProcessorDescriptor {
  id: string;
  displayName: string;
  segment: ProcessorSegment;
  mode: IntegrationMode;
  status: AdapterStatus;
}

/** The full roster (PROCESSORS.md §2). Modes reflect the researched capability set. */
export const PROCESSOR_REGISTRY: readonly ProcessorDescriptor[] = [
  // Card gateways
  { id: 'stripe', displayName: 'Stripe', segment: 'card-gateway', mode: 'drive', status: 'implemented' },
  { id: 'adyen', displayName: 'Adyen', segment: 'card-gateway', mode: 'drive', status: 'implemented' },
  { id: 'braintree', displayName: 'Braintree (PayPal)', segment: 'card-gateway', mode: 'drive', status: 'implemented' },
  { id: 'paypal', displayName: 'PayPal', segment: 'card-gateway', mode: 'drive', status: 'implemented' },
  { id: 'checkout', displayName: 'Checkout.com', segment: 'card-gateway', mode: 'drive', status: 'implemented' },
  { id: 'worldpay', displayName: 'Worldpay / FIS', segment: 'card-gateway', mode: 'drive', status: 'implemented' },
  { id: 'tsys', displayName: 'TSYS (Global Payments)', segment: 'card-gateway', mode: 'drive', status: 'implemented' },
  { id: 'elavon', displayName: 'Elavon (Converge)', segment: 'card-gateway', mode: 'drive', status: 'implemented' },
  // Deluxe Connect / Merchant Services API is real + drive-capable (Payments, tokenized Payment
  // Methods, Reports, webhooks); skeleton until the field-level spec (auth/base-URL/webhook) is wired.
  { id: 'deluxe', displayName: 'Deluxe Merchant Services', segment: 'card-gateway', mode: 'drive', status: 'skeleton' },
  { id: 'cybersource', displayName: 'Cybersource (Visa)', segment: 'card-gateway', mode: 'drive', status: 'skeleton' },
  { id: 'authorizenet', displayName: 'Authorize.Net', segment: 'card-gateway', mode: 'drive', status: 'skeleton' },
  { id: 'fiserv', displayName: 'Fiserv', segment: 'card-gateway', mode: 'co-drive', status: 'skeleton' },
  { id: 'globalpayments', displayName: 'Global Payments', segment: 'card-gateway', mode: 'drive', status: 'skeleton' },
  { id: 'square', displayName: 'Square', segment: 'card-gateway', mode: 'drive', status: 'skeleton' },
  { id: 'mollie', displayName: 'Mollie', segment: 'card-gateway', mode: 'co-drive', status: 'skeleton' },
  { id: 'nuvei', displayName: 'Nuvei', segment: 'card-gateway', mode: 'drive', status: 'skeleton' },
  { id: 'razorpay', displayName: 'Razorpay', segment: 'card-gateway', mode: 'co-drive', status: 'skeleton' },
  { id: 'payu', displayName: 'PayU', segment: 'card-gateway', mode: 'advisory', status: 'skeleton' },
  // Subscription-billing platforms
  { id: 'chargebee', displayName: 'Chargebee', segment: 'billing-platform', mode: 'drive', status: 'implemented' },
  { id: 'recurly', displayName: 'Recurly', segment: 'billing-platform', mode: 'co-drive', status: 'implemented' },
  { id: 'zuora', displayName: 'Zuora', segment: 'billing-platform', mode: 'co-drive', status: 'implemented' },
  { id: 'maxio', displayName: 'Maxio (Chargify/SaaSOptics)', segment: 'billing-platform', mode: 'drive', status: 'implemented' },
  { id: 'stripe-billing', displayName: 'Stripe Billing', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'vindicia', displayName: 'Vindicia', segment: 'billing-platform', mode: 'advisory', status: 'skeleton' },
  // Enterprise billing / monetization platforms (co-drive; skeleton connectors — capability
  // matrix real, live API integration TODO given proprietary/partner-gated APIs).
  { id: 'appdirect', displayName: 'AppDirect', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'aria', displayName: 'Aria Systems', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'billingplatform', displayName: 'BillingPlatform', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'blulogix', displayName: 'BluLogix', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'frisbii', displayName: 'Frisbii (Reepay/Billwerk)', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'gotransverse', displayName: 'Gotransverse', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'keylight', displayName: 'Keylight', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'logisense', displayName: 'LogiSense', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'oracle-brm', displayName: 'Oracle (BRM / Subscription Mgmt)', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'recvue', displayName: 'RecVue', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'sap-brim', displayName: 'SAP (BRIM / Subscription Billing)', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'salesforce-revenue-cloud', displayName: 'Salesforce Revenue Cloud Billing', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  { id: 'onebill', displayName: 'OneBill', segment: 'billing-platform', mode: 'co-drive', status: 'skeleton' },
  // Bank debit
  { id: 'gocardless', displayName: 'GoCardless', segment: 'bank-debit', mode: 'co-drive', status: 'implemented' },
  // Merchant of Record
  { id: 'paddle', displayName: 'Paddle', segment: 'merchant-of-record', mode: 'advisory', status: 'skeleton' },
  // E-commerce / storefront platforms
  { id: 'shopify', displayName: 'Shopify', segment: 'ecommerce-platform', mode: 'co-drive', status: 'implemented' },
  { id: 'woocommerce', displayName: 'WooCommerce', segment: 'ecommerce-platform', mode: 'co-drive', status: 'implemented' },
  { id: 'bigcommerce', displayName: 'BigCommerce', segment: 'ecommerce-platform', mode: 'advisory', status: 'implemented' },
  // Creator-commerce / cart platforms (advisory: platform owns token + dunning; measure + advise)
  { id: 'kajabi', displayName: 'Kajabi', segment: 'creator-commerce', mode: 'advisory', status: 'implemented' },
  { id: 'thrivecart', displayName: 'ThriveCart', segment: 'creator-commerce', mode: 'advisory', status: 'implemented' },
  { id: 'samcart', displayName: 'SamCart', segment: 'creator-commerce', mode: 'advisory', status: 'implemented' },
  // App stores (advisory-only, measurement + prompt)
  { id: 'apple-iap', displayName: 'Apple App Store', segment: 'app-store', mode: 'advisory', status: 'skeleton' },
  { id: 'google-play', displayName: 'Google Play', segment: 'app-store', mode: 'advisory', status: 'skeleton' },
];

/** Look up a processor descriptor by id. */
export function getProcessor(id: string): ProcessorDescriptor | undefined {
  return PROCESSOR_REGISTRY.find((p) => p.id === id);
}

/** Count of processors we can drive or co-drive (i.e. actually recover on), vs advisory-only. */
export function coverageSummary(): { drive: number; coDrive: number; advisory: number; total: number } {
  const total = PROCESSOR_REGISTRY.length;
  const drive = PROCESSOR_REGISTRY.filter((p) => p.mode === 'drive').length;
  const coDrive = PROCESSOR_REGISTRY.filter((p) => p.mode === 'co-drive').length;
  const advisory = PROCESSOR_REGISTRY.filter((p) => p.mode === 'advisory').length;
  return { drive, coDrive, advisory, total };
}
