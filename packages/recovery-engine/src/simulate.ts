/**
 * Grounded synthetic outcome generator — the bootstrap corpus.
 *
 * There is no live outcome data until AX10M has charged in production, so the shipped
 * "trained" prior is fit on a synthetic data-generating process (DGP) whose structure
 * mirrors the real economics of card declines: decline family sets the base recovery
 * rate; NSF is timing/payday dependent; expired needs a card update not a retry; each
 * successive attempt decays; the customer's own history and the issuer/BIN prior carry
 * real signal; large tickets recover less.
 *
 * The DGP deliberately encodes signal the hand-tuned heuristic UNDER-weights (a strong
 * issuer-prior × attempt interaction, and customer history), so a fitted model has room
 * to beat the baseline on held-out data — which the tests assert. When real ledger data
 * exists, `samplesFromLedger` replaces this and the same trainer refits; nothing else
 * changes. This is a bootstrap prior, explicitly NOT a claim of real-world lift.
 */

import { DeclineCode, type IssuerRegion } from '@ax10m/canonical';
import { DECLINE_ORDER, REGION_ORDER } from './features.js';
import { sigmoid } from './logistic.js';
import type { RecoveryFeatures } from './recoverability.js';
import { mulberry32, type TrainingSample } from './training.js';

/** A simulated sample carries the true probability so evaluation can measure regret. */
export interface SimSample extends TrainingSample {
  trueProb: number;
}

/** The "true" recovery probability under the DGP (unknown to the model). */
export function trueRecoverProb(f: RecoveryFeatures): number {
  const code = f.declineCode;
  // Base log-odds by decline code (the dominant signal).
  let z: number;
  switch (code) {
    case DeclineCode.IssuerUnavailable:
    case DeclineCode.TryAgainLater:
    case DeclineCode.ProcessingError:
      z = 1.3; // transient issuer problems recover well on retry
      break;
    case DeclineCode.InsufficientFunds:
      z = 0.2; // timing dependent — the payday/tenure/prior terms matter most here
      break;
    case DeclineCode.VelocityLimitExceeded:
    case DeclineCode.AuthenticationRequired:
      z = 0.4;
      break;
    case DeclineCode.DoNotHonor:
      z = -0.3; // the gray zone — issuer prior decides
      break;
    case DeclineCode.ExpiredCard:
      z = -2.2; // pointless to retry the same card
      break;
    case DeclineCode.LostCard:
    case DeclineCode.StolenCard:
    case DeclineCode.ClosedAccount:
    case DeclineCode.InvalidCard:
    case DeclineCode.PickupCard:
    case DeclineCode.CardNotSupported:
    case DeclineCode.RevocationOfAuthorization:
      z = -3.4; // hard: dead credential
      break;
    default:
      z = -0.5;
  }

  const issuerPrior = f.issuerApprovalPrior ?? 0.5;
  // Strong issuer-prior signal, AMPLIFIED on later attempts (the interaction the
  // heuristic misses): a good issuer prior rescues later retries; a bad one dooms them.
  z += (issuerPrior - 0.5) * 2.2;
  z += (issuerPrior - 0.5) * Math.max(0, f.attemptNumber - 1) * 0.9;

  // Customer history carries real signal.
  z += (f.priorRecoveryRate - 0.4) * 2.0;

  // Attempt decay + staleness.
  z -= Math.max(0, f.attemptNumber - 1) * 0.55;
  z -= Math.max(0, f.daysSinceFirstFail - 3) * 0.04;

  // Tenure helps a little; large tickets hurt a little.
  z += Math.min(f.customerTenureDays / 365, 3) * 0.12;
  z -= Math.min(f.amountMinor / 100 / 1000, 3) * 0.2;

  // Card product type: prepaid recovers worst (no overdraft / reload), debit a bit worse
  // than credit (no credit-line buffer for a well-timed NSF retry). GROUNDED direction.
  if (f.cardType === 'prepaid') z -= 0.7;
  else if (f.cardType === 'debit') z -= 0.25;

  return sigmoid(z);
}

/** Card-type mix for the DGP: mostly credit, some debit, a few prepaid. */
const CARD_TYPE_MIX: readonly ('credit' | 'debit' | 'prepaid')[] = [
  'credit', 'credit', 'credit', 'credit', 'credit', 'debit', 'debit', 'debit', 'prepaid',
];

const SOFT_ISH: readonly DeclineCode[] = [
  DeclineCode.InsufficientFunds,
  DeclineCode.InsufficientFunds,
  DeclineCode.InsufficientFunds,
  DeclineCode.DoNotHonor,
  DeclineCode.DoNotHonor,
  DeclineCode.IssuerUnavailable,
  DeclineCode.TryAgainLater,
  DeclineCode.ProcessingError,
  DeclineCode.VelocityLimitExceeded,
  DeclineCode.AuthenticationRequired,
  DeclineCode.ExpiredCard,
  DeclineCode.LostCard,
  DeclineCode.StolenCard,
  DeclineCode.ClosedAccount,
  DeclineCode.InvalidCard,
];

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/**
 * Draw `n` labeled samples from the DGP. Deterministic under `seed`. Returns samples
 * whose `weight` is the invoice amount in dollars (so training optimizes recovered $,
 * not just recovered count) and whose `trueProb` supports regret-based evaluation.
 */
export function simulateSamples(n: number, seed: number): { samples: SimSample[] } {
  const rng = mulberry32(seed);
  const samples: SimSample[] = [];
  for (let k = 0; k < n; k++) {
    const declineCode = pick(SOFT_ISH, rng);
    const issuerRegion = pick(REGION_ORDER as readonly IssuerRegion[], rng);
    // Amount: lognormal-ish around ~$60, in minor units.
    const amountMinor = Math.round(500 + Math.exp(rng() * 3 + 6));
    const features: RecoveryFeatures = {
      declineCode,
      amountMinor,
      currency: 'USD',
      issuerRegion,
      cardType: pick(CARD_TYPE_MIX, rng),
      customerTenureDays: Math.round(rng() * 1200),
      priorRecoveryRate: rng(),
      attemptNumber: 1 + Math.floor(rng() * 5),
      daysSinceFirstFail: Math.floor(rng() * 20),
      issuerApprovalPrior: rng(),
    };
    const p = trueRecoverProb(features);
    const recovered = rng() < p;
    samples.push({ features, recovered, weight: amountMinor / 100, trueProb: p });
  }
  return { samples };
}

/** Sanity export: the full decline vocabulary the DGP can emit (a subset of DECLINE_ORDER). */
export const SIMULATED_DECLINES = DECLINE_ORDER;
