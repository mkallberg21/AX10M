/**
 * Persisted hash-chained ledger. Same chaining as @ax10m/attribution's in-memory
 * `HashChainedLedger` (it reuses `hashEntry` / `GENESIS_HASH`), but rows live in
 * Postgres, so integrity survives a restart: `verify()` runs the SAME `verifyChain`
 * over the persisted rows and must pass.
 *
 * CONCURRENCY: `append` reads the current head then inserts. Within one process
 * (JS single thread; pglite single connection) that is safe. On a multi-connection
 * Postgres, appends MUST be serialized — a `pg_advisory_xact_lock` or SERIALIZABLE
 * isolation around read-head+insert — or two writers could claim the same `seq` and
 * break the chain. TODO(ax10m): wrap production appends in that lock.
 */

import { asc, desc, eq } from 'drizzle-orm';
import { GENESIS_HASH, hashEntry, verifyChain, type ChainVerification, type LedgerEntry } from '@ax10m/attribution';
import { ledgerEntries } from './schema.js';
import type { Db } from './client.js';

export interface LedgerAppendInput {
  merchantId: string;
  type: string;
  occurredAt: string;
  detail: Record<string, unknown>;
}

interface Row {
  seq: number;
  merchantId: string;
  type: string;
  occurredAt: string;
  detail: unknown;
  prevHash: string;
  hash: string;
}

function toEntry(r: Row): LedgerEntry {
  return {
    seq: r.seq,
    merchantId: r.merchantId,
    type: r.type as LedgerEntry['type'],
    occurredAt: r.occurredAt,
    detail: (r.detail ?? {}) as Record<string, unknown>,
    prevHash: r.prevHash,
    hash: r.hash,
  };
}

export class LedgerRepository {
  constructor(private readonly db: Db) {}

  /** Append an event, linking it to the current chain head. Returns the committed entry. */
  async append(input: LedgerAppendInput): Promise<LedgerEntry> {
    const head = await this.db
      .select({ seq: ledgerEntries.seq, hash: ledgerEntries.hash })
      .from(ledgerEntries)
      .orderBy(desc(ledgerEntries.seq))
      .limit(1);
    const prev = head[0];
    const seq = prev ? prev.seq + 1 : 0;
    const prevHash = prev ? prev.hash : GENESIS_HASH;
    const data = { seq, merchantId: input.merchantId, type: input.type as LedgerEntry['type'], occurredAt: input.occurredAt, detail: input.detail };
    const hash = hashEntry(data, prevHash);
    await this.db.insert(ledgerEntries).values({
      seq,
      merchantId: input.merchantId,
      type: input.type,
      occurredAt: input.occurredAt,
      detail: input.detail,
      prevHash,
      hash,
    });
    return { ...data, prevHash, hash };
  }

  /** All entries in chain order. */
  async all(): Promise<LedgerEntry[]> {
    const rows = (await this.db.select().from(ledgerEntries).orderBy(asc(ledgerEntries.seq))) as Row[];
    return rows.map(toEntry);
  }

  /** Entries for one merchant (tenant-scoped view). */
  async forMerchant(merchantId: string): Promise<LedgerEntry[]> {
    const rows = (await this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.merchantId, merchantId))
      .orderBy(asc(ledgerEntries.seq))) as Row[];
    return rows.map(toEntry);
  }

  /** Current chain head hash (GENESIS if empty). */
  async head(): Promise<string> {
    const head = await this.db.select({ hash: ledgerEntries.hash }).from(ledgerEntries).orderBy(desc(ledgerEntries.seq)).limit(1);
    return head[0]?.hash ?? GENESIS_HASH;
  }

  /** Verify chain integrity over the PERSISTED rows — the restart-safety check. */
  async verify(): Promise<ChainVerification> {
    return verifyChain(await this.all());
  }
}
