import {
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { RecoveryCaseService } from '../recovery/recovery-case.service.js';

/**
 * Stripe webhook ingress (ARCHITECTURE.md §4.1).
 *
 * The raw body is required for signature verification — do NOT let a JSON parser
 * consume it first. The adapter verifies the signature, normalizes to canonical
 * events, and hands them to the recovery-case service.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly recovery: RecoveryCaseService) {}

  @Post('stripe')
  @HttpCode(200)
  async stripe(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const raw = req.rawBody?.toString('utf8') ?? '';
    // TODO(lift): resolve which merchant/adapter this webhook belongs to (by
    // Connect account / endpoint) and pass the correct StripeAdapter instance.
    await this.recovery.ingestStripeWebhook({
      body: raw,
      headers: { 'stripe-signature': signature ?? '' },
    });
    // Always 200 quickly; heavy work is enqueued. Reconciler catches anything missed.
    return { received: true };
  }
}
