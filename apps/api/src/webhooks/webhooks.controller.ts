import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
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
    // TODO(ax10m): resolve which merchant/adapter this webhook belongs to (by
    // Connect account / endpoint) and pass the correct StripeAdapter instance.
    await this.recovery.ingestStripeWebhook({
      body: raw,
      headers: { 'stripe-signature': signature ?? '' },
    });
    // Always 200 quickly; heavy work is enqueued. Reconciler catches anything missed.
    return { received: true };
  }

  /**
   * Chargebee webhook ingress (PROCESSORS.md §3). Chargebee authenticates its
   * webhooks with HTTP Basic auth (not a signature), which the adapter verifies
   * against the configured credentials before trusting the body.
   */
  @Post('chargebee')
  @HttpCode(200)
  async chargebee(
    @Req() req: RawBodyRequest<Request>,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<{ received: true }> {
    const raw = req.rawBody?.toString('utf8') ?? '';
    await this.recovery.ingestChargebeeWebhook({
      body: raw,
      headers: { authorization: authorization ?? '' },
    });
    return { received: true };
  }

  /**
   * Adyen notification ingress (PROCESSORS.md §3). Adyen signs each notification
   * item with HMAC (verified in the adapter), so no header auth is needed. Adyen
   * requires the literal `[accepted]` acknowledgement in the response body.
   */
  @Post('adyen')
  @HttpCode(200)
  async adyen(@Req() req: RawBodyRequest<Request>): Promise<string> {
    const raw = req.rawBody?.toString('utf8') ?? '';
    await this.recovery.ingestAdyenWebhook({ body: raw, headers: {} });
    return '[accepted]';
  }

  /**
   * Braintree webhook ingress (PROCESSORS.md §3). Braintree POSTs a form-encoded
   * bt_signature + bt_payload (base64 XML); the adapter verifies the HMAC-SHA1
   * signature before trusting the payload. (Endpoint verification uses a separate
   * GET bt_challenge handshake — TODO(ax10m).)
   */
  @Post('braintree')
  @HttpCode(200)
  async braintree(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    const raw = req.rawBody?.toString('utf8') ?? '';
    await this.recovery.ingestBraintreeWebhook({ body: raw, headers: {} });
    return { received: true };
  }

  /**
   * GoCardless webhook ingress (PROCESSORS.md §3, bank debit). GoCardless signs the
   * raw body with HMAC-SHA256 in the `Webhook-Signature` header; the adapter verifies
   * it before trusting the payload, and honors `retry_if_possible` to deconflict with
   * GoCardless's own Success+ retries.
   */
  @Post('gocardless')
  @HttpCode(200)
  async gocardless(
    @Req() req: RawBodyRequest<Request>,
    @Headers('webhook-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const raw = req.rawBody?.toString('utf8') ?? '';
    await this.recovery.ingestGoCardlessWebhook({
      body: raw,
      headers: { 'webhook-signature': signature ?? '' },
    });
    return { received: true };
  }
}
