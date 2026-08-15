import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { WebhookRouterService } from './webhook-router.service.js';
import { RecoveryModule } from '../recovery/recovery.module.js';
import { RecoveryCaseService } from '../recovery/recovery-case.service.js';
import {
  buildConnectionStore,
  MERCHANT_CONNECTION_STORE,
  type MerchantConnectionStore,
} from './merchant-connections.js';

@Module({
  imports: [RecoveryModule],
  controllers: [WebhooksController],
  providers: [
    {
      provide: MERCHANT_CONNECTION_STORE,
      useFactory: (): Promise<MerchantConnectionStore> => buildConnectionStore(process.env),
    },
    {
      provide: WebhookRouterService,
      useFactory: (recovery: RecoveryCaseService, store: MerchantConnectionStore) => new WebhookRouterService(recovery, store),
      inject: [RecoveryCaseService, MERCHANT_CONNECTION_STORE],
    },
  ],
  exports: [MERCHANT_CONNECTION_STORE],
})
export class WebhooksModule {}
