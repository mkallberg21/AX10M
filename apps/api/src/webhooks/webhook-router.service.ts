/**
 * WebhookRouterService — per-merchant webhook routing.
 *
 * Resolves an inbound webhook to a merchant connection (by URL connection id, or the
 * single-tenant default for the processor), builds THAT merchant's adapter from its
 * stored credentials, and hands the raw payload to the recovery service for
 * verification + normalization. The merchant id comes from the resolved connection —
 * never from the webhook body — so a forged payload can't cross tenants.
 */

import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ProcessorAdapter, RawWebhook } from '@ax10m/poal';
import { buildAdapter } from '@ax10m/poal';
import { RecoveryCaseService } from '../recovery/recovery-case.service.js';
import {
  MERCHANT_CONNECTION_STORE,
  type MerchantConnection,
  type MerchantConnectionStore,
} from './merchant-connections.js';

/** Injectable builder seam (overridable in tests). */
export type AdapterBuilderFn = (processor: string, merchantId: string, config: MerchantConnection['config']) => ProcessorAdapter;

@Injectable()
export class WebhookRouterService {
  private readonly logger = new Logger(WebhookRouterService.name);

  constructor(
    private readonly recovery: RecoveryCaseService,
    @Inject(MERCHANT_CONNECTION_STORE) private readonly connections: MerchantConnectionStore,
    private readonly build: AdapterBuilderFn = buildAdapter,
  ) {}

  /**
   * Route a webhook. `connectionId` from the URL selects the tenant; when absent we
   * fall back to the processor's default connection (single-tenant deployments).
   */
  async ingest(processor: string, connectionId: string | null, raw: RawWebhook): Promise<void> {
    const conn = connectionId ? await this.connections.get(connectionId) : await this.connections.defaultFor(processor);
    if (!conn) {
      throw new NotFoundException(
        connectionId
          ? `Unknown connection '${connectionId}'.`
          : `No default connection configured for processor '${processor}'.`,
      );
    }
    // Guard against a URL that pairs the wrong processor with a connection id.
    if (conn.processor !== processor) {
      throw new BadRequestException(`Connection '${conn.connectionId}' is for '${conn.processor}', not '${processor}'.`);
    }

    const adapter = this.build(conn.processor, conn.merchantId, conn.config);
    this.logger.debug(`Routing ${processor} webhook → merchant ${conn.merchantId} (connection ${conn.connectionId})`);
    await this.recovery.ingestWithAdapter(adapter, raw);
  }
}
