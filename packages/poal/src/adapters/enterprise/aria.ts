/**
 * Aria Systems adapter (skeleton) — CO-DRIVE (billing platform).
 *
 * NOTE: Aria Systems is an enterprise recurring-billing / monetization platform: it
 * owns the invoice and the dunning loop and collects through an underlying payment
 * gateway (publicly known to integrate gateways such as CyberSource / Stripe / Adyen
 * underneath). Because Aria exposes a billing API (Core/Object API), AX10M can
 * CO-DRIVE recovery — collect on a stored token and pause native dunning once wired —
 * so BaseAdapter's co-drive `attemptCharge` throws a TODO (not the advisory error).
 *
 * SKELETON: the capability matrix below is real, but the live integration
 * (collect-payment on a stored token via Aria's REST/SOAP API, webhook signature
 * verification, reconciliation poll) is TODO(ax10m) — the exact endpoint/field/version
 * contract must be established with Aria.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface AriaAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  clientNo: string; // Aria client account number — to-confirm
  authKey: string; // Aria API auth key — to-confirm
  baseUrl: string; // Aria API host (prod/staging) — to-confirm
  webhookSecret?: string; // event-notification signature secret — to-confirm
}

export class AriaAdapter extends BaseAdapter {
  readonly id = 'aria';
  constructor(private readonly config: AriaAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive',
      externalRetryControl: true, // billing API can drive collection on our schedule
      accountUpdater: true, // Aria supports automatic account updater via its gateways
      networkTokens: true, // Aria documents network-token support for stored methods
      partialCapture: true, // platform owns the invoice → partial amounts supported
      pauseNativeDunning: true, // it owns dunning, so it can be paused
      webhooks: true,
      listPaymentMethods: true, // stored payment methods exposed via billing API
    };
  }
}
