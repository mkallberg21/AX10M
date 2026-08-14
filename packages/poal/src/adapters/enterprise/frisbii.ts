/**
 * Frisbii adapter (skeleton) — CO-DRIVE (billing platform).
 *
 * NOTE: Frisbii (formerly Reepay / Billwerk) is a subscription-billing and
 * recurring-payments platform: it owns the invoice and the dunning loop and collects
 * through an underlying payment gateway (publicly known to run on gateways such as
 * Stripe / Adyen / Clearhaus underneath). Because Frisbii exposes a billing/charge
 * API, AX10M can CO-DRIVE recovery — collect on a stored token and pause native
 * dunning once wired — so BaseAdapter's co-drive `attemptCharge` throws a TODO (not
 * the advisory error).
 *
 * SKELETON: the capability matrix below is real, but the live integration
 * (collect-payment on a stored token via Frisbii's REST API, webhook signature
 * verification, reconciliation poll) is TODO(ax10m) — the exact endpoint/field/version
 * contract must be established with Frisbii.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface FrisbiiAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  apiKey: string; // private API key — to-confirm
  baseUrl: string; // Frisbii API host — to-confirm
  webhookSecret?: string; // webhook signature secret — to-confirm
}

export class FrisbiiAdapter extends BaseAdapter {
  readonly id = 'frisbii';
  constructor(private readonly config: FrisbiiAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive',
      externalRetryControl: true, // billing API can drive collection on our schedule
      accountUpdater: true, // Reepay/Frisbii supports card account updater
      networkTokens: true, // network tokenization documented for stored cards
      partialCapture: true, // platform owns the invoice → partial amounts supported
      pauseNativeDunning: true, // it owns dunning, so it can be paused
      webhooks: true,
      listPaymentMethods: true, // stored payment methods exposed via billing API
    };
  }
}
