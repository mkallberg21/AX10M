import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhookRouterService } from './webhook-router.service.js';

/**
 * Universal webhook ingress (ARCHITECTURE.md §4.1).
 *
 * Every processor posts to `/webhooks/:processor/:connectionId` (per-merchant) or
 * `/webhooks/:processor` (single-tenant default). The raw body is preserved for
 * signature verification; ALL headers are forwarded so each adapter can read whatever
 * signature header it uses. The router resolves the merchant + credentials and the
 * adapter verifies + normalizes. Adyen requires the literal `[accepted]` ack; every
 * other processor gets `{ received: true }`. We always answer 200 fast — the reconciler
 * catches anything missed.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly router: WebhookRouterService) {}

  @Post(':processor/:connectionId')
  @HttpCode(200)
  async perMerchant(
    @Param('processor') processor: string,
    @Param('connectionId') connectionId: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<string | { received: true }> {
    return this.dispatch(processor, connectionId, req);
  }

  @Post(':processor')
  @HttpCode(200)
  async singleTenant(
    @Param('processor') processor: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<string | { received: true }> {
    return this.dispatch(processor, null, req);
  }

  private async dispatch(
    processor: string,
    connectionId: string | null,
    req: RawBodyRequest<Request>,
  ): Promise<string | { received: true }> {
    const raw = { body: req.rawBody?.toString('utf8') ?? '', headers: flattenHeaders(req.headers) };
    await this.router.ingest(processor, connectionId, raw);
    return processor === 'adyen' ? '[accepted]' : { received: true };
  }
}

/** Express headers can be string | string[]; adapters expect Record<string,string>. */
function flattenHeaders(headers: Request['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(',');
  }
  return out;
}
