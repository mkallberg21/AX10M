/**
 * @ax10m/poal — Payment Orchestration Abstraction Layer.
 *
 * The narrow `ProcessorAdapter` contract + capability matrix that make AX10M
 * processor-agnostic, plus deterministic idempotency-key generation and the
 * Stripe adapter (first processor). See ARCHITECTURE.md §4.1 & §8.
 */
export * from './adapter.js';
export * from './idempotency.js';
export * from './adapters/index.js';
export * from './factory.js';
export * as stripe from './stripe/index.js';
