/**
 * Checkout.com adapter — full DRIVE implementation. See ./adapter.ts.
 * (The client transport is an internal detail — imported directly by the adapter
 * and its tests, not re-exported, to avoid FetchLike name collisions across adapters.)
 *
 * Exports the CheckoutAdapter class, its CheckoutAdapterConfig, the decline-map fn
 * (mapCheckoutResponseCode), and the webhook signature helpers
 * (computeCheckoutSignature / verifyCheckoutSignature) — all re-exported via
 * ./adapter.js and ./decline-map.js.
 */
export * from './adapter.js';
export * from './decline-map.js';
