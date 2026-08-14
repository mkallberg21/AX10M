/**
 * Braintree adapter — full DRIVE implementation (classic gateway XML + signed
 * webhooks). See ./adapter.ts. The client transport is internal (imported by the
 * adapter and its tests) and not re-exported, to avoid FetchLike name collisions.
 */
export * from './adapter.js';
export * from './response-map.js';
