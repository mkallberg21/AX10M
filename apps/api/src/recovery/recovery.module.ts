import { Module } from '@nestjs/common';
import { RecoveryCaseService } from './recovery-case.service.js';
import { OnboardingModule } from '../onboarding/onboarding.module.js';

@Module({
  imports: [OnboardingModule],
  providers: [RecoveryCaseService],
  exports: [RecoveryCaseService],
})
export class RecoveryModule {}
