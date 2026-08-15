import { describe, expect, it } from 'vitest';
import { DeclineCode } from '@ax10m/canonical';
import { isCredentialProblem, planCredentialRecovery } from './credential-recovery.js';
import type { RecoveryFeatures } from './recoverability.js';

const features = (code: DeclineCode): RecoveryFeatures => ({
  declineCode: code,
  amountMinor: 4900,
  currency: 'USD',
  issuerRegion: 'na',
  customerTenureDays: 180,
  priorRecoveryRate: 0.35,
  attemptNumber: 1,
  daysSinceFirstFail: 0,
  issuerApprovalPrior: 0.5,
});

const ctx = { now: '2020-01-01T00:00:00.000Z', methods: [{ ref: 'pm_primary', isDefault: true }, { ref: 'pm_backup', isDefault: false }] };

describe('credential recovery (the dead-card overlay edge)', () => {
  it('targets dead-credential declines, not funds/transient ones', () => {
    expect(isCredentialProblem(DeclineCode.ExpiredCard)).toBe(true);
    expect(isCredentialProblem(DeclineCode.LostCard)).toBe(true);
    expect(isCredentialProblem(DeclineCode.ClosedAccount)).toBe(true);
    expect(isCredentialProblem(DeclineCode.InsufficientFunds)).toBe(false);
    expect(isCredentialProblem(DeclineCode.DoNotHonor)).toBe(false);
    expect(isCredentialProblem(DeclineCode.Fraudulent)).toBe(false); // never chase fraud
  });

  it('plans nothing for a funds decline (those go through ARSE retries)', () => {
    expect(planCredentialRecovery(features(DeclineCode.InsufficientFunds), ctx)).toEqual([]);
  });

  it('plans Account-Updater probes across the reissue window + alt-rail + dunning for an expired card', () => {
    const steps = planCredentialRecovery(features(DeclineCode.ExpiredCard), ctx);
    const kinds = steps.map((s) => s.action);
    expect(kinds).toContain('card_refresh');
    expect(kinds).toContain('alternate_rail');
    expect(kinds).toContain('dunning');
    // The alt-rail step carries the discovered backup method ref.
    expect(steps.find((s) => s.action === 'alternate_rail')?.methodRef).toBe('pm_backup');
    // Account-Updater probes reach into the 3–4 week reissue window (not all front-loaded).
    const refreshDays = steps.filter((s) => s.action === 'card_refresh').map((s) => (Date.parse(s.at) - Date.parse(ctx.now)) / 86_400_000);
    expect(Math.max(...refreshDays)).toBeGreaterThanOrEqual(28);
    // Steps are time-ordered.
    const ts = steps.map((s) => Date.parse(s.at));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });
});
