import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';

/**
 * Lift API bootstrap.
 *
 * IMPORTANT: the Stripe webhook route needs the RAW request body for signature
 * verification. Configure a raw-body parser for that path before enabling JSON
 * globally (see WebhooksController). TODO(lift): register rawBody + validation.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, process.env.API_HOST ?? '0.0.0.0');
  Logger.log(`Lift API listening on :${port}`, 'Bootstrap');
}

void bootstrap();
