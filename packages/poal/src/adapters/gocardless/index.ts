/**
 * GoCardless adapter — full CO-DRIVE implementation (bank debit). See ./adapter.ts.
 * The client transport is internal (imported by the adapter and its tests) and not
 * re-exported, to avoid FetchLike name collisions across adapters.
 */
export * from './adapter.js';
export * from './cause-map.js';
