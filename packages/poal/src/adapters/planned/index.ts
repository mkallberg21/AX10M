/**
 * Planned-processor adapters (skeletons) — barrel.
 *
 * These 13 processors all expose real, documented APIs; each file here is an HONEST
 * SKELETON — the capability matrix is real, but the field-level API wiring (auth,
 * base URL, charge/token, webhook signature, decline map) is TODO(ax10m) pending the
 * spec, per each adapter's header note. Modes span drive / co-drive / advisory and
 * MUST match each processor's PROCESSOR_REGISTRY entry.
 *
 * Not added to the factory (packages/poal/src/factory.ts): none are webhook-signature-
 * verified yet, matching the TSYS/Elavon/skeleton convention (factory = verified,
 * webhook-capable, implemented adapters only).
 */

export { CybersourceAdapter, type CybersourceAdapterConfig } from './cybersource.js';
export { AuthorizeNetAdapter, type AuthorizeNetAdapterConfig } from './authorizenet.js';
export { FiservAdapter, type FiservAdapterConfig } from './fiserv.js';
export { GlobalPaymentsAdapter, type GlobalPaymentsAdapterConfig } from './globalpayments.js';
export { SquareAdapter, type SquareAdapterConfig } from './square.js';
export { MollieAdapter, type MollieAdapterConfig } from './mollie.js';
export { NuveiAdapter, type NuveiAdapterConfig } from './nuvei.js';
export { RazorpayAdapter, type RazorpayAdapterConfig } from './razorpay.js';
export { PayUAdapter, type PayUAdapterConfig } from './payu.js';
export { StripeBillingAdapter, type StripeBillingAdapterConfig } from './stripe-billing.js';
export { VindiciaAdapter, type VindiciaAdapterConfig } from './vindicia.js';
export { AppleIapAdapter, type AppleIapAdapterConfig } from './apple-iap.js';
export { GooglePlayAdapter, type GooglePlayAdapterConfig } from './google-play.js';
