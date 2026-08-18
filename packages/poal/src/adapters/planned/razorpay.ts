/**
 * Razorpay adapter (skeleton) — CO-DRIVE (card gateway with subscriptions, India).
 *
 * NOTE: Razorpay exposes a real, documented REST API (razorpay.com/docs): Orders/Payments,
 * Tokens (RBI-compliant tokenization / recurring tokens), Subscriptions (Razorpay runs its
 * own recurring engine), and webhooks signed with HMAC-SHA256 (X-Razorpay-Signature).
 * Under India's RBI e-mandate rules, merchant-initiated recurring charges are constrained
 * (pre-debit notifications, mandate caps), so AX10M CO-DRIVES: it can charge a recurring
 * token but must coordinate with Razorpay's subscription/mandate engine and RBI timing.
 * BaseAdapter's co-drive `attemptCharge` therefore throws a TODO(ax10m), not the advisory error.
 *
 * SKELETON: the capability matrix below is real, but the live integration is TODO(ax10m):
 *   - authentication (key id + key secret, basic auth)          — to-confirm
 *   - production base URL + API version                         — to-confirm
 *   - recurring-charge/token field contract + decline (error) map — to-confirm
 *   - webhook HMAC-SHA256 (X-Razorpay-Signature) verification wiring — to-confirm
 * Per the no-fabrication rule, field-level request/response shapes are NOT invented here.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface RazorpayAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** Razorpay key id — to-confirm. */
  keyId?: string;
  /** Razorpay key secret — to-confirm. */
  keySecret?: string;
  /** API base URL — to-confirm. */
  baseUrl?: string;
  /** Webhook signature secret (HMAC-SHA256) — to-confirm. */
  webhookSecret?: string;
}

export class RazorpayAdapter extends BaseAdapter {
  readonly id = 'razorpay';
  constructor(private readonly config: RazorpayAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive', // recurring charges gated by RBI mandate + Razorpay engine
      externalRetryControl: true, // can trigger a recurring charge on a token, within mandate rules
      accountUpdater: false, // not exposed to the API
      networkTokens: true, // RBI-compliant tokenization / network tokens supported
      partialCapture: false, // conservative default until verified
      pauseNativeDunning: false, // Razorpay subscription retries not exposed as an AX10M pause
      webhooks: true, // webhooks documented (X-Razorpay-Signature)
      listPaymentMethods: false, // customer method enumeration not assumed — CONFIRM
    };
  }
}
