/**
 * @ax10m/backtest — does the recovery engine beat a faithful Stripe Smart Retries
 * baseline, and by how much, without a live merchant? Feeds a synthetic world model and
 * both policies through the REAL @ax10m/attribution estimator. See docs/BASELINE.md and
 * `out/report.md` (generated).
 */

export * from './rng.js';
export * from './world/sources.js';
export * from './world/world.js';
export * from './policy/policy.js';
export * from './baselines/smart-retries.js';
export * from './policy/engine-policy.js';
export * from './sim/simulate.js';
export * from './estimate.js';
export * from './checks.js';
export * from './report.js';
export * from './demo.js';
export { runBacktest } from './cli.js';
