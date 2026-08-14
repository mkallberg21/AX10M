import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { WebhookRouterService } from './webhook-router.service.js';
import { RecoveryModule } from '../recovery/recovery.module.js';
import { RecoveryCaseService } from '../recovery/recovery-case.service.js';
import {
  InMemoryMerchantConnectionStore,
  MERCHANT_CONNECTION_STORE,
  seedConnectionsFromEnv,
  type MerchantConnectionStore,
} from './merchant-connections.js';

@Module({
  imports: [RecoveryModule],
  controllers: [WebhooksController],
  providers: [
    {
      // The per-merchant connection registry, seeded from env for single-tenant
      // deployments. TODO(ax10m): back with encrypted Postgres + an admin API to
      // register connections as merchants onboard.
      provide: MERCHANT_CONNECTION_STORE,
      useFactory: (): MerchantConnectionStore => {
        const store = new InMemoryMerchantConnectionStore();
        seedConnectionsFromEnv(store);
        return store;
      },
    },
    {
      provide: WebhookRouterService,
      useFactory: (recovery: RecoveryCaseService, store: MerchantConnectionStore) =>
        new WebhookRouterService(recovery, store),
      inject: [RecoveryCaseService, MERCHANT_CONNECTION_STORE],
    },
  ],
  exports: [MERCHANT_CONNECTION_STORE],
})
export class WebhooksModule {}
