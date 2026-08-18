/**
 * Authorize.Net adapter (skeleton) — DRIVE (card gateway).
 *
 * NOTE: Authorize.Net exposes a real, documented API (developer.authorize.net): the
 * transaction API (createTransactionRequest), Customer Information Manager (CIM) for
 * stored payment profiles, and webhook notifications (event subscriptions with HMAC-SHA512
 * signing via the X-ANET-Signature header). AX10M can charge a stored CIM payment profile,
 * so this is a DRIVE integration — BaseAdapter's `attemptCharge` throws a TODO(ax10m).
 *
 * SKELETON: the capability matrix below is real, but the live integration is TODO(ax10m):
 *   - authentication (API Login ID + Transaction Key; or OAuth) — to-confirm
 *   - production/sandbox base URL(s)                            — to-confirm
 *   - createTransactionRequest / CIM field contract + decline-code (reason-code) map — to-confirm
 *   - webhook (X-ANET-Signature HMAC-SHA512) verification wiring — to-confirm
 * Per the no-fabrication rule, field-level request/response shapes are NOT invented here.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface AuthorizeNetAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** API Login ID — to-confirm. */
  apiLoginId?: string;
  /** Transaction Key — to-confirm. */
  transactionKey?: string;
  /** API base URL (prod/sandbox host) — to-confirm. */
  baseUrl?: string;
  /** Webhook signature key (X-ANET-Signature HMAC-SHA512) — to-confirm. */
  webhookSecret?: string;
}

export class AuthorizeNetAdapter extends BaseAdapter {
  readonly id = 'authorizenet';
  constructor(private readonly config: AuthorizeNetAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive', // charge a stored CIM payment profile on our schedule
      externalRetryControl: true, // we drive the charge attempt
      accountUpdater: true, // Authorize.Net offers an Account Updater service
      networkTokens: false, // CONFIRM — network-token support to the API not verified
      partialCapture: true, // partial capture (priorAuthCapture for a lesser amount) supported
      pauseNativeDunning: false, // a gateway has no merchant dunning loop to pause
      webhooks: true, // webhook notifications documented (X-ANET-Signature)
      listPaymentMethods: true, // CIM can enumerate a customer's stored payment profiles
    };
  }
}
