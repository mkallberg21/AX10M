/**
 * Google Play (In-App Billing) adapter (skeleton) — ADVISORY (app store).
 *
 * NOTE: Google exposes real, documented server APIs: Real-time Developer Notifications
 * (RTDN, delivered via Google Cloud Pub/Sub) for subscription lifecycle events
 * (SUBSCRIPTION_IN_GRACE_PERIOD, SUBSCRIPTION_ON_HOLD / account hold, SUBSCRIPTION_RECOVERED,
 * SUBSCRIPTION_EXPIRED, etc.) and the Google Play Developer API (purchases.subscriptionsv2)
 * to query subscription status. Google OWNS the payment relationship, the token, and the
 * account-hold / grace-period retry loop — there is no third-party charge API. AX10M is
 * therefore ADVISORY: it ingests RTDN purely for MEASUREMENT (involuntary churn, recovery
 * attribution on the comms AX10M controls) and can recommend out-of-band prompts (deep-link
 * to fix payment), but CANNOT drive a charge. BaseAdapter's advisory `attemptCharge` /
 * `pauseNativeDunning` throw the advisory error by design; `ingestWebhook` (measurement) works.
 *
 * SKELETON: the capability matrix below is real; live measurement wiring is TODO(ax10m):
 *   - service-account auth for the Play Developer API (OAuth2 JWT)   — to-confirm
 *   - Pub/Sub push endpoint auth + message envelope handling         — to-confirm
 *   - RTDN notification-type → canonical failure/recovery event map   — to-confirm
 * Per the no-fabrication rule, field-level payload shapes are NOT invented here.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface GooglePlayAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** Service-account credentials (Play Developer API) — to-confirm. */
  serviceAccountJson?: string;
  /** Android package name of the app — to-confirm. */
  packageName?: string;
  /** Pub/Sub topic / subscription for RTDN — to-confirm. */
  pubsubTopic?: string;
  /** API base URL — to-confirm. */
  baseUrl?: string;
  /** RTDN arrives via Pub/Sub push (OIDC-token verified), not a shared secret — to-confirm. */
  webhookSecret?: string;
}

export class GooglePlayAdapter extends BaseAdapter {
  readonly id = 'google-play';
  constructor(private readonly config: GooglePlayAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'advisory', // Google owns the token + account-hold retry loop
      externalRetryControl: false, // no third-party charge API
      accountUpdater: false, // owned by Google, not exposed
      networkTokens: false, // owned by Google, not exposed
      partialCapture: false,
      pauseNativeDunning: false, // cannot pause Google's account-hold / grace period
      webhooks: true, // Real-time Developer Notifications (RTDN) — measurement only
      listPaymentMethods: false,
    };
  }
}
