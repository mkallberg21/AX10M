/**
 * PayPal adapter — DRIVE-mode barrel.
 *
 * Exports the adapter + its config (from ./adapter.js), the canonical decline
 * mapper (from ./decline-map.js), and the fail-closed webhook verify helper +
 * client types (from ./client.js). See ./adapter.ts for the strategic posture
 * (drive the card-on-file / reference-transaction path; measure PayPal's own
 * auto-retries).
 */
export * from './adapter.js';
export * from './decline-map.js';
export { verifyPaypalWebhookSignature, PayPalError, type WebhookVerifyInput } from './client.js';
