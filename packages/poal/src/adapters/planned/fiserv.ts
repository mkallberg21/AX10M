/**
 * Fiserv adapter (skeleton) — CO-DRIVE (card gateway / acquiring platform).
 *
 * NOTE: Fiserv exposes real, documented developer APIs (developer.fiserv.com) across its
 * Commerce Hub / CommerceHub, Payeezy, and First Data gateway lineage: Charges/Payments,
 * tokenization, and event notifications. Fiserv commonly sits alongside merchant-side
 * billing and native retry logic, so AX10M CO-DRIVES here — it can collect on a stored
 * token but must coordinate with the merchant's / platform's own retry engine to avoid
 * double-charging. BaseAdapter's co-drive `attemptCharge` therefore throws a TODO(ax10m),
 * not the advisory error.
 *
 * SKELETON: the capability matrix below is real, but the live integration is TODO(ax10m):
 *   - authentication (Commerce Hub API key + secret HMAC; or Payeezy keys) — to-confirm
 *   - production/sandbox base URL(s)                                        — to-confirm
 *   - charge/token request+response field contract + decline-code map       — to-confirm
 *   - webhook / event-notification signature verification scheme            — to-confirm
 * Per the no-fabrication rule, field-level request/response shapes are NOT invented here.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface FiservAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** Commerce Hub API key — to-confirm. */
  apiKey?: string;
  /** Commerce Hub API secret (HMAC signing) — to-confirm. */
  apiSecret?: string;
  /** Merchant / terminal identifier — to-confirm. */
  merchantAccount?: string;
  /** API base URL (prod/sandbox host) — to-confirm. */
  baseUrl?: string;
  /** Webhook / event-notification signature secret — to-confirm. */
  webhookSecret?: string;
}

export class FiservAdapter extends BaseAdapter {
  readonly id = 'fiserv';
  constructor(private readonly config: FiservAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive', // can collect on a token but must coordinate native retry
      externalRetryControl: true, // Payments API can drive the charge on our schedule
      accountUpdater: true, // Fiserv offers Account Updater — CONFIRM API exposure
      networkTokens: true, // network tokenization supported — CONFIRM API exposure
      partialCapture: true, // partial capture supported on the Payments API
      pauseNativeDunning: false, // no unified merchant dunning loop exposed to pause
      webhooks: true, // event notifications documented — CONFIRM signing scheme
      listPaymentMethods: false, // customer method enumeration not assumed — CONFIRM
    };
  }
}
