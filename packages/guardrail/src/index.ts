/**
 * @lift/guardrail — the compliance guardrail engine.
 *
 * A hard-constraint layer that takes a proposed action and returns allow /
 * suppress + reason. Constraints always override the learned policy, making
 * card-network over-retry fines structurally impossible. See ARCHITECTURE.md §4.2.
 */
export * from './types.js';
export * from './guardrail.js';
