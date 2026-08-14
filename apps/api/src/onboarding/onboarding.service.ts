import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DeclineCode } from '@ax10m/canonical';
import {
  activate,
  beginOnboarding,
  projectShadow,
  readiness,
  shadowProgress,
  DEFAULT_ONBOARDING_CONFIG,
  DEFAULT_PROJECTION_CONFIG,
  type OnboardingState,
  type Readiness,
  type ShadowObservation,
  type ShadowProgress,
  type ShadowProjection,
} from '@ax10m/onboarding';

/** The status view returned to the dashboard / onboarding UI. */
export interface OnboardingStatusView {
  state: OnboardingState;
  progress: ShadowProgress;
  projection: ShadowProjection;
  readiness: Readiness;
}

interface MerchantOnboarding {
  state: OnboardingState;
  /** invoiceId → observation, so a later invoice.paid can flip baselineRecovered. */
  observations: Map<string, ShadowObservation>;
}

/**
 * OnboardingService — shadow-first onboarding (ARCHITECTURE.md §6).
 *
 * On connect we enter SHADOW mode and start accumulating the merchant's baseline
 * failures/recoveries (fed by the webhook stream via RecoveryCaseService). The
 * status view exposes the projected uplift + would-be fee BEFORE activation — the
 * "see the money before you pay" moment — and gates `activate` on the shadow
 * window completing with a positive projection.
 *
 * TODO(ax10m): persist onboarding state + observations (Postgres); one instance
 * currently keeps them in memory.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);
  private readonly store = new Map<string, MerchantOnboarding>();

  connect(params: { merchantId: string; processor: string }): OnboardingStatusView {
    if (!params.merchantId || !params.processor) {
      throw new BadRequestException('merchantId and processor are required');
    }
    const now = new Date().toISOString();
    // TODO(ax10m): real OAuth token exchange + webhook registration with the processor.
    const state = beginOnboarding({ merchantId: params.merchantId, processor: params.processor, now });
    this.store.set(params.merchantId, { state, observations: new Map() });
    this.logger.log(`Onboarding ${params.merchantId} (${params.processor}) → shadow mode`);
    return this.buildStatus(params.merchantId, now);
  }

  /** Record a baseline failure observed during shadow (AX10M is NOT acting yet). */
  recordFailure(merchantId: string, params: { invoiceId: string; declineCode: DeclineCode; amount: number }): void {
    const m = this.store.get(merchantId);
    if (!m || m.state.status !== 'shadow') return;
    m.observations.set(params.invoiceId, {
      declineCode: params.declineCode,
      amount: params.amount,
      baselineRecovered: false,
    });
  }

  /** Mark that the merchant's baseline recovered an invoice during shadow. */
  recordBaselineRecovery(merchantId: string, invoiceId: string): void {
    const m = this.store.get(merchantId);
    if (!m || m.state.status !== 'shadow') return;
    const o = m.observations.get(invoiceId);
    if (o) o.baselineRecovered = true;
  }

  status(merchantId: string): OnboardingStatusView {
    return this.buildStatus(merchantId, new Date().toISOString());
  }

  /** Flip shadow → active. Idempotent; 400s with the blocking reasons if not ready. */
  activate(merchantId: string): OnboardingStatusView {
    const now = new Date().toISOString();
    const m = this.require(merchantId);
    if (m.state.status === 'active') return this.buildStatus(merchantId, now);
    const view = this.buildStatus(merchantId, now);
    if (!view.readiness.ready) {
      throw new BadRequestException(`Cannot activate: ${view.readiness.reasons.join('; ')}`);
    }
    m.state = activate({ state: m.state, readiness: view.readiness, now });
    this.logger.log(`Activated ${merchantId} → live holdout + engine`);
    return this.buildStatus(merchantId, now);
  }

  private buildStatus(merchantId: string, now: string): OnboardingStatusView {
    const m = this.require(merchantId);
    const progress = shadowProgress(m.state, now);
    const projection = projectShadow([...m.observations.values()], progress.elapsedDays, DEFAULT_PROJECTION_CONFIG);
    const ready = readiness(m.state, projection, progress, DEFAULT_ONBOARDING_CONFIG);
    return { state: m.state, progress, projection, readiness: ready };
  }

  private require(merchantId: string): MerchantOnboarding {
    const m = this.store.get(merchantId);
    if (!m) throw new NotFoundException(`No onboarding for merchant ${merchantId}`);
    return m;
  }
}
