import { Module } from '@nestjs/common';
import { RecoveryCaseService } from './recovery-case.service.js';
import { buildLedgerPort } from './ledger-port.js';
import { buildCredentialAttemptStore } from './credential-attempt-store.js';
import { buildFeatureStore } from './feature-store-builder.js';
import { buildDunningComms } from './dunning-comms-builder.js';
import { buildSendDedupeStore } from './send-dedupe-store.js';
import { buildBanditStateStore } from './bandit-store.js';
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
        // Opt-in: enable the fully-learned LinUCB contextual-bandit policy (online learning) when
        // AX10M_BANDIT_POLICY=true. Off by default → the fixed cost/compliance-aware objective. When
        // a DB is configured, wire the shared persisted flywheel state and load it at startup so
        // learning pools across every merchant + the API/worker + restarts.
        if (process.env.AX10M_BANDIT_POLICY === 'true') {
          service.useBanditPolicy();
          const banditStore = await buildBanditStateStore(process.env);
          if (banditStore) {
            service.useBanditStore(banditStore);
            await service.loadBanditState();
          }
        }
        const { agent, config, sender, live } = buildDunningComms(process.env);
        service.useDunningAgent(agent, config);
        if (sender) service.useDunningSender(sender, { live });
        const sendDedupe = await buildSendDedupeStore(process.env);
        if (sendDedupe) service.useSendDedupeStore(sendDedupe);
        return service;
      },
      inject: [OnboardingService],
    },
  ],
  exports: [RecoveryCaseService],
})
export class RecoveryModule {}
