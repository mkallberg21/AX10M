/**
 * Braintree (PayPal) adapter (skeleton) — DRIVE (co-drive on Braintree Subscriptions).
 *
 * Retry via `Transaction.sale` against the vault `payment_method_token`. Network
 * tokens auto-provisioned; the `ACCOUNT_UPDATER_DAILY_REPORT` webhook surfaces
 * refreshed cards. If the merchant uses Braintree Subscriptions, its engine
 * triggers Account Updater on the 2nd decline — co-drive to avoid double-retry.
 * PROCESSORS.md §3.
 */

import type { CapabilityMatrix } from '../adapter.js';
import { BaseAdapter } from './base.js';

export interface BraintreeAdapterConfig {
  merchantId: string;
  publicKey: string;
  privateKey: string;
  /** Set true when the merchant relies on Braintree-managed Subscriptions. */
  usesBraintreeSubscriptions?: boolean;
}

export class BraintreeAdapter extends BaseAdapter {
  readonly id = 'braintree';
  constructor(private readonly config: BraintreeAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: this.config.usesBraintreeSubscriptions ? 'co-drive' : 'drive',
      externalRetryControl: true,
      accountUpdater: true,
      networkTokens: true,
      partialCapture: true, // submitForPartialSettlement
      pauseNativeDunning: Boolean(this.config.usesBraintreeSubscriptions),
      webhooks: true,
      listPaymentMethods: true,
    };
  }
}
