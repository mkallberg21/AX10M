/**
 * Autonomous Retry Sequencing (ARSE) — plan the FULL ordered retry schedule.
 *
 * The policy decides one attempt at a time; this composes the whole sequence up front:
 * for a given failure it walks the network-aware `RetryStrategy` cadence, scoring the
 * recoverability at each future attempt (attempts decay, days accrue), rotating the
 * credential when the strategy says to, and stopping early once the expected
 * recoverability falls below a floor — so a doomed tail is never scheduled. Non-retry
 * declines (dead/expired credential, fraud) return a single terminal step.
 *
 * This is what lets AX10M out-plan a processor's fixed native retry logic: the cadence
 * is decline- and network-specific, the depth is bounded by *predicted* recoverability
 * (trained model by default), and every step still passes the guardrail at execution.
 */

import { LogisticRecoverability } from './logistic.js';
import { BOOTSTRAP_RECOVERABILITY_WEIGHTS } from './bootstrap-weights.js';
import { classifyDecline, type RecommendedAction } from './decline-intel.js';
import { strategyFor, type CardNetwork } from './retry-strategy.js';
import type { AvailableMethod } from './policy.js';
import type { RecoverabilityModel, RecoveryFeatures } from './recoverability.js';

export interface RetryStep {
  attemptNumber: number;
  /** ISO time the attempt is scheduled for. */
  at: string;
  /** 'retry' for a charge step; 'card_update' / 'suppress' for a terminal non-charge step. */
  action: RecommendedAction;
  /** Tokenized method to charge (from rotation), if any. */
  methodRef?: string;
  /** Model P(recover) at this step. */
  expectedRecoverability: number;
  rationale: string;
}

export interface SequenceContext {
  /** Decision-time instant (ISO). */
  now: string;
  /** Tokenized methods available for rotation. */
  methods?: AvailableMethod[];
  network?: CardNetwork;
  /** Stop scheduling once predicted recoverability drops below this (default 0.04). */
  minRecoverabilityToContinue?: number;
  /** Recoverability model (defaults to the trained bootstrap prior). */
  model?: RecoverabilityModel;
}

const DEFAULT_MIN_RECOVERABILITY = 0.04;

/** Plan the ordered retry sequence for a failed invoice. Deterministic given inputs. */
export function planRetrySequence(features: RecoveryFeatures, ctx: SequenceContext): RetryStep[] {
  const model = ctx.model ?? new LogisticRecoverability(BOOTSTRAP_RECOVERABILITY_WEIGHTS);
  const floor = ctx.minRecoverabilityToContinue ?? DEFAULT_MIN_RECOVERABILITY;
  const network = ctx.network ?? 'other';
  const classification = classifyDecline(features.declineCode);

  // Non-retry declines resolve to a single terminal step.
  if (classification.recommendedAction !== 'retry') {
    return [
      {
        attemptNumber: features.attemptNumber,
        at: ctx.now,
        action: classification.recommendedAction,
        expectedRecoverability: model.score(features),
        rationale: classification.description,
      },
    ];
  }

  const strategy = strategyFor(features.declineCode, network);
  const defaultMethod = pickDefault(ctx.methods);
  const alternate = pickAlternate(ctx.methods);

  const steps: RetryStep[] = [];
  let cursor = Date.parse(ctx.now);
  const baseAttempt = features.attemptNumber;

  for (let i = 0; i < strategy.maxAttempts; i++) {
    cursor += strategy.delaysMinutes[i]! * 60_000;
    const attemptNumber = baseAttempt + i;
    const daysSinceFirstFail = features.daysSinceFirstFail + (cursor - Date.parse(ctx.now)) / 86_400_000;

    // Score the recoverability as it will be AT that future attempt (decayed).
    const scored = model.score({ ...features, attemptNumber, daysSinceFirstFail });
    if (scored < floor) break; // don't schedule a doomed tail

    const rotate = strategy.rotateMethodAfterAttempt !== undefined && i >= strategy.rotateMethodAfterAttempt;
    const method = (rotate ? alternate : defaultMethod) ?? defaultMethod;

    steps.push({
      attemptNumber,
      at: new Date(cursor).toISOString(),
      action: 'retry',
      methodRef: method?.ref,
      expectedRecoverability: scored,
      rationale: `Attempt ${i + 1}/${strategy.maxAttempts}: ${strategy.rationale}${rotate ? ' (rotated credential)' : ''}`,
    });
  }

  return steps;
}

function pickDefault(methods: AvailableMethod[] | undefined): AvailableMethod | undefined {
  if (!methods || methods.length === 0) return undefined;
  return methods.find((m) => m.autoUpdated) ?? methods.find((m) => m.isDefault) ?? methods[0];
}

function pickAlternate(methods: AvailableMethod[] | undefined): AvailableMethod | undefined {
  if (!methods || methods.length === 0) return undefined;
  return methods.find((m) => !m.isDefault) ?? methods.find((m) => m.autoUpdated);
}
