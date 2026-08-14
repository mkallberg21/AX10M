/**
 * Chargebee adapter (skeleton) — DRIVE (best billing-platform surface).
 *
 * Retry via the "Collect payment for an invoice" API against a stored
 * `payment_source_id`; crucially, a manual/API collect does NOT consume native
 * dunning attempts, so Lift can coexist with or fully replace Chargebee dunning.
 * Ingress on `payment_failed` + invoice status transitions. Account Updater and
 * network tokens pass through the underlying gateway. PROCESSORS.md §3.
 */

import type { CapabilityMatrix } from '../adapter.js';
import { BaseAdapter } from './base.js';

export interface ChargebeeAdapterConfig {
  site: string; // <site>.chargebee.com
  apiKey: string;
  webhookUser?: string;
  webhookPassword?: string; // Chargebee webhooks use basic auth
}

export class ChargebeeAdapter extends BaseAdapter {
  readonly id = 'chargebee';
  constructor(private readonly config: ChargebeeAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive',
      externalRetryControl: true,
      accountUpdater: true, // via gateway (Stripe/Braintree/Adyen/…)
      networkTokens: true, // via gateway / Chargebee Payments
      partialCapture: true, // collect API accepts an amount ≤ amount_to_collect
      pauseNativeDunning: true, // dunning is disableable per site/subscription
      webhooks: true,
      listPaymentMethods: true,
    };
  }
}
