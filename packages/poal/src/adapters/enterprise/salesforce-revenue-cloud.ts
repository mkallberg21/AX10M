/**
 * Salesforce Revenue Cloud Billing adapter (skeleton) — CO-DRIVE (billing platform).
 *
 * NOTE: Salesforce Revenue Cloud Billing (the billing/collections layer of Revenue
 * Cloud, successor to Salesforce CPQ & Billing) is an enterprise billing platform: it
 * owns the invoice and the dunning loop and collects through an underlying payment
 * gateway (publicly known to integrate gateways such as Stripe / CyberSource /
 * Payeezy / Adyen underneath via Salesforce Payments and gateway connectors). Because
 * Revenue Cloud exposes billing APIs (REST / Apex), AX10M can CO-DRIVE recovery —
 * collect on a stored token and pause native dunning once wired — so BaseAdapter's
 * co-drive `attemptCharge` throws a TODO (not the advisory error).
 *
 * SKELETON: the capability matrix below is real, but the live integration
 * (collect-payment on a stored token via the Salesforce REST/Apex API, Platform-Event
 * verification, reconciliation poll) is TODO(ax10m) — the exact endpoint/field/version
 * contract must be established with Salesforce.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface SalesforceRevenueCloudAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  clientId: string; // Connected-App OAuth2 client id — to-confirm
  clientSecret: string; // Connected-App OAuth2 client secret — to-confirm
  instanceUrl: string; // Salesforce org instance URL — to-confirm
  webhookSecret?: string; // Platform Event / webhook signature secret — to-confirm
}

export class SalesforceRevenueCloudAdapter extends BaseAdapter {
  readonly id = 'salesforce-revenue-cloud';
  constructor(private readonly config: SalesforceRevenueCloudAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive',
      externalRetryControl: true, // billing API can drive collection on our schedule
      accountUpdater: true, // Salesforce Payments / gateway connectors support account-updater
      networkTokens: false, // not exposed to AX10M
      partialCapture: true, // platform owns the invoice → partial amounts supported
      pauseNativeDunning: true, // it owns dunning, so it can be paused
      webhooks: true,
      listPaymentMethods: true, // stored payment methods exposed via billing API
    };
  }
}
