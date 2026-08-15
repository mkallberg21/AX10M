import { Module } from '@nestjs/common';
import { RecoveryCaseService } from './recovery-case.service.js';
import { buildLedgerPort } from './ledger-port.js';
import { buildCredentialAttemptStore } from './credential-attempt-store.js';
import { buildFeatureStore } from './feature-store-builder.js';
import { loadActiveChampion } from './retrain-job.js';
import { OnboardingModule } from '../onboarding/onboarding.module.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';

/**
 * Provides the RecoveryCaseService. When a real Postgres is configured (`DATABASE_URL`),
 * the service is pointed at the SHARED persisted ledger so this API process and the
 * recovery worker append to one hash-chained chain (else the in-memory default), and it
 * loads the active retrained champion from the model store (else the bootstrap prior).
 */
@Module({
  imports: [OnboardingModule],
  providers: [
    {
      provide: RecoveryCaseService,
      useFactory: async (onboarding: OnboardingService): Promise<RecoveryCaseService> => {
        const service = new RecoveryCaseService(onboarding);
        const ledger = await buildLedgerPort(process.env);
        if (ledger) service.useLedger(ledger);
        const credentialAttempts = await buildCredentialAttemptStore(process.env);
        if (credentialAttempts) service.useCredentialAttempts(credentialAttempts);
        const featureStore = buildFeatureStore(process.env);
        if (featureStore) service.useFeatureStore(featureStore);
        const champion = await loadActiveChampion({ env: process.env });
        if (champion) service.useChampion(champion);
        return service;
      },
      inject: [OnboardingService],
    },
  ],
  exports: [RecoveryCaseService],
})
export class RecoveryModule {}
