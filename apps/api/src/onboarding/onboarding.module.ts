import { Module } from '@nestjs/common';
import { OnboardingService } from './onboarding.service.js';
import { OnboardingController } from './onboarding.controller.js';

@Module({
  providers: [OnboardingService],
  controllers: [OnboardingController],
  exports: [OnboardingService],
})
export class OnboardingModule {}
