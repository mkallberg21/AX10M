/**
 * AppDirect adapter (skeleton) — CO-DRIVE (billing platform).
 *
 * NOTE: AppDirect is a cloud-commerce / subscription-billing platform: it owns the
 * invoice and the dunning loop and collects through an underlying payment gateway
 * (publicly known to run on gateways such as Stripe / CyberSource / Braintree
 * underneath). Because AppDirect exposes a billing API, AX10M can CO-DRIVE recovery —
 * collect on a stored token and pause native dunning once wired — so BaseAdapter's
 * co-drive `attemptCharge` throws a TODO (not the advisory error).
 *
 * SKELETON: the capability matrix below is real, but the live integration
 * (collect-payment on a stored token via AppDirect's REST API, webhook signature
 * verification, reconciliation poll) is TODO(ax10m) — the exact endpoint/field/version
 * contract must be established with AppDirect.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface AppDirectAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  clientId: string; // OAuth2 client credentials — to-confirm
  clientSecret: string; // OAuth2 client credentials — to-confirm
  baseUrl: string; // per-marketplace API host — to-confirm
  webhookSecret?: string; // webhook signature secret — to-confirm
}

export class AppDirectAdapter extends BaseAdapter {
  readonly id = 'appdirect';
  constructor(private readonly config: AppDirectAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive',
      externalRetryControl: true, // billing API can drive collection on our schedule
      accountUpdater: true, // marketplace billing runs card-updater via its gateway
      networkTokens: false, // not exposed to AX10M
      partialCapture: true, // platform owns the invoice → partial amounts supported
      pauseNativeDunning: true, // it owns dunning, so it can be paused
      webhooks: true,
      listPaymentMethods: true, // stored methods exposed via billing API
    };
  }
}
