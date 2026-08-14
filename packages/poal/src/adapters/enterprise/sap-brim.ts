/**
 * SAP (BRIM / Subscription Billing) adapter (skeleton) — CO-DRIVE (billing platform).
 *
 * NOTE: SAP BRIM (Billing and Revenue Innovation Management), including SAP
 * Subscription Billing and Convergent Invoicing / FI-CA, is an enterprise billing
 * platform: it owns the invoice and the dunning/collections loop and collects through
 * an underlying payment gateway (publicly known to integrate gateways such as
 * CyberSource / Stripe / Adyen underneath via SAP's payment-processing integration).
 * Because BRIM exposes billing APIs (OData / SOAP), AX10M can CO-DRIVE recovery —
 * collect on a stored token and pause native dunning once wired — so BaseAdapter's
 * co-drive `attemptCharge` throws a TODO (not the advisory error).
 *
 * SKELETON: the capability matrix below is real, but the live integration
 * (collect-payment on a stored token via SAP's OData/SOAP API, event verification,
 * reconciliation poll) is TODO(ax10m) — the exact endpoint/field/version contract must
 * be established with SAP.
 */

import type { CapabilityMatrix } from '../../adapter.js';
import { BaseAdapter } from '../base.js';

export interface SapBrimAdapterConfig {
  /** AX10M-internal merchant id stamped on canonical events. */
  merchantId: string;
  clientId: string; // OAuth2 / BTP client credentials — to-confirm
  clientSecret: string; // OAuth2 / BTP client credentials — to-confirm
  baseUrl: string; // Subscription Billing / OData service host — to-confirm
  webhookSecret?: string; // event-notification signature secret — to-confirm
}

export class SapBrimAdapter extends BaseAdapter {
  readonly id = 'sap-brim';
  constructor(private readonly config: SapBrimAdapterConfig) {
    super();
  }

  capabilities(): CapabilityMatrix {
    return {
      integrationMode: 'co-drive',
      externalRetryControl: true, // billing API can drive collection on our schedule
      accountUpdater: false, // card-updater support depends on the paired gateway — conservative
      networkTokens: false, // not exposed to AX10M
      partialCapture: true, // platform owns the invoice → partial amounts supported
      pauseNativeDunning: true, // it owns dunning/collections, so it can be paused
      webhooks: true,
      listPaymentMethods: true, // stored payment methods exposed via billing API
    };
  }
}
