import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { RecoveryModule } from '../recovery/recovery.module.js';

@Module({
  imports: [RecoveryModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
