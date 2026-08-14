/**
 * RecVue adapter (skeleton) — CO-DRIVE (billing platform).
 *
 * NOTE: RecVue is an enterprise recurring-billing, usage, and revenue-management
 * platform: it owns the invoice and the dunning loop and collects through an
 * underlying payment gateway (publicly known to integrate gateways such as
 * CyberSource / Stripe / Braintree underneath). Because RecVue exposes a billing API,
 * AX10M can CO-DRIVE recovery — collect on a stored token and pause native dunning
 * once wired — so BaseAdapter's co-drive `attemptCharge` throws a TODO (not the
 * advisory error).
 *
 * SKELETON: the capability matrix below is real, but the live integration
 * (collect-payment on a stored token via RecVue's REST API, webhook signature
 * verification, reconciliation poll) is TODO(ax10m) — the exact endpoint/field/version
 * contract must be established with RecVue.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface RecVueAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  clientId: string; // OAuth2 client credentials — to-confirm
  clientSecret: string; // OAuth2 client credentials — to-confirm
  baseUrl: string; // tenant API host — to-confirm
  webhookSecret?: string; // webhook signature secret — to-confirm
}

export class RecVueAdapter extends BaseAdapter {
  readonly id = 'recvue';
  constructor(private readonly config: RecVueAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive',
      externalRetryControl: true, // billing API can drive collection on our schedule
      accountUpdater: false, // card-updater support not publicly confirmed — conservative
      networkTokens: false, // not exposed to AX10M
      partialCapture: true, // platform owns the invoice → partial amounts supported
      pauseNativeDunning: true, // it owns dunning, so it can be paused
      webhooks: true,
      listPaymentMethods: true, // stored payment methods exposed via billing API
    };
  }
}
