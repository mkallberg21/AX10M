import { describe, expect, it } from 'vitest';
import { DeclineCode } from '@lift/canonical';
import { projectShadow, type ShadowObservation } from './projection.js';
import {
  activate,
  beginOnboarding,
  pause,
  readiness,
  shadowProgress,
  startShadow,
  DEFAULT_ONBOARDING_CONFIG,
} from './lifecycle.js';

const START = '2026-08-01T00:00:00.000Z';
const plusDays = (n: number) => new Date(Date.parse(START) + n * 86_400_000).toISOString();

function projection(n: number, baselineRecovered = false) {
  const obs: ShadowObservation[] = Array.from({ length: n }, () => ({
    declineCode: DeclineCode.InsufficientFunds,
    amount: 10_000,
    baselineRecovered,
  }));
  return projectShadow(obs, 14);
}

describe('beginOnboarding / startShadow', () => {
  it('enters shadow immediately when webhooks are registered', () => {
    const s = beginOnboarding({ merchantId: 'm1', processor: 'chargebee', now: START });
    expect(s.status).toBe('shadow');
    expect(s.shadowStartedAt).toBe(START);
    expect(s.webhooksRegistered).toBe(true);
  });

  it('holds in connecting until webhooks are registered, then advances', () => {
    const s = beginOnboarding({ merchantId: 'm1', processor: 'chargebee', now: START, webhooksRegistered: false });
    expect(s.status).toBe('connecting');
    expect(s.shadowStartedAt).toBeUndefined();
    const s2 = startShadow(s, plusDays(0.01));
    expect(s2.status).toBe('shadow');
    expect(s2.webhooksRegistered).toBe(true);
  });
});

describe('shadowProgress', () => {
  const s = beginOnboarding({ merchantId: 'm1', processor: 'chargebee', now: START });

  it('reports elapsed/remaining and completion across the window', () => {
    const day7 = shadowProgress(s, plusDays(7));
    expect(day7.elapsedDays).toBeCloseTo(7, 5);
    expect(day7.remainingDays).toBeCloseTo(7, 5);
    expect(day7.windowComplete).toBe(false);
    expect(day7.pctComplete).toBeCloseTo(0.5, 5);

    const day14 = shadowProgress(s, plusDays(14));
    expect(day14.windowComplete).toBe(true);
    expect(day14.remainingDays).toBe(0);

    const day20 = shadowProgress(s, plusDays(20));
    expect(day20.pctComplete).toBe(1); // clamped
  });
});

describe('readiness & activate', () => {
  const state = beginOnboarding({ merchantId: 'm1', processor: 'chargebee', now: START });

  it('is not ready before the window completes', () => {
    const p = projection(300);
    const r = readiness(state, p, shadowProgress(state, plusDays(7)));
    expect(r.ready).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/window not complete/);
  });

  it('is not ready with too few observed failures', () => {
    const p = projection(50); // < 200 floor
    const r = readiness(state, p, shadowProgress(state, plusDays(14)));
    expect(r.ready).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/insufficient failures/);
  });

  it('is not ready with no positive projected uplift', () => {
    const p = projection(300, /*baselineRecovered*/ true); // baseline got everything → 0 uplift
    const r = readiness(state, p, shadowProgress(state, plusDays(14)));
    expect(r.ready).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/no positive projected uplift/);
  });

  it('is ready when the window is complete, enough failures, and positive uplift', () => {
    const p = projection(300);
    const r = readiness(state, p, shadowProgress(state, plusDays(14)));
    expect(r.ready).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });

  it('activates only when ready (or forced), and is idempotent once active', () => {
    const p = projection(300);
    const notReady = readiness(state, p, shadowProgress(state, plusDays(7)));
    expect(() => activate({ state, readiness: notReady, now: plusDays(7) })).toThrow(/cannot activate/);

    const forced = activate({ state, readiness: notReady, now: plusDays(7), force: true });
    expect(forced.status).toBe('active');
    expect(forced.activatedAt).toBe(plusDays(7));

    const ready = readiness(state, p, shadowProgress(state, plusDays(14)));
    const active = activate({ state, readiness: ready, now: plusDays(14) });
    expect(active.status).toBe('active');

    // Idempotent: activating an already-active state returns it unchanged.
    const again = activate({ state: active, readiness: ready, now: plusDays(20) });
    expect(again.activatedAt).toBe(plusDays(14));
  });

  it('pause moves to paused', () => {
    expect(pause(state).status).toBe('paused');
  });
});

describe('config', () => {
  it('defaults to a 14-day window and a 200-failure floor', () => {
    expect(DEFAULT_ONBOARDING_CONFIG.shadowWindowDays).toBe(14);
    expect(DEFAULT_ONBOARDING_CONFIG.minFailuresToActivate).toBe(200);
  });
});
