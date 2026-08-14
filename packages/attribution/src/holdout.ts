/**
 * Randomized holdout assignment (ATTRIBUTION.md §2).
 *
 * We **cluster-randomize at the customer level**, not the invoice level. The
 * randomization unit is the customer; ALL of a customer's failed invoices inherit
 * that customer's arm for the life of the epoch. Outcomes are still observed per
 * invoice, but assignment is per customer. This is the single most important
 * design choice: if a customer's two failed invoices could land in different
 * arms, a treatment "update your card" comm would fix the payment method that
 * then recovers the *control* invoice for free — contaminating the control rate
 * and biasing (understating) uplift (§3.1). Customer-level clustering makes that
 * spillover structurally impossible, and it is what lets the cluster-robust
 * variance in `sequential.ts` be well-defined.
 *
 * Assignment is:
 *
 *  - Deterministic: keyed on a stable hash of (merchant, customer) plus a
 *    per-epoch salt. `invoice_id` does NOT enter the bucket boundary — only the
 *    guest fallback (§2.4) and the assignment record use it. Re-processing the
 *    same customer ALWAYS yields the same arm, so crashes / replays /
 *    reconciliation never flip a unit between control and treatment.
 *
 *  - Stratified: we record the stratum (MRR tier × decline family × issuer
 *    region) so uplift is computed within comparable cells and we can run an SRM
 *    check per stratum. The stratum is folded into the hash so each stratum is an
 *    independent assignment stream at the same expected control fraction; callers
 *    must pass the customer's *sticky* stratum (from their first qualifying
 *    failure in the epoch, §2.5) so the bucket stays stable across repeat failures.
 *
 *  - Guest-safe: one-off invoices with no durable customer identity fall back to
 *    invoice-grain assignment and are analyzed in a separate stratum (§2.4).
 */

import { createHash } from 'node:crypto';
import type {
  DeclineFamily,
  IssuerRegion,
  MrrTier,
} from '@ax10m/canonical';

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
  salt: 'ax10m-holdout-v1',
};

export type Bucket = 'control' | 'treatment';

/** The grain at which a unit was randomized. Customers cluster; guests fall back to invoice. */
export type UnitGrain = 'customer' | 'invoice';

export interface AssignmentInput {
  merchantId: string;
  /**
   * Durable customer id (the randomization cluster). Null/empty → a guest /
   * one-off charge with no durable identity, which falls back to invoice grain.
   */
  customerId: string | null;
  /** Invoice id — used for the assignment record and for the guest fallback boundary only. */
  invoiceId: string;
  stratum: Stratum;
}

export interface Assignment {
  bucket: Bucket;
  stratumKey: string;
  /** 'customer' for normal cluster assignment; 'invoice' for guest/one-off fallback. */
  unitGrain: UnitGrain;
  /** The exact string that was hashed (audit trail, ATTRIBUTION.md §10.2 bucket_key). */
  bucketKey: string;
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
 * Deterministically assign a customer (or guest invoice) to control or treatment.
 *
 * Cluster-randomized at the customer level: the bucket boundary is a pure
 * function of (salt, stratum, merchant, customer) — `invoice_id` is deliberately
 * excluded so a customer's repeat failures all inherit the same arm. Guests with
 * no `customerId` fall back to invoice-grain assignment (§2.4). Stable for a
 * given (input, config): same input + same config ⇒ same bucket.
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
  const isGuest = input.customerId == null || input.customerId === '';
  // Salt first so it dominates re-randomization; stratum folded so each stratum is
  // an independent stream. Customer grain excludes invoiceId; guest grain uses it.
  const material = isGuest
    ? [config.salt, key, input.merchantId, 'guest', input.invoiceId].join(':')
    : [config.salt, key, input.merchantId, input.customerId].join(':');
  const position = hashToUnitInterval(material);
  const bucket: Bucket = position < config.controlFraction ? 'control' : 'treatment';
  return {
    bucket,
    stratumKey: key,
    unitGrain: isGuest ? 'invoice' : 'customer',
    bucketKey: material,
    position,
  };
}
