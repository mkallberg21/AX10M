/**
 * The retrainer running against the PERSISTED ledger — the flywheel, end to end.
 *
 * Fills a persisted (pglite) ledger by running the REAL recovery service in active mode,
 * then runs `runRetrainJob` against that same database: it reads the persisted ledger,
 * fits a challenger, and — when the promotion gate passes — persists the new champion to
 * the model store and records a `model.promoted` event in the same hash-chained ledger.
 * Finally a fresh service loads the persisted champion. This is the loop the API + worker
 * run in production (there, against real Postgres filled by real charges).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DeclineFamily,
  familyOf,
  type CanonicalEvent,
  type ChargeResult,
  type Customer,
  type Invoice,
  type PaymentMethod,
  type Subscription,
} from '@ax10m/canonical';
import type { Cursor, OpenFailuresPage, ProcessorAdapter, RawWebhook } from '@ax10m/poal';
import { FEATURE_DIM, simulateSamples } from '@ax10m/recovery-engine';
import { createPglite, applyMigrations, LedgerRepository, ModelRepository, type DbHandle } from '@ax10m/persistence';
import { RecoveryCaseService } from './recovery-case.service.js';
import { PersistedLedgerPort } from './ledger-port.js';
import { runRetrainJob, loadActiveChampion } from './retrain-job.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';

class ScriptedOutcomeAdapter implements ProcessorAdapter {
  readonly id = 'sim';
  constructor(private readonly outcomes: Map<string, boolean>) {}
  async ingestWebhook(_r: RawWebhook): Promise<CanonicalEvent[]> {
    return [];
  }
  async listOpenFailures(_c: Cursor): Promise<OpenFailuresPage> {
    return { invoices: [], nextCursor: null };
  }
  async attemptCharge(invoice: Invoice, method: PaymentMethod, idempotencyKey: string): Promise<ChargeResult> {
    const ok = this.outcomes.get(invoice.id) ?? false;
    const outcome: ChargeResult['outcome'] = ok ? 'succeeded' : 'failed';
    return { outcome, idempotentReplay: false, attempt: { id: `att_${invoice.id}`, invoiceId: invoice.id, paymentMethodId: method.id, idempotencyKey, amount: invoice.amount, status: outcome, attemptNumber: 1, attemptedAt: '2026-08-14T00:00:00.000Z' } };
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

/** Run the real service over a simulated stream, writing to the PERSISTED ledger on `db`. */
async function fillPersistedLedger(db: DbHandle['db'], n: number, seed: number): Promise<void> {
  const { samples } = simulateSamples(n, seed);
  const outcomes = new Map<string, boolean>();
  const svc = new RecoveryCaseService(new OnboardingService());
  svc.useLedger(new PersistedLedgerPort(new LedgerRepository(db)));
  const adapter = new ScriptedOutcomeAdapter(outcomes);

  for (let i = 0; i < samples.length; i++) {
    const f = samples[i]!.features;
    const invoice: Invoice = { id: `inv_${i}`, customerId: `cus_${i}`, merchantId: 'mrc_1', processorRef: `in_${i}`, amount: { amount: f.amountMinor, currency: 'USD' }, status: 'open', createdAt: '2026-08-14T00:00:00.000Z' };
    const method: PaymentMethod = { id: `pm_${i}`, customerId: invoice.customerId, processorRef: `pm_${i}`, token: `pm_${i}`, brand: 'visa' };
    const decline = { id: `dec_${i}`, invoiceId: invoice.id, chargeAttemptId: '', code: f.declineCode, family: familyOf(f.declineCode), occurredAt: '2026-08-14T12:00:00.000Z' };
    outcomes.set(invoice.id, samples[i]!.recovered);
    if (decline.family !== DeclineFamily.Hard) {
      await svc.executeRecovery({ adapter, invoice, method, decline, attemptNumber: 1, shadow: false });
    }
  }
}

describe('retrainer against the persisted ledger (the flywheel)', () => {
  let handle: DbHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('reads the persisted ledger, promotes a challenger, and persists it as the active champion', async () => {
    handle = await createPglite();
    await applyMigrations(handle.db);

    // Seed a BLANK champion so the promotion gate is deterministically clearable, then
    // fill the persisted ledger by actually running the recovery service.
    await new ModelRepository(handle.db).saveChampion({ w: new Array<number>(FEATURE_DIM).fill(0), b: 0 }, '2026-08-14T00:00:00.000Z');
    await fillPersistedLedger(handle.db, 2500, 123);

    const res = await runRetrainJob({ db: handle.db });

    expect(res.championSource).toBe('persisted'); // compared against the seeded blank champion
    expect(res.report.accepted).toBe(true);
    expect(res.report.nSamples).toBeGreaterThanOrEqual(500);
    expect(res.report.promoted).toBe(true);
    expect(res.promotedVersion).toBe(1); // blank was v0, promoted challenger is v1

    // The promotion is recorded in the same hash-chained ledger (auditable).
    const entries = await new LedgerRepository(handle.db).all();
    const promo = entries.find((e) => e.type === 'model.promoted');
    expect(promo).toBeDefined();
    expect((promo!.detail as { version: number }).version).toBe(1);

    // The persisted champion is now the retrained one, and a fresh service can load it.
    const champ = await loadActiveChampion({ db: handle.db });
    expect(champ).not.toBeNull();
    expect((champ!.meta as { corpus?: string }).corpus).toBe('ledger');
    const fresh = new RecoveryCaseService(new OnboardingService());
    expect(() => fresh.useChampion(champ!)).not.toThrow();
  }, 180_000);

  it('rejects a too-thin persisted ledger via the data-quality gate (no model shipped)', async () => {
    handle = await createPglite();
    await applyMigrations(handle.db);
    await fillPersistedLedger(handle.db, 80, 7);

    const res = await runRetrainJob({ db: handle.db });
    expect(res.report.accepted).toBe(false);
    expect(res.report.reason).toBe('insufficient_samples');
    expect(res.promotedVersion).toBeNull();
    // Nothing was persisted to the model store.
    expect(await new ModelRepository(handle.db).latestVersion()).toBe(-1);
  }, 120_000);
});
