/**
 * SHARED persisted ledger across two processes (the HTTP API + the recovery worker).
 *
 * We model the two processes as two RecoveryCaseService instances that both point at the
 * SAME Postgres (here: one pglite Db, shared by two `PersistedLedgerPort`s over two
 * `LedgerRepository`s — exactly what two OS processes connected to one Postgres do). They
 * drive charges CONCURRENTLY; the assertions are the whole point of the feature:
 *
 *   1. Both writers append into ONE contiguous, verifiable hash chain (seqs 0..N-1, no
 *      forks) even under concurrent writes — the seq-collision retry resolves races.
 *   2. A charge one service records is visible to the OTHER service (and any fresh repo),
 *      because the ledger lives in the shared database, not in either process's memory.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DeclineCode,
  DeclineFamily,
  type CanonicalEvent,
  type ChargeResult,
  type Customer,
  type Invoice,
  type PaymentMethod,
  type Subscription,
} from '@ax10m/canonical';
import type { Cursor, OpenFailuresPage, ProcessorAdapter, RawWebhook } from '@ax10m/poal';
import { verifyChain } from '@ax10m/attribution';
import { createPglite, applyMigrations, LedgerRepository, type DbHandle } from '@ax10m/persistence';
import { RecoveryCaseService } from './recovery-case.service.js';
import { PersistedLedgerPort } from './ledger-port.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';

class OkAdapter implements ProcessorAdapter {
  readonly id = 'ok';
  async ingestWebhook(_raw: RawWebhook): Promise<CanonicalEvent[]> {
    return [];
  }
  async listOpenFailures(_c: Cursor): Promise<OpenFailuresPage> {
    return { invoices: [], nextCursor: null };
  }
  async attemptCharge(invoice: Invoice, method: PaymentMethod, idempotencyKey: string): Promise<ChargeResult> {
    return {
      outcome: 'succeeded',
      idempotentReplay: false,
      attempt: { id: `att_${invoice.id}`, invoiceId: invoice.id, paymentMethodId: method.id, idempotencyKey, amount: invoice.amount, status: 'succeeded', attemptNumber: 1, attemptedAt: '2026-08-14T00:00:00.000Z' },
    };
  }
  async fetchUpdatedCard(): Promise<PaymentMethod | null> {
    return null;
  }
  async listPaymentMethods(_c: Customer): Promise<PaymentMethod[]> {
    return [];
  }
  async pauseNativeDunning(_s: Subscription): Promise<void> {}
  capabilities() {
    return { integrationMode: 'drive' as const, externalRetryControl: true, accountUpdater: false, networkTokens: false, partialCapture: false, pauseNativeDunning: false, webhooks: true, listPaymentMethods: true };
  }
}

const method: PaymentMethod = { id: 'pm_1', customerId: 'cus_1', processorRef: 'pm_1', token: 'pm_1', brand: 'visa' };
const decline = { code: DeclineCode.InsufficientFunds, family: DeclineFamily.Soft };
const invoiceFor = (i: number): Invoice => ({
  id: `inv_${i}`,
  customerId: `cus_${i}`,
  merchantId: 'mrc_1',
  processorRef: `in_${i}`,
  amount: { amount: 10000 + i, currency: 'USD' },
  status: 'open',
  createdAt: '2026-08-14T00:00:00.000Z',
});

describe('shared persisted ledger (API + worker → one chain)', () => {
  let handle: DbHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('two services writing concurrently produce one contiguous, verifiable chain', async () => {
    handle = await createPglite(); // one in-memory Postgres = one shared database
    await applyMigrations(handle.db);

    // Two independent services (API + worker) over the SAME db, each with its own repo +
    // port — exactly two processes on one Postgres. Separate per-instance mutexes, so
    // their appends genuinely race at the database and exercise the seq-collision retry.
    const api = new RecoveryCaseService(new OnboardingService());
    const worker = new RecoveryCaseService(new OnboardingService());
    api.useLedger(new PersistedLedgerPort(new LedgerRepository(handle.db)));
    worker.useLedger(new PersistedLedgerPort(new LedgerRepository(handle.db)));

    const adapter = new OkAdapter();
    const charge = (svc: RecoveryCaseService, i: number): Promise<unknown> =>
      svc.executeRecovery({ adapter, invoice: invoiceFor(i), method, decline, attemptNumber: 1, shadow: false });

    // 20 cases, alternating services, all fired concurrently → maximal interleaving.
    await Promise.all(Array.from({ length: 20 }, (_, i) => charge(i % 2 === 0 ? api : worker, i)));

    // Read the shared chain back through a THIRD, fresh repo (a "new process").
    const entries = await new LedgerRepository(handle.db).all();
    expect(entries.length).toBeGreaterThanOrEqual(20); // each charge appended ≥1 entry

    // The chain is contiguous (0..N-1) with no forks, and hashes verify end-to-end.
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i));
    expect(verifyChain(entries).valid).toBe(true);

    // Both services see the SAME head — neither holds a private in-memory ledger.
    expect(await api.ledgerHead()).toBe(await worker.ledgerHead());
    expect(await api.ledgerHead()).toBe(entries[entries.length - 1]!.hash);
  });

  it("a charge the worker records is visible in the API's ledger view (shared, not in-memory)", async () => {
    handle = await createPglite();
    await applyMigrations(handle.db);
    const api = new RecoveryCaseService(new OnboardingService());
    const worker = new RecoveryCaseService(new OnboardingService());
    api.useLedger(new PersistedLedgerPort(new LedgerRepository(handle.db)));
    worker.useLedger(new PersistedLedgerPort(new LedgerRepository(handle.db)));

    const before = (await api.ledgerEntries()).length;
    await worker.executeRecovery({ adapter: new OkAdapter(), invoice: invoiceFor(99), method, decline, attemptNumber: 1, shadow: false });

    const apiView = await api.ledgerEntries();
    expect(apiView.length).toBeGreaterThan(before); // the worker's charge is in the API's view
    expect(apiView.some((e) => e.type === 'case.recovered' && (e.detail as { invoiceId?: string }).invoiceId === 'inv_99')).toBe(true);
  });
});
