/**
 * Nuvei adapter (skeleton) — DRIVE (card gateway).
 *
 * NOTE: Nuvei exposes a real, documented REST API (docs.nuvei.com): the payments API
 * (payment / initPayment), card tokenization (userPaymentOptionId), Payment Account Updater,
 * network tokens, and DMN (Direct Merchant Notification) webhooks with checksum verification.
 * AX10M can charge a stored token, so this is a DRIVE integration — BaseAdapter's
 * `attemptCharge` throws a TODO(ax10m), not the advisory error.
 *
 * SKELETON: the capability matrix below is real, but the live integration is TODO(ax10m):
 *   - authentication (merchant id + site id + secret → session/checksum) — to-confirm
 *   - production/sandbox base URL(s)                                       — to-confirm
 *   - payment/token request+response field contract + decline map          — to-confirm
 *   - DMN checksum verification scheme                                      — to-confirm
 * Per the no-fabrication rule, field-level request/response shapes are NOT invented here.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface NuveiAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** Nuvei merchant id — to-confirm. */
  nuveiMerchantId?: string;
  /** Nuvei merchant site id — to-confirm. */
  merchantSiteId?: string;
  /** Secret key (checksum signing) — to-confirm. */
  secretKey?: string;
  /** API base URL (prod/sandbox host) — to-confirm. */
  baseUrl?: string;
  /** DMN / webhook verification secret — to-confirm. */
  webhookSecret?: string;
}

export class NuveiAdapter extends BaseAdapter {
  readonly id = 'nuvei';
  constructor(private readonly config: NuveiAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive', // payments API lets AX10M initiate the re-charge on a stored token
      externalRetryControl: true, // we drive the charge attempt on our own schedule
      accountUpdater: true, // Nuvei offers Payment Account Updater
      networkTokens: true, // network tokenization supported
      partialCapture: true, // partial settle/capture supported
      pauseNativeDunning: false, // a gateway has no merchant dunning loop to pause
      webhooks: true, // DMN notifications documented — CONFIRM checksum wiring
      listPaymentMethods: false, // customer method enumeration not assumed — CONFIRM
    };
  }
}
