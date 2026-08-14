import { Injectable, Logger } from '@nestjs/common';
import type { CanonicalEvent, Invoice, PaymentMethod } from '@lift/canonical';
import { familyOf } from '@lift/canonical';
import type { ProcessorAdapter, RawWebhook } from '@lift/poal';
import { idempotencyKey } from '@lift/poal';
import {
  assign,
  HashChainedLedger,
  type HoldoutConfig,
  type Stratum,
} from '@lift/attribution';
import {
  evaluate as evaluateGuardrail,
  type ProposedAction,
} from '@lift/guardrail';

/**
 * RecoveryCaseService — the integration seam of the Phase-0 proof engine.
 *
 * It wires the three domain packages together:
 *   1. POAL (@lift/poal)          — normalize webhooks, drive charges.
 *   2. Attribution (@lift/attribution) — holdout assignment + append to the ledger.
 *   3. Guardrail (@lift/guardrail) — hard-constraint gate before any action.
 *
 * Phase 0 is SHADOW MODE: we assign holdout buckets and record everything to the
 * ledger to compute *projected* uplift, but we do NOT execute charges. Flipping
 * to active (Phase 1) enables the `attemptCharge` path guarded below.
 *
 * Business logic is deliberately stubbed with TODO(lift) markers; the wiring,
 * types, and safety ordering (guardrail BEFORE execution) are real.
 */
@Injectable()
export class RecoveryCaseService {
  private readonly logger = new Logger(RecoveryCaseService.name);

  // TODO(lift): one ledger per merchant, persisted to append-only Postgres.
  private readonly ledger = new HashChainedLedger();

  // TODO(lift): inject per-environment holdout config from env / config service.
  private readonly holdoutConfig?: HoldoutConfig;

  /**
   * Entry point from the webhook controller. Verify + normalize, then process
   * each canonical event.
   */
  async ingestStripeWebhook(raw: RawWebhook): Promise<void> {
    // TODO(lift): resolve the correct per-merchant StripeAdapter and call
    // adapter.ingestWebhook(raw). For the scaffold we short-circuit to empty.
    this.logger.debug(`Received Stripe webhook (${raw.body.length} bytes)`);
    const events: CanonicalEvent[] = [];
    for (const event of events) {
      await this.handleEvent(event);
    }
  }

  private async handleEvent(event: CanonicalEvent): Promise<void> {
    // TODO(lift): route by event.type; on 'invoice.failed' open a recovery case.
    this.logger.debug(`Handling ${event.type} for ${event.merchantId}`);
  }

  /**
   * Open a recovery case for a failed invoice: assign a holdout bucket and record
   * it to the tamper-evident ledger. In shadow mode this is where measurement
   * begins; no charge is attempted.
   */
  openCase(params: {
    invoice: Invoice;
    stratum: Stratum;
    occurredAt: string;
  }): { bucket: 'control' | 'treatment' } {
    const { invoice, stratum } = params;
    const assignment = assign(
      {
        merchantId: invoice.merchantId,
        customerId: invoice.customerId,
        invoiceId: invoice.id,
        stratum,
      },
      this.holdoutConfig,
    );

    this.ledger.append({
      merchantId: invoice.merchantId,
      type: 'holdout.assigned',
      occurredAt: params.occurredAt,
      detail: {
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        bucket: assignment.bucket,
        stratumKey: assignment.stratumKey,
        amount: invoice.amount.amount,
        currency: invoice.amount.currency,
      },
    });

    return { bucket: assignment.bucket };
  }

  /**
   * Attempt (or, in shadow mode, simulate) a recovery charge — but ONLY after the
   * guardrail allows it. This ordering is the inviolable safety property: the
   * learned policy proposes, the guardrail disposes, execution never precedes it.
   */
  async attemptRecovery(params: {
    adapter: ProcessorAdapter;
    invoice: Invoice;
    method: PaymentMethod;
    proposed: ProposedAction;
    attemptNumber: number;
    shadow: boolean;
  }): Promise<'suppressed' | 'shadowed' | 'attempted'> {
    const decision = evaluateGuardrail(params.proposed);
    if (!decision.allow) {
      this.ledger.append({
        merchantId: params.invoice.merchantId,
        type: 'action.suppressed',
        occurredAt: new Date().toISOString(),
        detail: {
          invoiceId: params.invoice.id,
          reason: decision.reason,
          message: decision.message,
        },
      });
      this.logger.debug(`Suppressed: ${decision.reason}`);
      return 'suppressed';
    }

    // Sanity: the decline family the guardrail saw should match the taxonomy.
    void familyOf(params.proposed.declineCode);

    const key = idempotencyKey({
      merchantId: params.invoice.merchantId,
      invoiceId: params.invoice.id,
      paymentMethodId: params.method.id,
      attemptNumber: params.attemptNumber,
    });

    if (params.shadow) {
      // Shadow mode: record the intent, do NOT move money.
      this.ledger.append({
        merchantId: params.invoice.merchantId,
        type: 'charge.attempted',
        occurredAt: new Date().toISOString(),
        detail: { invoiceId: params.invoice.id, idempotencyKey: key, shadow: true },
      });
      return 'shadowed';
    }

    // TODO(lift): Phase 1 — execute inside a Temporal activity for durability +
    // exactly-once semantics, then record the outcome (succeeded/failed) to the
    // ledger and close the case on success.
    await params.adapter.attemptCharge(params.invoice, params.method, key);
    return 'attempted';
  }

  /** Expose the ledger head so callers can notarize / build statements. */
  ledgerHead(): string {
    return this.ledger.head();
  }
}
