import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily, type DeclineEvent, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import type { RecoveryDecision } from '@ax10m/recovery-engine';
import { runRecoverySaga, type RecoverySagaInput } from './driver.js';
import { InMemoryRuntime } from './runtime.js';
import { DEFAULT_SCHEDULER_CONFIG } from './config.js';
import type { AttemptInput, ExecuteResult, PlanResult, RecoveryCasePort } from './types.js';

const invoice: Invoice = {
  id: 'ax10m_inv_1',
  customerId: 'ax10m_cus_1',
  merchantId: 'mrc_1',
  processorRef: 'in_1',
  amount: { amount: 14900, currency: 'USD' },
  status: 'open',
  createdAt: '2026-08-14T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_1', customerId: 'ax10m_cus_1', processorRef: 'pm_1', token: 'pm_1', brand: 'visa' };
const decline: DeclineEvent = {
  id: 'ax10m_dec_1',
  invoiceId: 'ax10m_inv_1',
  chargeAttemptId: 'att_0',
  code: DeclineCode.InsufficientFunds,
  family: DeclineFamily.Soft,
  occurredAt: '2026-08-14T12:00:00.000Z',
};

function retryDecision(retryAt?: string): RecoveryDecision {
  return { action: 'retry', retryAt, recoverabilityScore: 0.6, expectedValueMinor: 1000, rationale: 'retry' };
}

/**
 * A scripted port: `plan` returns a retry timed `retryAfterMinutes` out from the call,
 * and `execute` returns the next queued outcome. Records the attemptNumbers it saw so
 * we can assert exactly-once threading.
 */
class ScriptedPort implements RecoveryCasePort {
  readonly executed: number[] = [];
  constructor(
    private readonly runtime: InMemoryRuntime,
    private readonly outcomes: ExecuteResult[],
    private readonly retryAfterMinutes = 60,
  ) {}

  async plan(input: AttemptInput): Promise<PlanResult> {
    // Decline determines the action; here always a retry timed off the current clock.
    void input;
    const retryAt = new Date(Date.parse(this.runtime.now()) + this.retryAfterMinutes * 60_000).toISOString();
    return { decision: retryDecision(retryAt) };
  }

  async execute(input: AttemptInput): Promise<ExecuteResult> {
    this.executed.push(input.attemptNumber);
    return this.outcomes[this.executed.length - 1] ?? { action: 'charged', outcome: 'failed', decision: retryDecision() };
  }
}

const baseInput: RecoverySagaInput = { attempt: { invoice, method, decline }, shadow: false };
const charged = (outcome: ExecuteResult['outcome']): ExecuteResult => ({ action: 'charged', outcome, decision: retryDecision() });

describe('runRecoverySaga', () => {
  it('recovers on the first successful charge and threads attemptNumber 1', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const port = new ScriptedPort(rt, [charged('succeeded')]);
    const res = await runRecoverySaga(port, rt, baseInput);
    expect(res.status).toBe('recovered');
    expect(res.attempts).toBe(1);
    expect(port.executed).toEqual([1]);
  });

  it('retries failed charges with incrementing attemptNumbers, sleeping to each retryAt', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const port = new ScriptedPort(rt, [charged('failed'), charged('failed'), charged('succeeded')], 24 * 60);
    const res = await runRecoverySaga(port, rt, baseInput);
    expect(res.status).toBe('recovered');
    expect(port.executed).toEqual([1, 2, 3]); // exactly-once: monotonic, no repeats
    // Slept ~24h before each of the 3 attempts.
    expect(rt.sleeps).toHaveLength(3);
    expect(rt.sleeps[0]).toEqual({ from: '2026-08-14T12:00:00.000Z', to: '2026-08-15T12:00:00.000Z' });
  });

  it('stops exhausted after maxAttempts consecutive failures', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const cfg = { ...DEFAULT_SCHEDULER_CONFIG, maxAttempts: 3 };
    const port = new ScriptedPort(rt, [charged('failed'), charged('failed'), charged('failed')]);
    const res = await runRecoverySaga(port, rt, baseInput, cfg);
    expect(res.status).toBe('exhausted');
    expect(res.attempts).toBe(3);
    expect(port.executed).toEqual([1, 2, 3]); // never a 4th
  });

  it('hands off a pending (co-drive) charge after the settlement window', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const port = new ScriptedPort(rt, [charged('pending')]);
    const res = await runRecoverySaga(port, rt, baseInput);
    expect(res.status).toBe('pending_handoff');
    expect(res.timeline.some((e) => e.kind === 'awaiting_settlement')).toBe(true);
  });

  it('ends immediately in shadow mode without looping', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const port = new ScriptedPort(rt, [{ action: 'shadowed', decision: retryDecision() }]);
    const res = await runRecoverySaga(port, rt, { ...baseInput, shadow: true });
    expect(res.status).toBe('shadow_complete');
    expect(port.executed).toEqual([1]);
  });

  it('stops without charging when the engine plans card-update comms', async () => {
    const rt = new InMemoryRuntime('2026-08-14T12:00:00.000Z');
    const port: RecoveryCasePort = {
      async plan() {
        return { decision: { action: 'card_update_comms', recoverabilityScore: 0.2, expectedValueMinor: 0, rationale: 'dead card' } };
      },
      async execute(): Promise<ExecuteResult> {
        throw new Error('execute must not be called when the plan is comms');
      },
    };
    const res = await runRecoverySaga(port, rt, baseInput);
    expect(res.status).toBe('card_update_comms');
  });
});
