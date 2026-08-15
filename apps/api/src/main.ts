import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { createRecoveryClient, readTemporalEnv } from '@ax10m/scheduler/temporal';
import { AppModule } from './app.module.js';
import { RecoveryCaseService } from './recovery/recovery-case.service.js';
import { TemporalRecoveryDispatcher } from './recovery/recovery-dispatcher.js';

/**
 * AX10M API bootstrap.
 *
 * IMPORTANT: the Stripe webhook route needs the RAW request body for signature
 * verification. Configure a raw-body parser for that path before enabling JSON
 * globally (see WebhooksController). TODO(ax10m): register rawBody + validation.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Opt-in durable dispatch: when AX10M_DURABLE_RECOVERY=true, treatment webhooks start a
  // Temporal workflow (hosted by the recovery worker) instead of only planning inline.
  // Non-fatal — if the cluster is unreachable the API still boots and falls back to inline.
  if (process.env.AX10M_DURABLE_RECOVERY === 'true') {
    const temporal = readTemporalEnv();
    try {
      const client = await createRecoveryClient(temporal.address);
      const dispatcher = new TemporalRecoveryDispatcher(client, temporal.taskQueue);
      app.get(RecoveryCaseService).enableDurableDispatch(dispatcher, { liveCharging: temporal.liveCharging });
      Logger.log(`Durable recovery dispatch ON → Temporal ${temporal.address} (liveCharging=${temporal.liveCharging})`, 'Bootstrap');
    } catch (err) {
      Logger.error(`Durable dispatch requested but Temporal is unreachable at ${temporal.address}; continuing inline. ${String(err)}`, 'Bootstrap');
    }
  }

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, process.env.API_HOST ?? '0.0.0.0');
  Logger.log(`AX10M API listening on :${port}`, 'Bootstrap');
}

void bootstrap();
