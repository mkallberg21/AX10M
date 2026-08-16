import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { ReconcilerModule } from './reconciler/reconciler.module.js';
import { RecoveryModule } from './recovery/recovery.module.js';
import { OnboardingModule } from './onboarding/onboarding.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { BillingModule } from './billing/billing.module.js';

/**
 * Root module wiring the Phase-0 proof engine:
 *  - Webhooks: Stripe + Chargebee ingress → canonical events.
 *  - Reconciler: polling truth source (dual ingestion).
 *  - Recovery: wires POAL + attribution + guardrail into a RecoveryCase service.
 *  - Onboarding: shadow-first onboarding (connect → shadow → activate).
 *  - Health: liveness/readiness.
 */
@Module({
  imports: [HealthModule, WebhooksModule, ReconcilerModule, RecoveryModule, OnboardingModule, AnalyticsModule, BillingModule],
})
export class AppModule {}
