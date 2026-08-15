/**
 * The AX10M recovery engine as the treatment policy (Phase 1, Step C — wired in only
 * AFTER the world model and baseline were written).
 *
 * It calls the real `planRetrySequence` (ARSE) with the shipped trained recoverability
 * model, converts the planned ISO schedule into day-offsets, and maps engine actions to
 * world actions (`retry` / `card_update`; `suppress` → no action). Customer-history
 * features are NEUTRAL priors — a backtest has no per-customer history, so this is the
 * engine's honest COLD behavior on the observable decline + amount + region.
 */

import { DeclineCode, type IssuerRegion } from '@ax10m/canonical';
import {
  BOOTSTRAP_RECOVERABILITY_WEIGHTS,
  LogisticRecoverability,
  planRetrySequence,
  type RecoveryFeatures,
} from '@ax10m/recovery-engine';
import type { ObservedInvoice, Policy, RecoveryAction } from './policy.js';

const NOW_ISO = '2020-01-01T00:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

export class EnginePolicy implements Policy {
  readonly name = 'ax10m-engine';
  private readonly model = new LogisticRecoverability(BOOTSTRAP_RECOVERABILITY_WEIGHTS);

  plan(obs: ObservedInvoice): RecoveryAction[] {
    const features: RecoveryFeatures = {
      declineCode: obs.declineCode ?? DeclineCode.Unknown,
      amountMinor: obs.amountMinor,
      currency: 'USD',
      issuerRegion: obs.issuerRegion as IssuerRegion,
      // Neutral cold-start priors — no customer history exists in a backtest.
      customerTenureDays: 180,
      priorRecoveryRate: 0.35,
      attemptNumber: 1,
      daysSinceFirstFail: 0,
      issuerApprovalPrior: 0.5,
    };
    // `visa` (the dominant network) so the engine gets its full per-code cadence rather
    // than the conservative `other` 2-attempt clamp; documented in report.md.
    const steps = planRetrySequence(features, {
      now: NOW_ISO,
      network: 'visa',
      methods: [{ ref: 'pm_primary', isDefault: true }],
      model: this.model,
    });

    const actions: RecoveryAction[] = [];
    for (const s of steps) {
      if (s.action === 'suppress') continue;
      const day = (Date.parse(s.at) - NOW_MS) / 86_400_000;
      actions.push({ day, kind: s.action === 'card_update' ? 'card_update' : 'retry' });
    }
    return actions;
  }
}
