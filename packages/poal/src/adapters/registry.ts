/**
 * Processor registry — the enumerable roster of everything Lift targets.
 *
 * This is the machine-readable companion to PROCESSORS.md §2. Every processor Lift
 * intends to support is listed with its integration mode, segment, and adapter
 * status, so onboarding / dashboards can answer "do you support X?" from data, and
 * so "works with every processor" is a checklist, not a slogan.
 *
 * `status`:
 *  - 'skeleton'    — an adapter class exists (capability matrix real, calls TODO).
 *  - 'planned'     — on the roadmap; capability profile documented in PROCESSORS.md.
 */

import type { IntegrationMode } from '../adapter.js';

export type ProcessorSegment =
  | 'card-gateway'
  | 'billing-platform'
  | 'bank-debit'
  | 'merchant-of-record'
  | 'app-store';

export type AdapterStatus = 'skeleton' | 'planned';

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
  { id: 'stripe', displayName: 'Stripe', segment: 'card-gateway', mode: 'drive', status: 'skeleton' },
  { id: 'adyen', displayName: 'Adyen', segment: 'card-gateway', mode: 'drive', status: 'skeleton' },
  { id: 'braintree', displayName: 'Braintree (PayPal)', segment: 'card-gateway', mode: 'drive', status: 'skeleton' },
  { id: 'checkout', displayName: 'Checkout.com', segment: 'card-gateway', mode: 'drive', status: 'planned' },
  { id: 'cybersource', displayName: 'Cybersource (Visa)', segment: 'card-gateway', mode: 'drive', status: 'planned' },
  { id: 'authorizenet', displayName: 'Authorize.Net', segment: 'card-gateway', mode: 'drive', status: 'planned' },
  { id: 'worldpay', displayName: 'Worldpay / FIS', segment: 'card-gateway', mode: 'drive', status: 'planned' },
  { id: 'fiserv', displayName: 'Fiserv', segment: 'card-gateway', mode: 'co-drive', status: 'planned' },
  { id: 'globalpayments', displayName: 'Global Payments', segment: 'card-gateway', mode: 'drive', status: 'planned' },
  { id: 'square', displayName: 'Square', segment: 'card-gateway', mode: 'drive', status: 'planned' },
  { id: 'mollie', displayName: 'Mollie', segment: 'card-gateway', mode: 'co-drive', status: 'planned' },
  { id: 'nuvei', displayName: 'Nuvei', segment: 'card-gateway', mode: 'drive', status: 'planned' },
  { id: 'razorpay', displayName: 'Razorpay', segment: 'card-gateway', mode: 'co-drive', status: 'planned' },
  { id: 'payu', displayName: 'PayU', segment: 'card-gateway', mode: 'advisory', status: 'planned' },
  // Subscription-billing platforms
  { id: 'chargebee', displayName: 'Chargebee', segment: 'billing-platform', mode: 'drive', status: 'skeleton' },
  { id: 'recurly', displayName: 'Recurly', segment: 'billing-platform', mode: 'co-drive', status: 'planned' },
  { id: 'zuora', displayName: 'Zuora', segment: 'billing-platform', mode: 'co-drive', status: 'planned' },
  { id: 'maxio', displayName: 'Maxio (Chargify/SaaSOptics)', segment: 'billing-platform', mode: 'drive', status: 'planned' },
  { id: 'stripe-billing', displayName: 'Stripe Billing', segment: 'billing-platform', mode: 'co-drive', status: 'planned' },
  { id: 'vindicia', displayName: 'Vindicia', segment: 'billing-platform', mode: 'advisory', status: 'planned' },
  // Bank debit
  { id: 'gocardless', displayName: 'GoCardless', segment: 'bank-debit', mode: 'co-drive', status: 'skeleton' },
  // Merchant of Record
  { id: 'paddle', displayName: 'Paddle', segment: 'merchant-of-record', mode: 'advisory', status: 'skeleton' },
  // App stores (advisory-only, measurement + prompt)
  { id: 'apple-iap', displayName: 'Apple App Store', segment: 'app-store', mode: 'advisory', status: 'planned' },
  { id: 'google-play', displayName: 'Google Play', segment: 'app-store', mode: 'advisory', status: 'planned' },
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
