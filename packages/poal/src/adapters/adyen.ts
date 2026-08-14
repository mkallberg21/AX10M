/**
 * Adyen adapter (skeleton) — DRIVE.
 *
 * Cleanest card drive target: no competing merchant-facing dunning engine.
 * Ingress on the AUTHORISATION webhook (`success:false`, read `reason`); retry via
 * `/payments` with `storedPaymentMethodId` + `shopperReference`. Network tokens +
 * Account Updater native; strong settlement-details reporting for reconciliation.
 * We only ever hold Adyen tokens — never a PAN (SAQ-A).  PROCESSORS.md §3.
 */

import type { CapabilityMatrix } from '../adapter.js';
import { BaseAdapter } from './base.js';

export interface AdyenAdapterConfig {
  apiKey: string;
  merchantAccount: string;
  hmacKey: string; // for webhook HMAC verification
}

export class AdyenAdapter extends BaseAdapter {
  readonly id = 'adyen';
  constructor(private readonly config: AdyenAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'drive',
      externalRetryControl: true,
      accountUpdater: true,
      networkTokens: true,
      partialCapture: true,
      pauseNativeDunning: false, // Adyen has no merchant dunning to pause
      webhooks: true,
      listPaymentMethods: true,
    };
  }
}
