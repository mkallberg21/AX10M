/**
 * Enterprise billing-platform adapters (skeletons) — barrel.
 *
 * All 13 are co-drive subscription/usage BILLING PLATFORMS that own the invoice and
 * dunning and collect through an underlying gateway. Capability matrices are real;
 * live API integration is TODO(ax10m) per each adapter's header note.
 */

export { AppDirectAdapter, type AppDirectAdapterConfig } from './appdirect.js';
export { AriaAdapter, type AriaAdapterConfig } from './aria.js';
export { BillingPlatformAdapter, type BillingPlatformAdapterConfig } from './billingplatform.js';
export { BluLogixAdapter, type BluLogixAdapterConfig } from './blulogix.js';
export { FrisbiiAdapter, type FrisbiiAdapterConfig } from './frisbii.js';
export { GotransverseAdapter, type GotransverseAdapterConfig } from './gotransverse.js';
export { KeylightAdapter, type KeylightAdapterConfig } from './keylight.js';
export { LogiSenseAdapter, type LogiSenseAdapterConfig } from './logisense.js';
export { OracleBrmAdapter, type OracleBrmAdapterConfig } from './oracle-brm.js';
export { RecVueAdapter, type RecVueAdapterConfig } from './recvue.js';
export { SapBrimAdapter, type SapBrimAdapterConfig } from './sap-brim.js';
export {
  SalesforceRevenueCloudAdapter,
  type SalesforceRevenueCloudAdapterConfig,
} from './salesforce-revenue-cloud.js';
export { OneBillAdapter, type OneBillAdapterConfig } from './onebill.js';
