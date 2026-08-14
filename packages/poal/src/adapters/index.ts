/**
 * Processor adapters beyond Stripe — spanning every integration mode
 * (drive / co-drive / advisory) so Lift is genuinely processor-agnostic.
 * See PROCESSORS.md for the full capability matrix and rollout order.
 */
export * from './base.js';
export * from './registry.js';
export * from './adyen/index.js';
export * from './braintree/index.js';
export * from './chargebee/index.js';
export * from './gocardless/index.js';
export * from './paddle.js';
