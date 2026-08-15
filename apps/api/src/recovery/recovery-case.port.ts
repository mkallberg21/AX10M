/**
 * The bridge between the durable scheduler (@ax10m/scheduler) and the recovery-case
 * service. The scheduler's saga only ever sees a `RecoveryCasePort`; this maps its
 * plan/execute calls onto the service and translates the service's result into the
 * scheduler's vocabulary. Keeping the mapping here (not in the service) preserves the
 * dependency direction: the scheduler package never imports the API.
 */

import type { Invoice } from '@ax10m/canonical';
import type { ProcessorAdapter } from '@ax10m/poal';
import type {
  AttemptInput,
  ExecuteResult,
  ExecutedAction,
  PlanResult,
  RecoveryCasePort,
  RetryStep,
} from '@ax10m/scheduler';
import { RecoveryCaseService } from './recovery-case.service.js';

/** Resolve the processor adapter that owns a given invoice (per-merchant / processor). */
export type AdapterResolver = (invoice: Invoice) => ProcessorAdapter;

/**
 * Port implementation over the recovery-case service. One instance per case-run; the
 * `shadow` flag is fixed for the case (Phase 0 shadow vs Phase 1 active).
 */
export class ServiceRecoveryCasePort implements RecoveryCasePort {
  constructor(
    private readonly service: RecoveryCaseService,
    private readonly resolveAdapter: AdapterResolver,
    private readonly shadow: boolean,
  ) {}

  async plan(input: AttemptInput): Promise<PlanResult> {
    const decision = this.service.planAttempt({
      invoice: input.invoice,
      method: input.method,
      decline: input.decline,
      attemptNumber: input.attemptNumber,
    });
    return { decision };
  }

  async planSequence(input: AttemptInput): Promise<RetryStep[]> {
    return this.service.planSequence({
      invoice: input.invoice,
      method: input.method,
      decline: input.decline,
      attemptNumber: input.attemptNumber,
    });
  }

  async execute(input: AttemptInput): Promise<ExecuteResult> {
    const res = await this.service.executeRecovery({
      adapter: this.resolveAdapter(input.invoice),
      invoice: input.invoice,
      method: input.method,
      decline: input.decline,
      attemptNumber: input.attemptNumber,
      localHour: input.localHour,
      minutesSinceLastAttempt: input.minutesSinceLastAttempt,
      shadow: this.shadow,
    });
    return { action: mapAction(res.action), outcome: res.outcome, decision: res.decision };
  }
}

/** Translate the service's action vocabulary into the scheduler's `ExecutedAction`. */
function mapAction(
  action: 'card_update_comms' | 'suppress' | 'suppressed' | 'shadowed' | 'attempted',
): ExecutedAction {
  switch (action) {
    case 'attempted':
      return 'charged';
    case 'shadowed':
      return 'shadowed';
    case 'suppressed':
      return 'guardrail_suppressed';
    case 'suppress':
      return 'engine_suppressed';
    case 'card_update_comms':
      return 'card_update_comms';
  }
}
