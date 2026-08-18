/**
 * Mollie adapter (skeleton) — CO-DRIVE (card gateway with recurring/subscriptions).
 *
 * NOTE: Mollie exposes a real, documented REST API (docs.mollie.com): Payments, Customers,
 * Mandates, Subscriptions (Mollie runs its own recurring/subscription engine), and webhooks
 * (Mollie posts the payment id; the adapter fetches the resource to verify). Because Mollie
 * can own a recurring subscription + its own retry, AX10M CO-DRIVES: it can create a
 * recurring "first payment" charge on a stored mandate but must coordinate with Mollie's
 * subscription engine to avoid double-charging. BaseAdapter's co-drive `attemptCharge`
 * therefore throws a TODO(ax10m), not the advisory error.
 *
 * SKELETON: the capability matrix below is real, but the live integration is TODO(ax10m):
 *   - authentication (API key / OAuth bearer)                   — to-confirm
 *   - production/test base URL + API surface pinning            — to-confirm
 *   - Payments/Mandates field contract + decline (status) map    — to-confirm
 *   - webhook verification (fetch-by-id) wiring                  — to-confirm
 * Per the no-fabrication rule, field-level request/response shapes are NOT invented here.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface MollieAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** Mollie API key (bearer) — to-confirm. */
  apiKey?: string;
  /** API base URL (prod/test host) — to-confirm. */
  baseUrl?: string;
  /** Webhook secret / verification scheme — Mollie posts an id to fetch — to-confirm. */
  webhookSecret?: string;
}

export class MollieAdapter extends BaseAdapter {
  readonly id = 'mollie';
  constructor(private readonly config: MollieAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive', // can charge a mandate but must coordinate Mollie subscriptions
      externalRetryControl: true, // Payments API can drive a recurring charge on our schedule
      accountUpdater: false, // not exposed to the API
      networkTokens: false, // not exposed to the API
      partialCapture: false, // conservative default until verified
      pauseNativeDunning: false, // Mollie subscription dunning not exposed as an AX10M pause
      webhooks: true, // webhooks documented (fetch-by-id verification)
      listPaymentMethods: true, // Customers/Mandates can enumerate stored mandates
    };
  }
}
