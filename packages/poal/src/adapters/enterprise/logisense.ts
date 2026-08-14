/**
 * LogiSense adapter (skeleton) — CO-DRIVE (billing platform).
 *
 * NOTE: LogiSense is an enterprise usage-based / subscription-billing platform: it
 * owns the invoice and the dunning loop and collects through an underlying payment
 * gateway (publicly known to integrate gateways such as CyberSource / Stripe /
 * Authorize.Net underneath). Because LogiSense exposes a billing API, AX10M can
 * CO-DRIVE recovery — collect on a stored token and pause native dunning once wired —
 * so BaseAdapter's co-drive `attemptCharge` throws a TODO (not the advisory error).
 *
 * SKELETON: the capability matrix below is real, but the live integration
 * (collect-payment on a stored token via LogiSense's REST API, webhook signature
 * verification, reconciliation poll) is TODO(ax10m) — the exact endpoint/field/version
 * contract must be established with LogiSense.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface LogiSenseAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  apiKey: string; // API key / bearer token — to-confirm
  baseUrl: string; // tenant API host — to-confirm
  webhookSecret?: string; // webhook signature secret — to-confirm
}

export class LogiSenseAdapter extends BaseAdapter {
  readonly id = 'logisense';
  constructor(private readonly config: LogiSenseAdapterConfig) {
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
