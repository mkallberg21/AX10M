import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  HashChainedLedger,
  verifyChain,
  type LedgerEntry,
} from './ledger.js';

function seedLedger(): HashChainedLedger {
  const ledger = new HashChainedLedger();
  ledger.append({
    merchantId: 'mrc_1',
    type: 'holdout.assigned',
    occurredAt: '2026-08-01T00:00:00.000Z',
    detail: { invoiceId: 'inv_1', bucket: 'treatment' },
  });
  ledger.append({
    merchantId: 'mrc_1',
    type: 'charge.attempted',
    occurredAt: '2026-08-01T02:00:00.000Z',
    detail: { invoiceId: 'inv_1', attempt: 1 },
  });
  ledger.append({
    merchantId: 'mrc_1',
    type: 'case.recovered',
    occurredAt: '2026-08-01T02:00:05.000Z',
    detail: { invoiceId: 'inv_1', amount: 4999 },
  });
  return ledger;
}

describe('hash-chained ledger', () => {
  it('links entries: first entry references genesis, each subsequent references prior hash', () => {
    const ledger = seedLedger();
    const entries = ledger.all();
    expect(entries[0]!.prevHash).toBe(GENESIS_HASH);
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);
    expect(entries[2]!.prevHash).toBe(entries[1]!.hash);
    expect(ledger.head()).toBe(entries[2]!.hash);
  });

  it('assigns monotonic sequence numbers', () => {
    const entries = seedLedger().all();
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('verifies a well-formed chain', () => {
    expect(verifyChain(seedLedger().all()).valid).toBe(true);
  });

  it('detects tampering with an entry payload', () => {
    const entries = seedLedger().all() as LedgerEntry[];
    // Mutate a historical detail without updating the hash.
    const tampered = entries.map((e, i) =>
      i === 2 ? { ...e, detail: { ...e.detail, amount: 999_999 } } : e,
    );
    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it('detects a broken link (reordered / removed entry)', () => {
    const entries = seedLedger().all();
    // Drop the middle entry; the chain linkage should break.
    const broken = [entries[0]!, entries[2]!].map((e, i) => ({ ...e, seq: i }));
    expect(verifyChain(broken).valid).toBe(false);
  });

  it('an empty ledger verifies and its head is genesis', () => {
    const ledger = new HashChainedLedger();
    expect(ledger.head()).toBe(GENESIS_HASH);
    expect(verifyChain(ledger.all()).valid).toBe(true);
  });
});
