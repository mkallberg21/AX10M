/**
 * Processor adapters beyond Stripe — spanning every integration mode
 * (drive / co-drive / advisory) so Lift is genuinely processor-agnostic.
 * See PROCESSORS.md for the full capability matrix and rollout order.
 */
export * from './base.js';
export * from './registry.js';
export * from './adyen.js';
export * from './braintree.js';
export * from './chargebee.js';
export * from './gocardless.js';
export * from './paddle.js';
