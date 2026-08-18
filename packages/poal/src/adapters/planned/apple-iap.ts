/**
 * Apple App Store (In-App Purchase) adapter (skeleton) — ADVISORY (app store).
 *
 * NOTE: Apple exposes real, documented server APIs (App Store Server API + App Store Server
 * Notifications V2, developer.apple.com): signed JWS notifications for subscription events
 * (DID_RENEW, DID_FAIL_TO_RENEW / billing retry, GRACE_PERIOD_EXPIRED, EXPIRED, etc.) and
 * the Server API to query subscription/transaction status. Apple OWNS the payment
 * relationship, the token, and the billing-retry / Billing Grace Period loop — there is no
 * third-party charge API. AX10M is therefore ADVISORY: it ingests App Store Server
 * Notifications purely for MEASUREMENT (involuntary churn, recovery attribution on the comms
 * AX10M controls) and can recommend out-of-band prompts (deep-link the user to manage/fix
 * billing), but CANNOT drive a charge. BaseAdapter's advisory `attemptCharge` /
 * `pauseNativeDunning` throw the advisory error by design; `ingestWebhook` (measurement) works.
 *
 * SKELETON: the capability matrix below is real; live measurement wiring is TODO(ax10m):
 *   - App Store Server API auth (ES256 JWT from an App Store Connect key)      — to-confirm
 *   - production/sandbox base URL(s)                                           — to-confirm
 *   - JWS (x5c chain) signature verification of Server Notifications V2         — to-confirm
 *   - notification-type → canonical failure/recovery event mapping            — to-confirm
 * Per the no-fabrication rule, field-level payload shapes are NOT invented here.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface AppleIapAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** App Store Connect API key id — to-confirm. */
  keyId?: string;
  /** App Store Connect issuer id — to-confirm. */
  issuerId?: string;
  /** ES256 private key (App Store Connect) — to-confirm. */
  privateKey?: string;
  /** Bundle id of the app — to-confirm. */
  bundleId?: string;
  /** API base URL (prod/sandbox host) — to-confirm. */
  baseUrl?: string;
  /** Notifications are JWS-signed by Apple (x5c chain), not a shared secret — to-confirm. */
  webhookSecret?: string;
}

export class AppleIapAdapter extends BaseAdapter {
  readonly id = 'apple-iap';
  constructor(private readonly config: AppleIapAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'advisory', // Apple owns the token + billing-retry loop
      externalRetryControl: false, // no third-party charge API
      accountUpdater: false, // owned by Apple, not exposed
      networkTokens: false, // owned by Apple, not exposed
      partialCapture: false,
      pauseNativeDunning: false, // cannot pause Apple's billing retry / grace period
      webhooks: true, // App Store Server Notifications V2 — measurement only
      listPaymentMethods: false,
    };
  }
}
