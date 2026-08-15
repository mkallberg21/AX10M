/**
 * SHARED persisted send-idempotency across two processes (the HTTP API + the recovery worker).
 *
 * Two RecoveryCaseService instances point at the SAME Postgres (here one pglite Db, via two
 * PersistedSendDedupeStores over two DunningSendRepositories — exactly what two OS processes on
 * one Postgres do). Both are wired to ONE shared send provider (the external Postmark/Twilio).
 * The assertion is the whole point: a reminder one service sends is NOT re-sent by the other,
 * because the "already sent" fact lives in the shared database, not in either process's memory.
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
import { createPglite, applyMigrations, DunningSendRepository, type DbHandle } from '@ax10m/persistence';
import { TemplateDunningAgent, type DunningMessage, type DunningRecipient, type DunningSender, type SendResult } from '@ax10m/comms';
import { RecoveryCaseService } from './recovery-case.service.js';
import { PersistedSendDedupeStore } from './send-dedupe-store.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';

/** A dead-card adapter: no refreshed card, no backup rail → the engine routes to a dunning comm. */
class DeadCardAdapter implements ProcessorAdapter {
  readonly id = 'dead';
  async ingestWebhook(_raw: RawWebhook): Promise<CanonicalEvent[]> { return []; }
  async listOpenFailures(_c: Cursor): Promise<OpenFailuresPage> { return { invoices: [], nextCursor: null }; }
  async attemptCharge(): Promise<ChargeResult> { throw new Error('should not charge a dead card'); }
  async fetchUpdatedCard(): Promise<PaymentMethod | null> { return null; }
  async listPaymentMethods(_c: Customer): Promise<PaymentMethod[]> { return []; }
  async pauseNativeDunning(_s: Subscription): Promise<void> {}
  capabilities() {
    return { integrationMode: 'drive' as const, externalRetryControl: true, accountUpdater: true, networkTokens: true, partialCapture: false, pauseNativeDunning: false, webhooks: true, listPaymentMethods: true };
  }
}

/** One shared external provider; counts total sends across both processes. */
class CountingSender implements DunningSender {
  calls = 0;
  async send(_m: DunningMessage, _r: DunningRecipient): Promise<SendResult> {
    this.calls++;
    return { status: 'sent', channel: 'email', provider: 'postmark', providerMessageId: `pm-${this.calls}` };
  }
}

const method: PaymentMethod = { id: 'pm_1', customerId: 'cus_1', processorRef: 'pm_1', token: 'pm_1', brand: 'visa', last4: '4242' };
const expired = { code: DeclineCode.ExpiredCard, family: DeclineFamily.Gray };
const invoice: Invoice = { id: 'inv_1', customerId: 'cus_1', merchantId: 'mrc_1', processorRef: 'in_1', amount: { amount: 1299, currency: 'USD' }, status: 'open', createdAt: '2026-08-15T00:00:00.000Z' };
const customer: Customer = { id: 'cus_1', merchantId: 'mrc_1', processorRef: 'cus_1', email: 'dana@example.test', issuerRegion: 'na', createdAt: '2026-01-01T00:00:00.000Z', consent: { email: true, sms: false, whatsapp: false, push: false, globallyOptedOut: false } };
const dunningConfig = { updateCardUrl: ({ invoice: inv }: { invoice: Invoice; customerId: string }) => `https://pay.test/u/${inv.id}`, optOutInstruction: 'Unsubscribe: https://pay.test/unsub' };

function deliveryOf(svc: RecoveryCaseService, entries: Awaited<ReturnType<RecoveryCaseService['ledgerEntries']>>): { status?: string } {
  const comms = entries.filter((e) => e.type === 'comms.sent');
  return (comms[comms.length - 1]!.detail as { delivery?: { status?: string } }).delivery ?? {};
}

describe('shared persisted send-idempotency (API + worker → sent once)', () => {
  let handle: DbHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('a reminder the worker sends is not re-sent by the API (dedupe lives in the shared db)', async () => {
    handle = await createPglite();
    await applyMigrations(handle.db);

    const provider = new CountingSender(); // the one external Postmark both processes call
    const build = (): RecoveryCaseService => {
      const svc = new RecoveryCaseService(new OnboardingService());
      svc.useDunningAgent(new TemplateDunningAgent(), dunningConfig);
      svc.useDunningSender(provider, { live: true });
      svc.useSendDedupeStore(new PersistedSendDedupeStore(new DunningSendRepository(handle!.db))); // own repo, shared db
      return svc;
    };
    const worker = build();
    const api = build();

    // Worker sends reminder #1 (attempt 1). Then the API processes the SAME failure/attempt.
    await worker.executeRecovery({ adapter: new DeadCardAdapter(), invoice, method, decline: expired, attemptNumber: 1, customer, localHour: 14, shadow: false });
    await api.executeRecovery({ adapter: new DeadCardAdapter(), invoice, method, decline: expired, attemptNumber: 1, customer, localHour: 14, shadow: false });

    expect(deliveryOf(worker, await worker.ledgerEntries()).status).toBe('sent');
    expect(deliveryOf(api, await api.ledgerEntries()).status).toBe('duplicate'); // saw the worker's send via the db
    expect(provider.calls).toBe(1); // sent exactly once across both processes
  });
});
