/**
 * @ax10m/attribution — the crown jewel.
 *
 * Deterministic stratified holdout assignment, lower-bound uplift computation,
 * an append-only hash-chained ledger, and the monthly Uplift Statement. This is
 * what lets AX10M bill honestly and prove its lift. See ARCHITECTURE.md §3.
 */
export * from './holdout.js';
export * from './uplift.js';
export * from './sequential.js';
export * from './ledger.js';
export * from './statement.js';
export * from './reconciliation.js';
