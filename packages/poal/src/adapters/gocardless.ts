/**
 * GoCardless adapter (skeleton) — CO-DRIVE (bank debit: ACH/SEPA/BACS/…).
 *
 * The credential is a **mandate**, not a card — no PAN, no Account Updater, no
 * network tokens (near-zero card PCI scope). Retry via
 * `POST /payments/:id/actions/retry` (mandate must be active). Rich webhooks
 * including the bank-debit-specific `late_failure_settled` (post-payout clawback)
 * that attribution must handle.
 *
 * DEconfliction guardrail: on a `failed` webhook, honor the `will_attempt_retry`
 * flag — never fire our own retry against a payment GoCardless's Success+ (NSF-
 * only) engine is already retrying, or we double-collect. PROCESSORS.md §3.
 */

import type { CapabilityMatrix } from '../adapter.js';
import { BaseAdapter } from './base.js';

export interface GoCardlessAdapterConfig {
  accessToken: string;
  webhookSecret: string;
  /** Leave Success+ on (co-drive NSF failures) or take full control (drive). */
  disableSuccessPlus?: boolean;
}

export class GoCardlessAdapter extends BaseAdapter {
  readonly id = 'gocardless';
  constructor(private readonly config: GoCardlessAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      // Full drive when Success+ is disabled; otherwise co-drive alongside it.
      integrationMode: this.config.disableSuccessPlus ? 'drive' : 'co-drive',
      externalRetryControl: true,
      accountUpdater: false, // N/A for bank debit
      networkTokens: false, // N/A for bank debit
      partialCapture: false, // model a partial as a new, smaller payment on the mandate
      pauseNativeDunning: true, // via retry_if_possible=false
      webhooks: true,
      listPaymentMethods: true, // mandates
    };
  }
}
