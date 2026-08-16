/**
 * @ax10m/billing — the merchant opt-in + invoicing domain for AX10M's 12% fee.
 *
 * Pure, testable, no I/O:
 *  - account.ts    the BillingAccount opt-in model + validation (auto-pay vs invoice, no-PAN rule).
 *  - terms.ts      versioned commercial terms + a hash of the exact text accepted.
 *  - acceptance.ts the Ed25519-signed clickwrap acceptance record.
 *  - invoice.ts    the invoice derived from a signed Uplift Statement + finance-charge math.
 *
 * The statement statistics, the Ed25519 signer, and the actual charge/collection live elsewhere
 * (@ax10m/attribution and apps/api) — this package is the contract + billing-account layer.
 */
export * from './account.js';
export * from './terms.js';
export * from './acceptance.js';
export * from './invoice.js';
export * from './invoice-dunning.js';
