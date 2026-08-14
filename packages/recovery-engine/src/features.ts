/**
 * Feature encoding — the bridge from `RecoveryFeatures` to a numeric vector.
 *
 * Training and scoring MUST encode identically, so both go through `encodeFeatures`.
 * The encoding is deterministic, leakage-free (every input is observed at failure
 * time), and stable — the index order below is a contract, because trained weights
 * are indexed positionally. Appending a new feature is safe (old weights get 0);
 * reordering or removing one silently corrupts a trained model, so DON'T.
 */

import { DeclineCode, type IssuerRegion } from '@ax10m/canonical';

/** Stable decline-code order for one-hot encoding. Append-only. */
export const DECLINE_ORDER: readonly DeclineCode[] = [
  DeclineCode.InsufficientFunds,
  DeclineCode.IssuerUnavailable,
  DeclineCode.ProcessingError,
  DeclineCode.VelocityLimitExceeded,
  DeclineCode.AuthenticationRequired,
  DeclineCode.TryAgainLater,
  DeclineCode.LostCard,
  DeclineCode.StolenCard,
  DeclineCode.ClosedAccount,
  DeclineCode.InvalidCard,
  DeclineCode.PickupCard,
  DeclineCode.CardNotSupported,
  DeclineCode.RevocationOfAuthorization,
  DeclineCode.DoNotHonor,
  DeclineCode.Fraudulent,
  DeclineCode.ExpiredCard,
  DeclineCode.Unknown,
];

/** Stable issuer-region order for one-hot encoding. Append-only. */
export const REGION_ORDER: readonly IssuerRegion[] = ['na', 'emea', 'latam', 'apac', 'unknown'];

/** Human-readable name of each encoded dimension (same order as `encodeFeatures`). */
export const FEATURE_NAMES: readonly string[] = [
  ...DECLINE_ORDER.map((c) => `decline=${c}`),
  'log_amount',
  ...REGION_ORDER.map((r) => `region=${r}`),
  'tenure_years',
  'prior_recovery_rate',
  'attempt_penalty',
  'days_since_fail',
  'issuer_approval_prior',
];

/** Dimensionality of the encoded feature vector. */
export const FEATURE_DIM = FEATURE_NAMES.length;

import type { RecoveryFeatures } from './recoverability.js';

/** Encode features into a fixed-length numeric vector (see FEATURE_NAMES for the layout). */
export function encodeFeatures(f: RecoveryFeatures): number[] {
  const x: number[] = [];

  // One-hot decline code (dominant signal).
  for (const code of DECLINE_ORDER) x.push(f.declineCode === code ? 1 : 0);

  // log(amount) scaled into ~[0,1] for a typical $0–$100k ticket.
  x.push(Math.log1p(Math.max(0, f.amountMinor)) / 12);

  // One-hot issuer region.
  for (const r of REGION_ORDER) x.push(f.issuerRegion === r ? 1 : 0);

  // Tenure in years, capped at 3.
  x.push(Math.min(Math.max(0, f.customerTenureDays) / 365, 3));

  // Customer prior recovery rate, already 0..1.
  x.push(clamp01(f.priorRecoveryRate));

  // Attempt penalty: 0 on the first attempt, saturating by the 7th.
  x.push(Math.min(Math.max(0, f.attemptNumber - 1), 6) / 6);

  // Staleness: days since first failure, scaled by a month and capped.
  x.push(Math.min(Math.max(0, f.daysSinceFirstFail) / 30, 2));

  // Cross-merchant issuer/BIN approval prior (neutral 0.5 if unknown).
  x.push(clamp01(f.issuerApprovalPrior ?? 0.5));

  return x;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
