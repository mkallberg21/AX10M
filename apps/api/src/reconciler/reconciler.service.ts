import { Injectable, Logger } from '@nestjs/common';
import type { Cursor, ProcessorAdapter } from '@lift/poal';
import type { Invoice } from '@lift/canonical';

/**
 * Reconciliation poller — the truth source (ARCHITECTURE.md §4.1).
 *
 * Webhooks lie and drop. This service periodically polls each processor's open
 * failures and reconciles them against what we've already ingested, guaranteeing
 * we never miss or double-count a failure. It is also where exactly-once charging
 * is ultimately backstopped: any ambiguous charge is resolved here against the
 * processor's own record.
 *
 * Phase 0: stub. TODO(lift): schedule (cron/interval), persist cursors per
 * merchant, diff against ingested state, and enqueue recovery cases for gaps.
 */
@Injectable()
export class ReconcilerService {
  private readonly logger = new Logger(ReconcilerService.name);

  /** Poll one processor once, from a saved cursor. Returns invoices found. */
  async pollOnce(adapter: ProcessorAdapter, cursor: Cursor): Promise<Invoice[]> {
    const page = await adapter.listOpenFailures(cursor);
    // TODO(lift): for each invoice, upsert canonical state, detect failures not
    // seen via webhook, and reconcile charge outcomes for exactly-once safety.
    this.logger.debug(
      `Reconciler polled ${adapter.id}: ${page.invoices.length} open failures`,
    );
    return page.invoices;
  }

  /** TODO(lift): start the recurring reconciliation loop for all merchants. */
  startLoop(): void {
    this.logger.log('Reconciler loop not started (Phase 0 stub).');
  }
}
