/**
 * The cost/compliance-aware objective — the number a merchant actually cares about.
 *
 * Recovery RATE (the Phase-1 metric) rewards blanket persistence: "retry everything, for
 * longer" recovers more, and the metric ignores what those attempts cost. This module
 * scores NET VALUE:
 *
 *   net = recovered$  −  (attempts × per-attempt cost)  −  compliance fines
 *
 * where a compliance fine is incurred for retrying a **do-not-retry** decline (a
 * hard-family or fraud code — NOT expired, whose Account-Updater retry is legitimate),
 * and for attempts beyond an excessive-retry threshold. This is where the engine's
 * selectivity (suppress dead credentials, cap attempts) is *supposed* to pay off.
 *
 * HONESTY: every parameter below is a ranged ASSUMPTION, not a verified figure —
 * per-attempt processing cost is grounded (~$0.10–0.30 gateway/auth); network
 * excessive-retry / integrity fines are real programs but their exact assessments are
 * not public. So the answer is reported as a SENSITIVITY (the threshold where it flips),
 * never a single favorable number — and I authored both the world and this cost model.
 */

import { DeclineFamily, familyOf, DeclineCode } from '@ax10m/canonical';
import type { InvoiceOutcome } from './sim/simulate.js';

export interface CostModel {
  /** Processing cost per charge attempt, minor units. GROUNDED ~$0.10–0.30; ASSUMPTION exact. */
  perAttemptMinor: number;
  /** Fine per retry on a do-not-retry (hard/fraud) decline, minor units. ASSUMPTION. */
  finePerViolationMinor: number;
  /** Attempts beyond this (per invoice) accrue an excessive-retry fine. ASSUMPTION. */
  excessiveRetryThreshold: number;
  /** Fine per attempt beyond the threshold, minor units. ASSUMPTION. */
  finePerExcessAttemptMinor: number;
}

/** A deliberately MODERATE default; the sweep is what matters. */
export const DEFAULT_COST_MODEL: CostModel = {
  perAttemptMinor: 20, // $0.20 / attempt
  finePerViolationMinor: 100, // $1.00 per do-not-retry retry
  excessiveRetryThreshold: 6, // network excessive-retry guidance ~ per-window cap
  finePerExcessAttemptMinor: 200, // $2.00 per attempt beyond the threshold
};

/** A do-not-retry decline: retrying it is the compliance violation (not expired/soft). */
function isViolationToRetry(code: DeclineCode): boolean {
  return familyOf(code) === DeclineFamily.Hard || code === DeclineCode.Fraudulent;
}

export interface NetValue {
  n: number;
  recoveredMinor: number;
  attempts: number;
  costMinor: number;
  fineMinor: number;
  netMinor: number;
  /** Net value per invoice (dollars) — comparable across arms of different sizes. */
  netPerInvoice: number;
  recoveredPerInvoice: number;
  attemptsPerInvoice: number;
}

export function netValue(outcomes: readonly InvoiceOutcome[], cost: CostModel = DEFAULT_COST_MODEL): NetValue {
  let recovered = 0;
  let attempts = 0;
  let costMinor = 0;
  let fineMinor = 0;
  for (const o of outcomes) {
    recovered += o.recoveredMinor;
    const r = o.retriesMade;
    attempts += r;
    costMinor += r * cost.perAttemptMinor;
    if (isViolationToRetry(o.invoice.declineCode)) fineMinor += r * cost.finePerViolationMinor;
    if (r > cost.excessiveRetryThreshold) fineMinor += (r - cost.excessiveRetryThreshold) * cost.finePerExcessAttemptMinor;
  }
  const netMinor = recovered - costMinor - fineMinor;
  const n = outcomes.length || 1;
  return {
    n: outcomes.length,
    recoveredMinor: recovered,
    attempts,
    costMinor,
    fineMinor,
    netMinor,
    netPerInvoice: netMinor / n / 100,
    recoveredPerInvoice: recovered / n / 100,
    attemptsPerInvoice: attempts / n,
  };
}
