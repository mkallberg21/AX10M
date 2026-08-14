/**
 * Randomized holdout assignment (ARCHITECTURE.md §3.1).
 *
 * At the unit of a *failed invoice*, we route a configurable control fraction to
 * baseline-only recovery (the merchant's existing Stripe Smart Retries) and the
 * rest to Lift's engine. Assignment is:
 *
 *  - Deterministic: keyed on a stable hash of (merchant, customer, invoice) plus
 *    a per-environment salt. Re-processing the same failed invoice ALWAYS yields
 *    the same bucket, so crashes / replays / reconciliation never flip a unit
 *    between control and treatment (which would corrupt attribution).
 *
 *  - Stratified: we record the stratum (MRR tier × decline family × issuer
 *    region) so uplift is computed within comparable cells and we can run an SRM
 *    (sample-ratio-mismatch) check per stratum. Folding the stratum into the hash
 *    keeps each stratum's assignment stream independent while preserving the same
 *    expected control fraction inside every cell.
 */

import { createHash } from 'node:crypto';
import type {
  DeclineFamily,
  IssuerRegion,
  MrrTier,
} from '@lift/canonical';

/** The stratification key: assignment is balanced within each stratum. */
export interface Stratum {
  mrrTier: MrrTier;
  declineFamily: DeclineFamily;
  issuerRegion: IssuerRegion;
}

/** Serialize a stratum into a stable string key (order-fixed). */
export function stratumKey(s: Stratum): string {
  return `${s.mrrTier}|${s.declineFamily}|${s.issuerRegion}`;
}

export interface HoldoutConfig {
  /** Fraction routed to control, in [0, 1). Default 0.10 (see ARCHITECTURE §14). */
  controlFraction: number;
  /** Per-environment salt. Stable within an env; rotating it re-randomizes ALL
   *  future assignments, so treat as an infrequently-changed constant. */
  salt: string;
}

export const DEFAULT_HOLDOUT_CONFIG: HoldoutConfig = {
  controlFraction: 0.1,
  salt: 'lift-holdout-v1',
};

export type Bucket = 'control' | 'treatment';

export interface AssignmentInput {
  merchantId: string;
  customerId: string;
  invoiceId: string;
  stratum: Stratum;
}

export interface Assignment {
  bucket: Bucket;
  stratumKey: string;
  /** The normalized hash position in [0, 1). Exposed for auditing / SRM debug. */
  position: number;
}

/** Max value of a 52-bit unsigned integer, used to normalize the hash to [0,1). */
const MAX_52_BIT = 2 ** 52;

/**
 * Map an arbitrary string to a uniform double in [0, 1) via SHA-256.
 * We take the top 52 bits of the digest (fits exactly in a JS double mantissa).
 */
function hashToUnitInterval(input: string): number {
  const hex = createHash('sha256').update(input).digest('hex');
  // Top 13 hex chars = 52 bits.
  const top = Number.parseInt(hex.slice(0, 13), 16);
  return top / MAX_52_BIT;
}

/**
 * Deterministically assign a failed invoice to control or treatment.
 * Stable for a given (input, config): same input + same config ⇒ same bucket.
 */
export function assign(
  input: AssignmentInput,
  config: HoldoutConfig = DEFAULT_HOLDOUT_CONFIG,
): Assignment {
  if (config.controlFraction < 0 || config.controlFraction >= 1) {
    throw new RangeError(
      `controlFraction must be in [0, 1); got ${config.controlFraction}`,
    );
  }
  const key = stratumKey(input.stratum);
  // Fold the stratum into the hashed material so each stratum is an independent
  // assignment stream; keep the salt first so it dominates re-randomization.
  const material = [
    config.salt,
    key,
    input.merchantId,
    input.customerId,
    input.invoiceId,
  ].join(':');
  const position = hashToUnitInterval(material);
  const bucket: Bucket = position < config.controlFraction ? 'control' : 'treatment';
  return { bucket, stratumKey: key, position };
}
