/**
 * Shopify adapter — CO-DRIVE implementation (Shopify Subscriptions). See ./adapter.ts.
 * The client transport is internal (imported by the adapter and its tests) and not
 * re-exported, to avoid FetchLike name collisions across adapters.
 */
export * from './adapter.js';
export * from './decline-map.js';
