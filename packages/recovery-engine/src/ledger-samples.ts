/**
 * Turn the attribution ledger into a training corpus.
 *
 * This is the REAL retraining pipeline (the synthetic generator in `simulate.ts` is
 * only the bootstrap). Every recovery decision logs a `recovery.planned` entry whose
 * detail carries the exact `features` snapshot; the realized outcome is a later
 * `case.recovered` (label 1) or a terminal `charge.failed` with no recovery (label 0).
 * Joining them by invoice id yields `{features, recovered}` — feed straight into
 * `trainLogisticRecoverability`.
 *
 * Kept dependency-free of @ax10m/attribution: we accept a minimal structural shape so
 * the engine never imports the ledger implementation.
 */

import type { RecoveryFeatures } from './recoverability.js';
import type { TrainingSample } from './training.js';

/** The minimal ledger-entry shape this reader needs. */
export interface LedgerEntryLike {
  type: string;
  detail: Record<string, unknown>;
}

/** Options controlling how outcomes are joined. */
export interface LedgerSampleOptions {
  /**
   * Weight each sample by its invoice amount (in dollars) so training optimizes
   * recovered dollars, not recovered count. Defaults to true.
   */
  weightByAmount?: boolean;
}

/**
 * Extract labeled samples from a ledger event stream. An invoice contributes a sample
 * only once we have BOTH its feature snapshot and a realized outcome (a recovery, or a
 * failed charge that never recovered). Invoices still in flight are skipped — no label.
 */
export function samplesFromLedger(
  entries: readonly LedgerEntryLike[],
  options: LedgerSampleOptions = {},
): TrainingSample[] {
  const weightByAmount = options.weightByAmount ?? true;

  const features = new Map<string, RecoveryFeatures>();
  const amountMinor = new Map<string, number>();
  const recovered = new Set<string>();
  const failed = new Set<string>();

  for (const e of entries) {
    const id = typeof e.detail.invoiceId === 'string' ? e.detail.invoiceId : undefined;
    if (!id) continue;

    switch (e.type) {
      case 'recovery.planned': {
        const f = e.detail.features;
        if (f && typeof f === 'object') features.set(id, f as RecoveryFeatures);
        break;
      }
      case 'case.recovered':
        recovered.add(id);
        if (typeof e.detail.amount === 'number') amountMinor.set(id, e.detail.amount);
        break;
      case 'charge.failed':
        failed.add(id);
        break;
      default:
        break;
    }
  }

  const samples: TrainingSample[] = [];
  for (const [id, f] of features) {
    const didRecover = recovered.has(id);
    // Label is defined only if the case reached a terminal state.
    if (!didRecover && !failed.has(id)) continue;
    const amt = amountMinor.get(id) ?? f.amountMinor;
    samples.push({
      features: f,
      recovered: didRecover,
      weight: weightByAmount ? Math.max(1, amt / 100) : 1,
    });
  }
  return samples;
}
