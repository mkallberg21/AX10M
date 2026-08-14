import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { OnboardingService, type OnboardingStatusView } from './onboarding.service.js';

/**
 * Onboarding API (ARCHITECTURE.md §6). The zero-code, shadow-first flow:
 *   POST /onboarding/connect            → OAuth done, enter shadow, start measuring
 *   GET  /onboarding/:merchantId/status → projected uplift + would-be fee + progress
 *   POST /onboarding/:merchantId/activate → flip to the live holdout + engine
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post('connect')
  @HttpCode(200)
  connect(@Body() body: { merchantId: string; processor: string }): OnboardingStatusView {
    return this.onboarding.connect({ merchantId: body?.merchantId, processor: body?.processor });
  }

  @Get(':merchantId/status')
  status(@Param('merchantId') merchantId: string): OnboardingStatusView {
    return this.onboarding.status(merchantId);
  }

  @Post(':merchantId/activate')
  @HttpCode(200)
  activate(@Param('merchantId') merchantId: string): OnboardingStatusView {
    return this.onboarding.activate(merchantId);
  }
}
