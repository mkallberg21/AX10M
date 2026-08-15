import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type DeclineEvent, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import type { RecoveryDecision, RetryStep } from '@ax10m/recovery-engine';
import { runSequencedRecoverySaga } from './sequenced-driver.js';
import { InMemoryRuntime } from './runtime.js';
import type { AttemptInput, ExecuteResult, RecoveryCasePort, RecoverySagaInput } from './types.js';

const invoice: Invoice = {
  id: 'ax10m_inv_1', customerId: 'ax10m_cus_1', merchantId: 'mrc_1', processorRef: 'in_1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-14T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_1', customerId: 'ax10m_cus_1', processorRef: 'pm_1', token: 'pm_1', brand: 'visa' };
const decline: DeclineEvent = { id: 'd1', invoiceId: 'ax10m_inv_1', chargeAttemptId: '', code: DeclineCode.InsufficientFunds, family: DeclineFamily.Soft, occurredAt: '2026-08-14T12:00:00.000Z' };
const dec = (over: Partial<RecoveryDecision> = {}): RecoveryDecision => ({ action: 'retry', recoverabilityScore: 0.6, expectedValueMinor: 1000, rationale: 'x', ...over });
const charged = (outcome: ExecuteResult['outcome']): ExecuteResult => ({ action: 'charged', outcome, decision: dec() });

/** A port with a scripted ARSE sequence and scripted execute outcomes. */
class SeqPort implements RecoveryCasePort {
  readonly executed: number[] = [];
  constructor(private readonly steps: RetryStep[], private readonly outcomes: ExecuteResult[]) {}
  async plan(_i: AttemptInput) { return { decision: dec() }; }
  async planSequence(_i: AttemptInput) { return this.steps; }
  async execute(i: AttemptInput): Promise<ExecuteResult> {
    this.executed.push(i.attemptNumber);
    return this.outcomes[this.executed.length - 1] ?? charged('failed');
  }
}

function retrySteps(times: string[], base = 1): RetryStep[] {
  return times.map((at, i) => ({ attemptNumber: base + i, at, action: 'retry' as const, methodRef: 'pm_1', expectedRecoverability: 0.5, rationale: `step ${i}` }));
}

const input: RecoverySagaInput = { attempt: { invoice, method, decline }, shadow: false };

describe('runSequencedRecoverySaga', () => {
  it('walks the planned schedule, sleeping to each step, and recovers on success', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const steps = retrySteps(['2026-08-15T12:00:00.000Z', '2026-08-18T12:00:00.000Z', '2026-08-21T12:00:00.000Z']);
    const port = new SeqPort(steps, [charged('failed'), charged('succeeded')]);
    const res = await runSequencedRecoverySaga(port, rt, input);

    expect(res.status).toBe('recovered');
    expect(port.executed).toEqual([1, 2]); // stopped after the 2nd step succeeded
    expect(rt.sleeps[0]).toEqual({ from: '2026-08-14T12:00:00.000Z', to: '2026-08-15T12:00:00.000Z' });
    expect(rt.sleeps[1]!.to).toBe('2026-08-18T12:00:00.000Z');
  });

  it('exhausts the sequence when every step fails', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const steps = retrySteps(['2026-08-15T12:00:00.000Z', '2026-08-18T12:00:00.000Z']);
    const port = new SeqPort(steps, [charged('failed'), charged('failed')]);
    const res = await runSequencedRecoverySaga(port, rt, input);
    expect(res.status).toBe('exhausted');
    expect(port.executed).toEqual([1, 2]);
  });

  it('ends on a terminal card_update step without charging', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const steps: RetryStep[] = [{ attemptNumber: 1, at: rt.now(), action: 'card_update', expectedRecoverability: 0.05, rationale: 'expired' }];
    const port = new SeqPort(steps, []);
    const res = await runSequencedRecoverySaga(port, rt, input);
    expect(res.status).toBe('card_update_comms');
    expect(port.executed).toHaveLength(0);
  });

  it('hands off a pending (co-drive) charge after the settlement window', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const port = new SeqPort(retrySteps(['2026-08-15T12:00:00.000Z']), [charged('pending')]);
    const res = await runSequencedRecoverySaga(port, rt, input);
    expect(res.status).toBe('pending_handoff');
    expect(res.timeline.some((e) => e.kind === 'awaiting_settlement')).toBe(true);
  });

  it('stops (nothing to do) when the sequence is empty', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const res = await runSequencedRecoverySaga(new SeqPort([], []), rt, input);
    expect(res.status).toBe('engine_suppressed');
  });

  it('throws if the port cannot plan sequences', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const noSeq: RecoveryCasePort = { async plan() { return { decision: dec() }; }, async execute() { return charged('failed'); } };
    await expect(runSequencedRecoverySaga(noSeq, rt, input)).rejects.toThrow(/does not implement planSequence/);
  });
});
