import { describe, expect, it } from 'vitest';
import type { RecoveryDecision } from '@ax10m/recovery-engine';
import { DEFAULT_SCHEDULER_CONFIG } from './config.js';
import { planStep, postExecuteStep } from './saga.js';
import type { ExecuteResult } from './types.js';

const NOW = '2026-08-14T12:00:00.000Z';

function decision(over: Partial<RecoveryDecision>): RecoveryDecision {
  return {
    action: 'retry',
    recoverabilityScore: 0.6,
    expectedValueMinor: 1000,
    rationale: 'test',
    ...over,
  };
}

describe('planStep', () => {
  it('sleeps until a future retryAt', () => {
    const step = planStep(decision({ retryAt: '2026-08-15T12:00:00.000Z' }), NOW, DEFAULT_SCHEDULER_CONFIG);
    expect(step).toEqual({ kind: 'sleep_then_execute', until: '2026-08-15T12:00:00.000Z' });
  });

  it('executes now when retryAt is already in the past', () => {
    const step = planStep(decision({ retryAt: '2026-08-14T11:00:00.000Z' }), NOW, DEFAULT_SCHEDULER_CONFIG);
    expect(step).toEqual({ kind: 'execute_now' });
  });

  it('never hot-loops: backs off a fallback gap when retryAt is missing', () => {
    const step = planStep(decision({ retryAt: undefined }), NOW, DEFAULT_SCHEDULER_CONFIG);
    expect(step.kind).toBe('sleep_then_execute');
    if (step.kind === 'sleep_then_execute') {
      expect(step.until).toBe('2026-08-14T13:00:00.000Z'); // +60m default
    }
  });

  it('stops (no charge) when the engine routes to card-update comms', () => {
    const step = planStep(decision({ action: 'card_update_comms' }), NOW, DEFAULT_SCHEDULER_CONFIG);
    expect(step).toEqual({ kind: 'stop', reason: 'card_update_comms' });
  });

  it('stops when the engine suppresses', () => {
    const step = planStep(decision({ action: 'suppress' }), NOW, DEFAULT_SCHEDULER_CONFIG);
    expect(step).toEqual({ kind: 'stop', reason: 'engine_suppressed' });
  });
});

describe('postExecuteStep', () => {
  const charged = (outcome: ExecuteResult['outcome']): ExecuteResult => ({
    action: 'charged',
    outcome,
    decision: decision({}),
  });

  it('stops recovered on a successful charge', () => {
    expect(postExecuteStep(charged('succeeded'), 1, DEFAULT_SCHEDULER_CONFIG)).toEqual({
      kind: 'stop',
      reason: 'recovered',
    });
  });

  it('schedules the next attempt on a failed charge', () => {
    expect(postExecuteStep(charged('failed'), 1, DEFAULT_SCHEDULER_CONFIG)).toEqual({
      kind: 'retry',
      nextAttemptNumber: 2,
    });
  });

  it('stops exhausted at the max-attempts ceiling', () => {
    const cfg = { ...DEFAULT_SCHEDULER_CONFIG, maxAttempts: 3 };
    expect(postExecuteStep(charged('failed'), 3, cfg)).toEqual({ kind: 'stop', reason: 'exhausted' });
  });

  it('awaits settlement on a pending (co-drive) charge', () => {
    expect(postExecuteStep(charged('pending'), 1, DEFAULT_SCHEDULER_CONFIG)).toEqual({ kind: 'await_settlement' });
  });

  it('stops shadow_complete in shadow mode', () => {
    const r: ExecuteResult = { action: 'shadowed', decision: decision({}) };
    expect(postExecuteStep(r, 1, DEFAULT_SCHEDULER_CONFIG)).toEqual({ kind: 'stop', reason: 'shadow_complete' });
  });

  it('stops guardrail_suppressed when the guardrail vetoes', () => {
    const r: ExecuteResult = { action: 'guardrail_suppressed', decision: decision({}) };
    expect(postExecuteStep(r, 2, DEFAULT_SCHEDULER_CONFIG)).toEqual({ kind: 'stop', reason: 'guardrail_suppressed' });
  });
});
