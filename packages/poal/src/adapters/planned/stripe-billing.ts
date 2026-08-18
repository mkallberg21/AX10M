/**
 * Stripe Billing adapter (skeleton) — CO-DRIVE (subscription-billing platform).
 *
 * NOTE: Stripe Billing exposes a real, documented API (stripe.com/docs/api): Subscriptions,
 * Invoices (pay / voidInvoice / mark uncollectible), PaymentIntents on a stored PaymentMethod,
 * Smart Retries + dunning settings, Customer payment methods, and signed webhooks
 * (Stripe-Signature). Stripe Billing runs its OWN dunning (Smart Retries) that AX10M competes
 * with/overlays, so this is CO-DRIVE: AX10M can pay an open invoice / charge a stored
 * PaymentMethod but must coordinate with (pause / defer) Stripe's native retry schedule to
 * avoid double-charging. BaseAdapter's co-drive `attemptCharge` throws a TODO(ax10m), not the
 * advisory error.
 *
 * (Distinct from the implemented core `stripe` CARD-GATEWAY adapter: this is the Billing /
 * subscription-lifecycle surface — invoices, subscriptions, and native dunning control.)
 *
 * SKELETON: the capability matrix below is real, but the live integration is TODO(ax10m):
 *   - authentication (secret API key / restricted key)          — to-confirm which key scope
 *   - API version pinning                                       — to-confirm
 *   - pay-invoice / PaymentIntent field contract + decline map   — reuse the core stripe map — to-confirm
 *   - dunning-pause mechanism (retry schedule / collection pause) — to-confirm
 *   - webhook (Stripe-Signature) verification wiring            — reuse core stripe — to-confirm
 * Per the no-fabrication rule, field-level request/response shapes are NOT invented here;
 * much of the wiring can mirror the implemented core `stripe` adapter.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface StripeBillingAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** Stripe secret / restricted API key — to-confirm scope. */
  apiKey?: string;
  /** API base URL (override for Stripe-compatible hosts) — to-confirm. */
  baseUrl?: string;
  /** Webhook signing secret (Stripe-Signature) — to-confirm. */
  webhookSecret?: string;
}

export class StripeBillingAdapter extends BaseAdapter {
  readonly id = 'stripe-billing';
  constructor(private readonly config: StripeBillingAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive', // can pay invoices but must coordinate Smart Retries dunning
      externalRetryControl: true, // pay an open invoice / PaymentIntent on our schedule
      accountUpdater: true, // Stripe card-updater refreshes stored methods
      networkTokens: true, // Stripe network tokens supported
      partialCapture: true, // partial capture supported on PaymentIntents
      pauseNativeDunning: true, // Stripe Billing dunning/retry schedule can be controlled
      webhooks: true, // signed webhooks (Stripe-Signature)
      listPaymentMethods: true, // customer stored PaymentMethods enumerable
    };
  }
}
