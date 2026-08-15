import { Module } from '@nestjs/common';
import { RecoveryCaseService } from './recovery-case.service.js';
import { buildLedgerPort } from './ledger-port.js';
import { OnboardingModule } from '../onboarding/onboarding.module.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';

/**
 * Provides the RecoveryCaseService. When a real Postgres is configured (`DATABASE_URL`),
 * the service is pointed at the SHARED persisted ledger so this API process and the
 * recovery worker append to one hash-chained chain (else the in-memory default).
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
        return service;
      },
      inject: [OnboardingService],
    },
  ],
  exports: [RecoveryCaseService],
})
export class RecoveryModule {}
