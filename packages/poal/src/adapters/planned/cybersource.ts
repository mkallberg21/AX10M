/**
 * Cybersource (Visa Acceptance Solutions) adapter (skeleton) — DRIVE (card gateway).
 *
 * NOTE: Cybersource exposes a real, well-documented REST API (developer.cybersource.com)
 * with HTTP-Signature / JWT authentication: Payments, Token Management (TMS — instrument
 * identifiers / customer tokens / network tokens), Payer Authentication, Account Updater,
 * Reporting, and webhook notifications. Because AX10M can initiate the re-charge on a
 * stored token, this is a DRIVE integration — BaseAdapter's `attemptCharge` throws a
 * TODO(ax10m), not the advisory error.
 *
 * SKELETON: the capability matrix below is real, but the live integration is TODO(ax10m):
 *   - authentication (HTTP Signature vs. JWT; key/shared-secret provisioning) — to-confirm
 *   - production/sandbox base URL(s)                                          — to-confirm
 *   - create-payment / TMS request+response field contract + decline-code map — to-confirm
 *   - webhook signature verification scheme                                   — to-confirm
 * Per the project's no-fabrication rule, the field-level request/response shapes are
 * intentionally NOT invented here; they must be taken from the Cybersource API reference.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface CybersourceAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** Cybersource merchant id (the org/account) — to-confirm. */
  cybersourceMerchantId?: string;
  /** HTTP-Signature key id (shared-secret serial) — to-confirm. */
  apiKeyId?: string;
  /** HTTP-Signature shared secret — to-confirm. */
  apiSecretKey?: string;
  /** API base URL (prod/sandbox host) — to-confirm. */
  baseUrl?: string;
  /** Webhook signature secret — scheme + header name to-confirm. */
  webhookSecret?: string;
}

export class CybersourceAdapter extends BaseAdapter {
  readonly id = 'cybersource';
  constructor(private readonly config: CybersourceAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive', // Payments API lets AX10M initiate the re-charge on a TMS token
      externalRetryControl: true, // we drive the charge attempt on our own schedule
      accountUpdater: true, // Cybersource offers Account Updater
      networkTokens: true, // TMS supports network tokenization
      partialCapture: true, // partial capture supported on the Payments API
      pauseNativeDunning: false, // a gateway has no merchant dunning loop to pause
      webhooks: true, // webhook notifications documented — CONFIRM signing scheme
      listPaymentMethods: false, // enumeration of customer instruments not assumed — CONFIRM
    };
  }
}
