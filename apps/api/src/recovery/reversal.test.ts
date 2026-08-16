import { describe, expect, it } from 'vitest';
import type { CanonicalEvent, Customer, PaymentMethod, ReversalPayload, Subscription } from '@ax10m/canonical';
import type { CapabilityMatrix, ChargeResult, Cursor, OpenFailuresPage, ProcessorAdapter, RawWebhook } from '@ax10m/poal';
import { RecoveryCaseService } from './recovery-case.service.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';
import { computePnl, type PnlLedgerEntry } from '../analytics/pnl.js';

/** A stub adapter (id 'stripe') that emits one pre-built reversal/reinstatement event. */
class ReversalAdapter implements ProcessorAdapter {
  readonly id = 'stripe';
  constructor(
    private readonly reversal: ReversalPayload,
    private readonly type: 'payment.reversed' | 'payment.reversal_reverted' = 'payment.reversed',
  ) {}
  async ingestWebhook(_raw: RawWebhook): Promise<CanonicalEvent[]> {
    return [{ id: 'evt_r', type: this.type, merchantId: 'mrc_1', processorEventId: 'evt_r', occurredAt: '2026-08-16T00:00:00.000Z', payload: this.reversal }];
  }
  async listOpenFailures(_c: Cursor): Promise<OpenFailuresPage> { return { invoices: [], nextCursor: null }; }
  async attemptCharge(): Promise<ChargeResult> { throw new Error('n/a'); }
  async fetchUpdatedCard(): Promise<PaymentMethod | null> { return null; }
  async listPaymentMethods(_c: Customer): Promise<PaymentMethod[]> { return []; }
  async pauseNativeDunning(_s: Subscription): Promise<void> {}
  capabilities(): CapabilityMatrix {
    return { integrationMode: 'drive', externalRetryControl: true, accountUpdater: false, networkTokens: false, partialCapture: false, pauseNativeDunning: false, webhooks: true, listPaymentMethods: false };
  }
}

const raw: RawWebhook = { body: '{}', headers: {} };

/** Seed a recovered payment directly onto the ledger (marked so appendDemoEvents accepts it). */
function seedRecovery(svc: RecoveryCaseService, invoiceId: string, amount: number): Promise<number> {
  return svc.appendDemoEvents([{ merchantId: 'mrc_1', type: 'case.recovered', occurredAt: '2026-08-16T00:00:00.000Z', detail: { invoiceId, processor: 'stripe', amount, currency: 'USD' } }]);
}

describe('net-recovery reversal + fee clawback', () => {
  it('records a reversal of a recovered payment and the P&L nets it (clawback)', async () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    await seedRecovery(svc, 'ax10m_inv_A', 10_000);

    await svc.ingestWithAdapter(new ReversalAdapter({ invoiceId: 'ax10m_inv_A', amount: 3_000, currency: 'USD', kind: 'chargeback' }), raw);

    const entries = await svc.ledgerEntries();
    const reversed = entries.filter((e) => e.type === 'case.reversed');
    expect(reversed).toHaveLength(1);
    expect((reversed[0]!.detail as { amount: number; processor: string }).amount).toBe(3_000);
    expect((reversed[0]!.detail as { processor: string }).processor).toBe('stripe'); // stamped from adapter.id

    const r = computePnl(entries as unknown as PnlLedgerEntry[], { nowIso: '2026-08-16T12:00:00.000Z', feeRate: 0.12 });
    expect(r.cumulative.totals.grossRecoveredMinor).toBe(10_000);
    expect(r.cumulative.totals.reversedMinor).toBe(3_000);
    expect(r.cumulative.totals.recoveredMinor).toBe(7_000); // NET
    expect(r.cumulative.totals.clawbackMinor).toBe(360); // 12% of the reversed 3000
  });

  it('caps a reversal to the net recovered — never claws back more than we earned', async () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    await seedRecovery(svc, 'ax10m_inv_A', 5_000);
    // A refund larger than the recovered amount is capped at 5000.
    await svc.ingestWithAdapter(new ReversalAdapter({ invoiceId: 'ax10m_inv_A', amount: 9_999, currency: 'USD', kind: 'refund' }), raw);
    const reversed = (await svc.ledgerEntries()).filter((e) => e.type === 'case.reversed');
    expect((reversed[0]!.detail as { amount: number }).amount).toBe(5_000);
  });

  it('ignores a reversal for an invoice we never recovered (no clawback fabricated)', async () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    await seedRecovery(svc, 'ax10m_inv_A', 5_000);
    await svc.ingestWithAdapter(new ReversalAdapter({ invoiceId: 'ax10m_inv_UNKNOWN', amount: 2_000, currency: 'USD', kind: 'chargeback' }), raw);
    expect((await svc.ledgerEntries()).filter((e) => e.type === 'case.reversed')).toHaveLength(0);
  });

  it('re-credits a won dispute (reversal reverted) and the P&L nets it back', async () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    await seedRecovery(svc, 'ax10m_inv_A', 10_000);
    await svc.ingestWithAdapter(new ReversalAdapter({ invoiceId: 'ax10m_inv_A', amount: 10_000, currency: 'USD', kind: 'chargeback' }), raw);
    await svc.ingestWithAdapter(new ReversalAdapter({ invoiceId: 'ax10m_inv_A', amount: 10_000, currency: 'USD', kind: 'chargeback' }, 'payment.reversal_reverted'), raw);

    const entries = await svc.ledgerEntries();
    expect(entries.filter((e) => e.type === 'case.reversal_reverted')).toHaveLength(1);
    const r = computePnl(entries as unknown as PnlLedgerEntry[], { nowIso: '2026-08-16T12:00:00.000Z', feeRate: 0.12 });
    expect(r.cumulative.totals.recoveredMinor).toBe(10_000); // net back to full
    expect(r.cumulative.totals.reinstatedMinor).toBe(10_000);
    expect(r.cumulative.totals.clawbackMinor).toBe(0); // fee re-accrued
  });

  it('caps a reinstatement to what is currently reversed, and ignores one with nothing reversed', async () => {
    const svc = new RecoveryCaseService(new OnboardingService());
    await seedRecovery(svc, 'ax10m_inv_A', 10_000);
    await svc.ingestWithAdapter(new ReversalAdapter({ invoiceId: 'ax10m_inv_A', amount: 4_000, currency: 'USD', kind: 'chargeback' }), raw);
    // reinstate more than was reversed → capped to 4000
    await svc.ingestWithAdapter(new ReversalAdapter({ invoiceId: 'ax10m_inv_A', amount: 9_999, currency: 'USD', kind: 'chargeback' }, 'payment.reversal_reverted'), raw);
    const reverted = (await svc.ledgerEntries()).filter((e) => e.type === 'case.reversal_reverted');
    expect((reverted[0]!.detail as { amount: number }).amount).toBe(4_000);
    // a second reinstatement now has nothing left reversed → no-op
    await svc.ingestWithAdapter(new ReversalAdapter({ invoiceId: 'ax10m_inv_A', amount: 1_000, currency: 'USD', kind: 'chargeback' }, 'payment.reversal_reverted'), raw);
    expect((await svc.ledgerEntries()).filter((e) => e.type === 'case.reversal_reverted')).toHaveLength(1);
  });
});
