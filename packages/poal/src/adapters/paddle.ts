/**
 * Paddle adapter (skeleton) — ADVISORY (Merchant of Record).
 *
 * Paddle owns the payment relationship, the token, and the dunning engine (Paddle
 * Retain). There is no third-party retry API — AX10M CANNOT drive a charge here.
 * We integrate as a measurement + advisory layer: ingest `transaction.payment_failed`
 * / `subscription.past_due` to run the holdout on the *comms* we control and to
 * quantify involuntary churn, and recommend/prompt out-of-band (e.g. email the
 * customer to update their method in Paddle's portal). `attemptCharge` and
 * `pauseNativeDunning` intentionally throw (see BaseAdapter). PROCESSORS.md §3.
 *
 * Strategic note: Paddle Retain competes head-on with AX10M; this adapter exists so
 * AX10M can still *measure* recovery on Paddle accounts and win on attribution.
 */

import type { CapabilityMatrix } from '../adapter.js';
import { BaseAdapter } from './base.js';

export interface PaddleAdapterConfig {
  apiKey: string;
  webhookSecret: string; // Paddle-Signature verification
}

export class PaddleAdapter extends BaseAdapter {
  readonly id = 'paddle';
  constructor(private readonly config: PaddleAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'advisory',
      externalRetryControl: false, // MoR owns the token & retry loop
      accountUpdater: false, // owned by Paddle, not exposed
      networkTokens: false, // owned by Paddle, not exposed
      partialCapture: false,
      pauseNativeDunning: false, // cannot disable Paddle Retain
      webhooks: true, // measurement only
      listPaymentMethods: false,
    };
  }
}
