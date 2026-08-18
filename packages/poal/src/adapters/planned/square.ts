/**
 * Square adapter (skeleton) — DRIVE (card gateway).
 *
 * NOTE: Square exposes a real, documented REST API (developer.squareup.com): Payments
 * (CreatePayment on a stored card-on-file), Cards / Customers (stored cards), and webhook
 * event subscriptions signed with an HMAC-SHA256 signature (x-square-hmacsha256-signature).
 * AX10M can charge a stored card-on-file, so this is a DRIVE integration — BaseAdapter's
 * `attemptCharge` throws a TODO(ax10m), not the advisory error.
 *
 * SKELETON: the capability matrix below is real, but the live integration is TODO(ax10m):
 *   - authentication (OAuth access token / bearer)               — to-confirm
 *   - production/sandbox base URL(s) + API version pinning       — to-confirm
 *   - CreatePayment / Cards field contract + decline (error) map — to-confirm
 *   - webhook HMAC-SHA256 signature verification wiring          — to-confirm
 * Per the no-fabrication rule, field-level request/response shapes are NOT invented here.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface SquareAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** Square OAuth access token (bearer) — to-confirm. */
  accessToken?: string;
  /** Square location id — to-confirm. */
  locationId?: string;
  /** API base URL (prod/sandbox host) — to-confirm. */
  baseUrl?: string;
  /** Webhook signature key (HMAC-SHA256) — to-confirm. */
  webhookSecret?: string;
}

export class SquareAdapter extends BaseAdapter {
  readonly id = 'square';
  constructor(private readonly config: SquareAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive', // CreatePayment on a stored card-on-file lets AX10M re-charge
      externalRetryControl: true, // we drive the charge attempt on our own schedule
      accountUpdater: false, // CONFIRM — Square-managed card refresh not exposed as Account Updater
      networkTokens: false, // CONFIRM — network-token support to the API not verified
      partialCapture: false, // CONFIRM — conservative default until verified
      pauseNativeDunning: false, // a gateway has no merchant dunning loop to pause
      webhooks: true, // webhook subscriptions documented (HMAC-SHA256)
      listPaymentMethods: true, // Cards API can enumerate a customer's stored cards
    };
  }
}
