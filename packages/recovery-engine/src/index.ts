/**
 * @ax10m/recovery-engine — the recovery brain (the actual product surface).
 *
 * Decides, per failed invoice, WHETHER to retry, WHEN, WITH WHICH credential, or
 * whether to route to card-update comms instead — and computes the expected-value
 * reward a learned policy optimizes. The engine PROPOSES; @ax10m/guardrail DISPOSES.
 *
 * This is a grounded COLD-START baseline: correct structure and interfaces, sane
 * defaults, full explainability. The winning edge — beating Stripe Smart Retries —
 * comes from replacing HeuristicPolicy/HeuristicRecoverability with a policy trained
 * on the outcome data the attribution ledger captures. The value AX10M is priced on
 * is the *measured incremental lift* of this engine over the baseline, not the
 * scorer itself. See ARCHITECTURE.md §5 and STRATEGY.md.
 */
export * from './recoverability.js';
export * from './timing.js';
export * from './objective.js';
export * from './policy.js';
export * from './contextual-bandit.js';
// Decline-Code Intelligence + Autonomous Retry Sequencing (ARSE).
export * from './decline-intel.js';
export * from './retry-strategy.js';
export * from './sequence.js';
export * from './intelligence.js';
// Learning: feature encoding, the trained logistic model, the trainer, the online
// bandit, the real ledger→corpus pipeline, and the shipped bootstrap prior.
export * from './features.js';
export * from './logistic.js';
export * from './training.js';
export * from './simulate.js';
export * from './feature-store.js';
export * from './ledger-samples.js';
export * from './credential-recovery.js';
export * from './bin-csv.js';
export * from './retrain.js';
export * from './bandit.js';
export * from './bootstrap-weights.js';
export { trainBootstrap, type BootstrapResult } from './train-cli.js';
