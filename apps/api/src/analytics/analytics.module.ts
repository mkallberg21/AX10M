import { Module } from '@nestjs/common';
import { RecoveryModule } from '../recovery/recovery.module.js';
import { AnalyticsController } from './analytics.controller.js';

/** Exposes the live P&L view; reuses the shared RecoveryCaseService (and its ledger). */
@Module({
  imports: [RecoveryModule],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
