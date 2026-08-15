/**
 * Persisted hash-chained ledger. Same chaining as @ax10m/attribution's in-memory
 * `HashChainedLedger` (it reuses `hashEntry` / `GENESIS_HASH`), but rows live in
 * Postgres, so integrity survives a restart: `verify()` runs the SAME `verifyChain`
 * over the persisted rows and must pass.
 *
 * CONCURRENCY: `append` reads the current head then inserts. Two writers (e.g. the HTTP
 * API and the recovery worker, both on one Postgres) can read the same head and try to
 * claim the same `seq` — but `seq` is the PRIMARY KEY, so the second insert fails with a
 * unique violation instead of forking the chain. We turn that into safe optimistic
 * concurrency: on a seq collision we re-read the head and retry. Whoever inserts first
 * wins the seq; the loser links onto the new head. This makes the ledger a correct SHARED
 * append target across processes with no advisory lock (works identically on pglite for
 * tests and on real Postgres in production).
 */

import { asc, desc, eq, sql } from 'drizzle-orm';
import { GENESIS_HASH, hashEntry, verifyChain, type ChainVerification, type LedgerEntry } from '@ax10m/attribution';
import { ledgerEntries } from './schema.js';
import type { Db } from './client.js';

/** Advisory-lock key that serializes ledger appends across connections (one global chain). */
const LEDGER_APPEND_LOCK = 0x4158_314c; // "AX1L"

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

/** Max optimistic-concurrency retries when two writers race for the same `seq`. */
const MAX_APPEND_RETRIES = 8;

/** A Postgres/pglite unique-violation (duplicate primary key `seq`) — a lost append race. */
function isSeqCollision(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === '23505') return true; // Postgres unique_violation
  const msg = err instanceof Error ? err.message : String(err);
  return /duplicate key|unique constraint|UNIQUE/i.test(msg);
}

export class LedgerRepository {
  constructor(private readonly db: Db) {}

  /**
   * Append an event, linking it to the current chain head. Returns the committed entry.
   *
   * Concurrency is handled in two layers: a transaction-scoped ADVISORY LOCK serializes
   * the read-head+insert across all writers (so the API and worker never fork the chain),
   * and a seq-collision RETRY is kept as a backstop for the rare case a backend can't take
   * the lock. Together they make concurrent multi-process appends produce one contiguous,
   * verifiable chain.
   */
  async append(input: LedgerAppendInput): Promise<LedgerEntry> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          // Serialize appends: the lock is held until this transaction commits/rolls back.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${LEDGER_APPEND_LOCK})`);
          const head = await tx
            .select({ seq: ledgerEntries.seq, hash: ledgerEntries.hash })
            .from(ledgerEntries)
            .orderBy(desc(ledgerEntries.seq))
            .limit(1);
          const prev = head[0];
          const seq = prev ? prev.seq + 1 : 0;
          const prevHash = prev ? prev.hash : GENESIS_HASH;
          const data = { seq, merchantId: input.merchantId, type: input.type as LedgerEntry['type'], occurredAt: input.occurredAt, detail: input.detail };
          const hash = hashEntry(data, prevHash);
          await tx.insert(ledgerEntries).values({ seq, merchantId: input.merchantId, type: input.type, occurredAt: input.occurredAt, detail: input.detail, prevHash, hash });
          return { ...data, prevHash, hash };
        });
      } catch (err) {
        if (!isSeqCollision(err)) throw err;
        lastErr = err; // lost a race despite the lock (backstop) — re-read head and retry
      }
    }
    throw new Error(`LedgerRepository.append: lost the seq race ${MAX_APPEND_RETRIES}× (contention too high). Last: ${String(lastErr)}`);
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
