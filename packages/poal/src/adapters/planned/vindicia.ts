/**
 * Vindicia adapter (skeleton) — ADVISORY (subscription retention / billing platform).
 *
 * NOTE: Vindicia (Amdocs) exposes real, documented APIs (Vindicia Subscribe / Vindicia
 * Retain / VDC). Vindicia Retain IS a failed-payment recovery product that owns the retry
 * loop and the payment relationship — it competes head-on with AX10M. Absent a partner
 * contract that hands AX10M the charge trigger, AX10M treats Vindicia as ADVISORY: it
 * ingests failure/recovery notifications to MEASURE involuntary churn and win on attribution,
 * and recommends out-of-band action, but does NOT drive the charge. BaseAdapter's advisory
 * `attemptCharge` / `pauseNativeDunning` therefore throw the advisory error by design;
 * `ingestWebhook` (measurement) still works.
 *
 * SKELETON: the capability matrix below is real; live measurement wiring is TODO(ax10m):
 *   - authentication (SOAP/REST credentials, auth token) — to-confirm
 *   - base URL(s) (Subscribe vs. Retain vs. VDC)         — to-confirm
 *   - notification/webhook verification scheme           — to-confirm
 * Per the no-fabrication rule, field-level request/response shapes are NOT invented here.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface VindiciaAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** Vindicia API credentials (login/auth token) — to-confirm. */
  apiKey?: string;
  /** API base URL (Subscribe / Retain / VDC) — to-confirm. */
  baseUrl?: string;
  /** Notification/webhook verification secret — to-confirm. */
  webhookSecret?: string;
}

export class VindiciaAdapter extends BaseAdapter {
  readonly id = 'vindicia';
  constructor(private readonly config: VindiciaAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'advisory', // Vindicia Retain owns the retry loop (a competitor)
      externalRetryControl: false, // AX10M does not drive the charge in advisory posture
      accountUpdater: false, // owned by Vindicia, not exposed
      networkTokens: false, // owned by Vindicia, not exposed
      partialCapture: false,
      pauseNativeDunning: false, // cannot disable Vindicia Retain
      webhooks: true, // notifications documented — measurement only
      listPaymentMethods: false,
    };
  }
}
