/**
 * Append-only, hash-chained ledger (ARCHITECTURE.md §3.3).
 *
 * Every recovery decision, its counterfactual bucket, every attempt, decline
 * code, and outcome is written here. Each entry references the hash of the
 * previous entry, forming a tamper-evident chain: altering any historical entry
 * changes its hash and breaks every subsequent link, which `verifyChain` detects.
 *
 * This is the artifact that makes billing auditable — the Uplift Statement is
 * derived from it and a CFO can reconcile it line-by-line against the processor's
 * own payout reports.
 *
 * NOTE: this in-memory implementation is the reference logic. Production persists
 * entries to append-only Postgres and signs the chain head with a KMS/HSM key
 * (TODO(ax10m): wire persistence + signature). The hashing/verification logic is
 * identical and lives here so it is unit-testable in isolation.
 */

import { createHash } from 'node:crypto';

/** The kinds of events recorded in the ledger. */
export type LedgerEventType =
  | 'holdout.assigned'
  | 'recovery.planned'
  | 'charge.attempted'
  | 'charge.succeeded'
  | 'charge.failed'
  | 'comms.sent'
  | 'action.suppressed'
  | 'case.recovered'
  | 'case.reversed'
  | 'case.abandoned'
  | 'model.promoted'
  | 'uplift.statement';

/** The immutable payload of a ledger entry (everything except the chain hash). */
export interface LedgerEntryData {
  /** Monotonic sequence number, 0-based. */
  seq: number;
  merchantId: string;
  type: LedgerEventType;
  /** ISO timestamp of the recorded event. */
  occurredAt: string;
  /** Arbitrary event-specific detail. Must be JSON-serializable + stable. */
  detail: Record<string, unknown>;
}

/** A committed ledger entry: data + the link hashes that chain it. */
export interface LedgerEntry extends LedgerEntryData {
  /** Hash of the previous entry (genesis uses GENESIS_HASH). */
  prevHash: string;
  /** Hash over (prevHash + canonical(data)). */
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Canonical JSON serialization with sorted keys, so the same logical entry always
 * hashes identically regardless of key insertion order.
 */
function canonicalize(data: LedgerEntryData): string {
  const stable = {
    seq: data.seq,
    merchantId: data.merchantId,
    type: data.type,
    occurredAt: data.occurredAt,
    detail: sortKeys(data.detail),
  };
  return JSON.stringify(stable);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

/** Compute the link hash for an entry given the previous hash. */
export function hashEntry(data: LedgerEntryData, prevHash: string): string {
  return createHash('sha256')
    .update(prevHash)
    .update(canonicalize(data))
    .digest('hex');
}

/**
 * An append-only hash-chained ledger. Entries can only be appended; there is no
 * update or delete. `verifyChain` proves integrity.
 */
export class HashChainedLedger {
  private readonly entries: LedgerEntry[] = [];

  /** Append an event. Seq + chain linkage are assigned here, not by the caller. */
  append(
    input: Omit<LedgerEntryData, 'seq'>,
  ): LedgerEntry {
    const seq = this.entries.length;
    const prevHash = seq === 0 ? GENESIS_HASH : this.entries[seq - 1]!.hash;
    const data: LedgerEntryData = { ...input, seq };
    const hash = hashEntry(data, prevHash);
    const entry: LedgerEntry = { ...data, prevHash, hash };
    this.entries.push(entry);
    return entry;
  }

  /** Current chain head hash — sign this to notarize the whole ledger. */
  head(): string {
    return this.entries.length === 0
      ? GENESIS_HASH
      : this.entries[this.entries.length - 1]!.hash;
  }

  /** Immutable snapshot of all entries. */
  all(): readonly LedgerEntry[] {
    return this.entries.slice();
  }

  /** Entries for a single merchant (tenant-scoped view). */
  forMerchant(merchantId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.merchantId === merchantId);
  }
}

export interface ChainVerification {
  valid: boolean;
  /** Seq of the first entry that failed verification, if any. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Verify chain integrity: sequence continuity, correct prev-hash linkage, and
 * recomputed hashes matching stored hashes. Any tamper is caught at the first
 * altered entry.
 */
export function verifyChain(entries: readonly LedgerEntry[]): ChainVerification {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i) {
      return { valid: false, brokenAt: i, reason: `seq mismatch: expected ${i}, got ${e.seq}` };
    }
    if (e.prevHash !== prevHash) {
      return { valid: false, brokenAt: i, reason: 'prevHash does not match prior entry hash' };
    }
    const recomputed = hashEntry(
      { seq: e.seq, merchantId: e.merchantId, type: e.type, occurredAt: e.occurredAt, detail: e.detail },
      e.prevHash,
    );
    if (recomputed !== e.hash) {
      return { valid: false, brokenAt: i, reason: 'entry hash does not match content (tampered)' };
    }
    prevHash = e.hash;
  }
  return { valid: true };
}
