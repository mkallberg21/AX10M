/**
 * Onboarding lifecycle (ARCHITECTURE.md §6).
 *
 * The plug-and-play path: OAuth connect → 14-day SHADOW window (measure the true
 * baseline, project uplift, touch nothing) → the merchant sees the projected money
 * and the would-be fee → one toggle flips to ACTIVE (the live holdout + engine).
 *
 *   connecting → shadow → active
 *                  └────→ paused ←──┘
 *
 * All functions are pure and take an explicit `now` (ISO) — no wall-clock reads —
 * so state transitions are deterministic and reproducible.
 */

import type { ShadowProjection } from './projection.js';

export type OnboardingStatus = 'connecting' | 'shadow' | 'active' | 'paused';

export interface OnboardingState {
  merchantId: string;
  processor: string;
  status: OnboardingStatus;
  connectedAt: string;
  shadowStartedAt?: string;
  activatedAt?: string;
  /** Length of the shadow measurement window in days. */
  shadowWindowDays: number;
  /** Whether AX10M has registered webhooks with the processor (zero-code setup). */
  webhooksRegistered: boolean;
}

export interface OnboardingConfig {
  shadowWindowDays: number;
  /** Minimum observed failures before activation is allowed (statistical floor). */
  minFailuresToActivate: number;
}

export const DEFAULT_ONBOARDING_CONFIG: OnboardingConfig = {
  shadowWindowDays: 14,
  minFailuresToActivate: 200,
};

const MS_PER_DAY = 86_400_000;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / MS_PER_DAY);
}

/**
 * Begin onboarding. OAuth has completed and webhooks are registered, so we enter
 * SHADOW immediately and start measuring the baseline. (A caller that wants to
 * model the pre-webhook handshake can pass `webhooksRegistered: false` and hold in
 * `connecting`; `startShadow` then advances it.)
 */
export function beginOnboarding(params: {
  merchantId: string;
  processor: string;
  now: string;
  webhooksRegistered?: boolean;
  config?: OnboardingConfig;
}): OnboardingState {
  const config = params.config ?? DEFAULT_ONBOARDING_CONFIG;
  const registered = params.webhooksRegistered ?? true;
  return {
    merchantId: params.merchantId,
    processor: params.processor,
    status: registered ? 'shadow' : 'connecting',
    connectedAt: params.now,
    shadowStartedAt: registered ? params.now : undefined,
    shadowWindowDays: config.shadowWindowDays,
    webhooksRegistered: registered,
  };
}

/** Advance a `connecting` merchant into `shadow` once webhooks are registered. */
export function startShadow(state: OnboardingState, now: string): OnboardingState {
  if (state.status !== 'connecting') return state;
  return { ...state, status: 'shadow', webhooksRegistered: true, shadowStartedAt: now };
}

export interface ShadowProgress {
  elapsedDays: number;
  remainingDays: number;
  windowComplete: boolean;
  /** 0..1 fraction of the shadow window elapsed. */
  pctComplete: number;
}

export function shadowProgress(state: OnboardingState, now: string): ShadowProgress {
  const start = state.shadowStartedAt;
  if (!start) return { elapsedDays: 0, remainingDays: state.shadowWindowDays, windowComplete: false, pctComplete: 0 };
  const elapsed = daysBetween(start, now);
  const remaining = Math.max(0, state.shadowWindowDays - elapsed);
  return {
    elapsedDays: elapsed,
    remainingDays: remaining,
    windowComplete: elapsed >= state.shadowWindowDays,
    pctComplete: Math.min(1, state.shadowWindowDays > 0 ? elapsed / state.shadowWindowDays : 1),
  };
}

export interface Readiness {
  ready: boolean;
  reasons: string[];
}

/**
 * Whether the merchant can activate. Gated on: shadow window complete, enough
 * failures observed for a meaningful measurement, and a positive projected uplift.
 */
export function readiness(
  state: OnboardingState,
  projection: ShadowProjection,
  progress: ShadowProgress,
  config: OnboardingConfig = DEFAULT_ONBOARDING_CONFIG,
): Readiness {
  const reasons: string[] = [];
  if (state.status === 'active') return { ready: false, reasons: ['already active'] };
  if (state.status === 'paused') reasons.push('onboarding paused');
  if (!progress.windowComplete) {
    reasons.push(`shadow window not complete (${progress.elapsedDays.toFixed(1)}/${state.shadowWindowDays} days)`);
  }
  if (projection.observedFailures < config.minFailuresToActivate) {
    reasons.push(`insufficient failures observed (${projection.observedFailures}/${config.minFailuresToActivate})`);
  }
  if (projection.projectedMonthlyValue.amount <= 0) {
    reasons.push('no positive projected uplift');
  }
  return { ready: reasons.length === 0, reasons };
}

/**
 * Flip to ACTIVE — the live holdout + engine begin. Guarded by `readiness`;
 * throws if not ready. Idempotent once active. Early activation (before the window
 * completes) is allowed only via `force` — the caller owns that risk.
 */
export function activate(params: {
  state: OnboardingState;
  readiness: Readiness;
  now: string;
  force?: boolean;
}): OnboardingState {
  const { state } = params;
  if (state.status === 'active') return state;
  if (!params.readiness.ready && !params.force) {
    throw new Error(`cannot activate: ${params.readiness.reasons.join('; ')}`);
  }
  return { ...state, status: 'active', activatedAt: params.now };
}

/** Pause onboarding/measurement (e.g. SRM breach, merchant request). */
export function pause(state: OnboardingState): OnboardingState {
  return { ...state, status: 'paused' };
}
