import { afterEach, describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller.js';
import { RecoveryCaseService } from '../recovery/recovery-case.service.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';

function newController(): { ctrl: AnalyticsController; svc: RecoveryCaseService } {
  const svc = new RecoveryCaseService(new OnboardingService());
  return { ctrl: new AnalyticsController(svc), svc };
}

describe('AnalyticsController (integration: seed → append → aggregate)', () => {
  afterEach(() => {
    delete process.env.AX10M_ALLOW_DEMO_SEED;
  });

  it('serves an empty but well-formed P&L from a fresh ledger', async () => {
    const { ctrl } = newController();
    const r = await ctrl.pnl();
    expect(r.cumulative.totals.recoveredMinor).toBe(0);
    expect(r.processors).toEqual([]);
    expect(r.dailySeries).toHaveLength(30);
  });

  it('refuses to seed unless AX10M_ALLOW_DEMO_SEED=true', async () => {
    const { ctrl } = newController();
    await expect(ctrl.seedDemo()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('seeds synthetic recoveries and then serves a populated per-MoR P&L', async () => {
    process.env.AX10M_ALLOW_DEMO_SEED = 'true';
    const { ctrl } = newController();

    const seed = await ctrl.seedDemo('45');
    expect(seed.seeded).toBeGreaterThan(0);

    const r = await ctrl.pnl();
    expect(r.cumulative.totals.recoveredMinor).toBeGreaterThan(0);
    expect(r.cumulative.totals.feeMinor).toBe(Math.round(r.cumulative.totals.recoveredMinor * 0.12));
    expect(r.processors.length).toBeGreaterThanOrEqual(4);
    expect(r.processors[0]!.processor).toBe('stripe'); // highest-weight MoR leads
    // every seeded entry is marked demo — spot-check via the ledger
    const entries = await ctrl['recovery'].ledgerEntries();
    expect(entries.every((e) => (e.detail as { demo?: boolean }).demo === true)).toBe(true);
  });
});
