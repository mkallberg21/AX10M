/**
 * @lift/onboarding — shadow-first onboarding.
 *
 * The distribution moat: prove the money before the merchant pays a cent. A
 * lifecycle state machine (connect → shadow → active) plus a shadow-mode
 * projection engine that estimates the incremental uplift Lift would add from
 * baseline-only observation — clearly labeled as a projection, not the
 * holdout-verified bill. See ARCHITECTURE.md §6.
 */
export * from './projection.js';
export * from './lifecycle.js';
