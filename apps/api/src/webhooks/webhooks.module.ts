import { Module } from '@nestjs/common';
import { ConnectionRepository, applyMigrations, loadKeyFromEnv, openFromEnv } from '@ax10m/persistence';
import { WebhooksController } from './webhooks.controller.js';
import { WebhookRouterService } from './webhook-router.service.js';
import { RecoveryModule } from '../recovery/recovery.module.js';
import { RecoveryCaseService } from '../recovery/recovery-case.service.js';
import {
  DbMerchantConnectionStore,
  InMemoryMerchantConnectionStore,
  MERCHANT_CONNECTION_STORE,
  seedConnectionsFromEnv,
  type MerchantConnectionStore,
} from './merchant-connections.js';

/**
 * Build the connection store. With `DATABASE_URL` set → Postgres-backed store with
 * credentials encrypted at rest (@ax10m/persistence). Otherwise → in-memory, seeded
 * from env for single-tenant deployments (local dev / tests).
 */
async function buildConnectionStore(): Promise<MerchantConnectionStore> {
  if (process.env.DATABASE_URL) {
    const { db } = await openFromEnv();
    await applyMigrations(db);
    return new DbMerchantConnectionStore(new ConnectionRepository(db, loadKeyFromEnv()));
  }
  const store = new InMemoryMerchantConnectionStore();
  await seedConnectionsFromEnv(store);
  return store;
}

@Module({
  imports: [RecoveryModule],
  controllers: [WebhooksController],
  providers: [
    {
      provide: MERCHANT_CONNECTION_STORE,
      useFactory: (): Promise<MerchantConnectionStore> => buildConnectionStore(),
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
