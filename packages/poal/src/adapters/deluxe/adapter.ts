/**
 * Deluxe Merchant Services adapter (skeleton) — DRIVE (card gateway).
 *
 * Deluxe Merchant Services exposes a real, drive-capable REST API — "Deluxe Connect" /
 * the Merchant Services API (a.k.a. the Deluxe Payments Platform, "iATS Payments by Deluxe").
 * Confirmed documented endpoint surface (developer.deluxe.com):
 *   - Payments            — create/process a payment (the re-charge on a failed invoice)
 *   - Payment Methods     — tokenize / store a payment method (recover on a stored token, no PAN)
 *   - Payment Links       — hosted payment links
 *   - Reports             — settlement / transaction reporting (reconciliation truth source)
 *   - Merchant Digital Onboarding
 *   - a Standard Error Response Format, and Webhook Notifications
 * So AX10M can DRIVE recovery here (re-attempt a charge on a stored token), which is why the
 * capability matrix below is `drive` and `attemptCharge` (via BaseAdapter) throws a TODO — not
 * the advisory error.
 *
 * SKELETON — capability matrix is real; the LIVE integration is TODO(ax10m):
 *   - authentication (OAuth2 client-credentials vs. an access-token header) — to-confirm
 *   - production/sandbox base URL(s)                                        — to-confirm
 *   - create-payment request/response field contract + decline-code map    — to-confirm
 *   - webhook signature verification scheme                                — to-confirm
 * The field-level contract must be established from the Deluxe Connect API reference
 * (developer.deluxe.com) or its OpenAPI (MuleSoft Anypoint Exchange — deluxecorp portal).
 * That reference is a JS-rendered portal that was NOT reachable during this build, so — per the
 * project's no-fabrication rule — the request/response shapes are intentionally NOT invented here.
 * Filling them in is mechanical once the spec is in hand (mirror the Checkout.com / Worldpay
 * drive adapters: injectable `fetch`, token charge, signed-webhook `ingestWebhook`, decline map).
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface DeluxeAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** Deluxe Connect access token OR OAuth2 client-credentials — exact scheme to-confirm. */
  accessToken?: string;
  clientId?: string; // to-confirm (if OAuth2 client-credentials)
  clientSecret?: string; // to-confirm
  /** Deluxe merchant / account identifier — to-confirm. */
  merchantAccount?: string;
  /** API base URL (prod/sandbox host) — to-confirm. */
  baseUrl?: string;
  /** Webhook signature secret — scheme + header name to-confirm. */
  webhookSecret?: string;
}

export class DeluxeAdapter extends BaseAdapter {
  readonly id = 'deluxe';
  constructor(private readonly config: DeluxeAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive', // Deluxe Connect Payments API lets AX10M initiate the re-charge
      externalRetryControl: true, // we drive the charge attempt (Payments API) — CONFIRM scopes
      accountUpdater: false, // CONFIRM — not verified that Deluxe exposes Account Updater to the API
      networkTokens: false, // CONFIRM — network-token support to the API not verified
      partialCapture: false, // CONFIRM — conservative default until verified
      pauseNativeDunning: false, // a gateway has no merchant dunning to pause
      webhooks: true, // Deluxe Connect documents webhook notifications — CONFIRM signing scheme
      listPaymentMethods: true, // a Payment Methods API exists (stored tokens) — CONFIRM enumeration
    };
  }
}
