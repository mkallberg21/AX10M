/**
 * Global Payments adapter (skeleton) — DRIVE (card gateway).
 *
 * NOTE: Global Payments exposes a real, documented REST API (developer.globalpay.com) —
 * the GP API (Unified Commerce Platform): Transactions (charge/authorize/capture), stored
 * payment methods / tokenization, Payment Link, Disputes, and webhooks. AX10M can initiate
 * the re-charge on a stored token, so this is a DRIVE integration — BaseAdapter's
 * `attemptCharge` throws a TODO(ax10m), not the advisory error.
 *
 * (Note: TSYS is a Global Payments company but already has its own implemented adapter;
 * this entry is the Global Payments / GP API surface specifically.)
 *
 * SKELETON: the capability matrix below is real, but the live integration is TODO(ax10m):
 *   - authentication (GP API app-id + app-key → bearer access token) — to-confirm
 *   - production/sandbox base URL(s)                                  — to-confirm
 *   - transaction/token request+response field contract + decline map — to-confirm
 *   - webhook signature verification scheme                           — to-confirm
 * Per the no-fabrication rule, field-level request/response shapes are NOT invented here.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface GlobalPaymentsAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** GP API app id — to-confirm. */
  appId?: string;
  /** GP API app key (used to mint the access token) — to-confirm. */
  appKey?: string;
  /** API base URL (prod/sandbox host) — to-confirm. */
  baseUrl?: string;
  /** Webhook signature secret — scheme + header name to-confirm. */
  webhookSecret?: string;
}

export class GlobalPaymentsAdapter extends BaseAdapter {
  readonly id = 'globalpayments';
  constructor(private readonly config: GlobalPaymentsAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive', // GP API Transactions let AX10M initiate the re-charge on a token
      externalRetryControl: true, // we drive the charge attempt on our own schedule
      accountUpdater: true, // Global Payments offers Account Updater — CONFIRM API exposure
      networkTokens: true, // network tokenization supported — CONFIRM API exposure
      partialCapture: true, // partial capture supported on the Transactions API
      pauseNativeDunning: false, // a gateway has no merchant dunning loop to pause
      webhooks: true, // webhooks documented — CONFIRM signing scheme
      listPaymentMethods: false, // customer method enumeration not assumed — CONFIRM
    };
  }
}
