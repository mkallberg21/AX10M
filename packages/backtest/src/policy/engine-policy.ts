/**
 * The AX10M recovery engine as the treatment policy (Phase 1, Step C — wired in only
 * AFTER the world model and baseline were written).
 *
 * Two paths, both from the real engine:
 *   - FUNDS / TRANSIENT / soft declines → `planRetrySequence` (ARSE): decline-aware,
 *     network-capped retry cadence with the shipped trained recoverability model.
 *   - DEAD-CREDENTIAL declines (expired / lost / stolen / closed) → `planCredentialRecovery`:
 *     Account-Updater `card_refresh`, `alternate_rail` (backup method), and `dunning` —
 *     the recoveries a blanket retry on the original card cannot reach.
 *
 * Customer-history features are NEUTRAL cold priors (a backtest has no per-customer
 * history), so this is the engine's honest cold behavior on the observable facts.
 */

import { DeclineCode, type IssuerRegion } from '@ax10m/canonical';
import {
  BOOTSTRAP_RECOVERABILITY_WEIGHTS,
  isCredentialProblem,
  LogisticRecoverability,
  planCredentialRecovery,
  planRetrySequence,
  type CredentialAction,
  type RecoveryFeatures,
} from '@ax10m/recovery-engine';
import type { ActionKind } from '../world/world.js';
import type { ObservedInvoice, Policy, RecoveryAction } from './policy.js';

const NOW_ISO = '2020-01-01T00:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const DAY_MS = 86_400_000;

/** Map an engine credential action to a world action kind. */
function credKind(a: CredentialAction): ActionKind {
  return a === 'card_refresh' ? 'card_refresh' : a === 'alternate_rail' ? 'alternate_rail' : 'card_update';
}

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

    // Dead-credential declines → the credential-recovery sequence (AU / alt-rail / dunning).
    if (isCredentialProblem(features.declineCode)) {
      const steps = planCredentialRecovery(features, {
        now: NOW_ISO,
        // A default + a (possibly-absent) backup rail; the world decides if it exists.
        methods: [
          { ref: 'pm_primary', isDefault: true },
          { ref: 'pm_backup', isDefault: false },
        ],
      });
      return steps.map((s) => ({ day: (Date.parse(s.at) - NOW_MS) / DAY_MS, kind: credKind(s.action) }));
    }

    // Funds / transient / soft declines → ARSE retry cadence. `visa` (dominant network) so
    // the engine gets its full per-code cadence rather than the conservative `other` clamp.
    const steps = planRetrySequence(features, {
      now: NOW_ISO,
      network: 'visa',
      methods: [{ ref: 'pm_primary', isDefault: true }],
      model: this.model,
    });
    const actions: RecoveryAction[] = [];
    for (const s of steps) {
      if (s.action === 'suppress') continue;
      const day = (Date.parse(s.at) - NOW_MS) / DAY_MS;
      actions.push({ day, kind: s.action === 'card_update' ? 'card_update' : 'retry' });
    }
    return actions;
  }
}
