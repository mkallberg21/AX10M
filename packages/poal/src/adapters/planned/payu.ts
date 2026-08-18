/**
 * PayU adapter (skeleton) — ADVISORY (regional payment aggregator).
 *
 * NOTE: PayU exposes real, documented APIs (multiple regional stacks — PayU GPO / EMEA /
 * PayU India / PayU LatAm), each with payments, tokenization, and IPN/webhook notifications.
 * However, the merchant-of-record / aggregator posture varies by region and the recurring
 * retry loop is typically owned by PayU's local rails and mandate rules. Absent a specific
 * regional drive contract, AX10M treats PayU as ADVISORY: it ingests failure/renewal
 * notifications for measurement and recommends out-of-band action, but does NOT drive the
 * charge. BaseAdapter's advisory `attemptCharge` / `pauseNativeDunning` therefore throw the
 * advisory error by design; `ingestWebhook` (measurement) still works.
 *
 * SKELETON: the capability matrix below is real; live measurement wiring is TODO(ax10m):
 *   - which regional PayU stack + its auth scheme — to-confirm
 *   - base URL(s) per region                      — to-confirm
 *   - IPN/webhook signature verification scheme   — to-confirm
 * Per the no-fabrication rule, field-level request/response shapes are NOT invented here.
 * (If a drive-capable regional contract is later confirmed, promote this to co-drive/drive.)
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface PayUAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  /** Regional PayU merchant/POS credentials — to-confirm per region. */
  apiKey?: string;
  /** Regional API base URL — to-confirm. */
  baseUrl?: string;
  /** IPN/webhook signature secret — to-confirm. */
  webhookSecret?: string;
}

export class PayUAdapter extends BaseAdapter {
  readonly id = 'payu';
  constructor(private readonly config: PayUAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'advisory', // aggregator/MoR posture varies; retry owned by PayU rails
      externalRetryControl: false, // AX10M does not drive the charge in advisory posture
      accountUpdater: false, // not exposed to AX10M
      networkTokens: false, // not exposed to AX10M
      partialCapture: false,
      pauseNativeDunning: false, // platform-owned retry cannot be paused by AX10M
      webhooks: true, // IPN/webhooks documented — measurement only
      listPaymentMethods: false,
    };
  }
}
