import { Injectable, Logger } from '@nestjs/common';
import type { CanonicalEvent, DeclineEvent, Invoice, MrrTier, PaymentMethod } from '@lift/canonical';
import { DeclineCode, DeclineFamily, familyOf } from '@lift/canonical';
import type { ProcessorAdapter, RawWebhook } from '@lift/poal';
import { AdyenAdapter, BraintreeAdapter, ChargebeeAdapter, GoCardlessAdapter, idempotencyKey } from '@lift/poal';
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
import { OnboardingService } from '../onboarding/onboarding.service.js';

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

  constructor(private readonly onboarding: OnboardingService) {}

  // TODO(lift): one ledger per merchant, persisted to append-only Postgres.
  private readonly ledger = new HashChainedLedger();

  // TODO(lift): inject per-environment holdout config from env / config service.
  private readonly holdoutConfig?: HoldoutConfig;

  private chargebee?: ChargebeeAdapter;
  private adyen?: AdyenAdapter;
  private braintree?: BraintreeAdapter;
  private gocardless?: GoCardlessAdapter;

  /**
   * Entry point from the webhook controller. Verify + normalize, then process
   * each canonical event.
   */
  async ingestStripeWebhook(raw: RawWebhook): Promise<void> {
    // TODO(lift): resolve the correct per-merchant StripeAdapter and call
    // ingestWithAdapter. For the scaffold the Stripe adapter's normalization is
    // still TODO, so this short-circuits.
    this.logger.debug(`Received Stripe webhook (${raw.body.length} bytes)`);
  }

  /** Chargebee ingress — the first fully-wired non-Stripe adapter (PROCESSORS.md §3). */
  async ingestChargebeeWebhook(raw: RawWebhook): Promise<void> {
    await this.ingestWithAdapter(this.chargebeeAdapter(), raw);
  }

  /** Adyen ingress (HMAC-verified notifications). */
  async ingestAdyenWebhook(raw: RawWebhook): Promise<void> {
    await this.ingestWithAdapter(this.adyenAdapter(), raw);
  }

  /** Braintree ingress (bt_signature-verified webhooks). */
  async ingestBraintreeWebhook(raw: RawWebhook): Promise<void> {
    await this.ingestWithAdapter(this.braintreeAdapter(), raw);
  }

  /** GoCardless ingress (Webhook-Signature-verified; bank debit). */
  async ingestGoCardlessWebhook(raw: RawWebhook): Promise<void> {
    await this.ingestWithAdapter(this.gocardlessAdapter(), raw);
  }

  /** Generic ingress: any adapter → canonical events → recovery cases. */
  async ingestWithAdapter(adapter: ProcessorAdapter, raw: RawWebhook): Promise<void> {
    const events = await adapter.ingestWebhook(raw);
    this.logger.debug(`${adapter.id}: normalized ${events.length} canonical event(s)`);
    for (const event of events) {
      await this.handleEvent(event);
    }
  }

  private chargebeeAdapter(): ChargebeeAdapter {
    if (this.chargebee) return this.chargebee;
    // TODO(lift): resolve the ChargebeeAdapter per merchant (by site / OAuth),
    // not from a single process-wide env. Restricted key only; never a PAN.
    this.chargebee = new ChargebeeAdapter({
      site: process.env.CHARGEBEE_SITE ?? '',
      apiKey: process.env.CHARGEBEE_API_KEY ?? '',
      merchantId: process.env.CHARGEBEE_MERCHANT_ID ?? 'mrc_unknown',
      webhookUser: process.env.CHARGEBEE_WEBHOOK_USER,
      webhookPassword: process.env.CHARGEBEE_WEBHOOK_PASSWORD,
    });
    return this.chargebee;
  }

  private adyenAdapter(): AdyenAdapter {
    if (this.adyen) return this.adyen;
    // TODO(lift): resolve the AdyenAdapter per merchant (by merchantAccount / OAuth).
    this.adyen = new AdyenAdapter({
      apiKey: process.env.ADYEN_API_KEY ?? '',
      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT ?? '',
      merchantId: process.env.ADYEN_MERCHANT_ID ?? 'mrc_unknown',
      hmacKey: process.env.ADYEN_HMAC_KEY,
      baseUrl: process.env.ADYEN_CHECKOUT_URL,
    });
    return this.adyen;
  }

  private braintreeAdapter(): BraintreeAdapter {
    if (this.braintree) return this.braintree;
    // TODO(lift): resolve the BraintreeAdapter per merchant.
    this.braintree = new BraintreeAdapter({
      merchantId: process.env.BRAINTREE_LIFT_MERCHANT_ID ?? 'mrc_unknown',
      braintreeMerchantId: process.env.BRAINTREE_MERCHANT_ID ?? '',
      publicKey: process.env.BRAINTREE_PUBLIC_KEY ?? '',
      privateKey: process.env.BRAINTREE_PRIVATE_KEY ?? '',
      environment: process.env.BRAINTREE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    });
    return this.braintree;
  }

  private gocardlessAdapter(): GoCardlessAdapter {
    if (this.gocardless) return this.gocardless;
    // TODO(lift): resolve the GoCardlessAdapter per merchant (by OAuth/organisation).
    this.gocardless = new GoCardlessAdapter({
      accessToken: process.env.GOCARDLESS_ACCESS_TOKEN ?? '',
      webhookSecret: process.env.GOCARDLESS_WEBHOOK_SECRET ?? '',
      merchantId: process.env.GOCARDLESS_MERCHANT_ID ?? 'mrc_unknown',
      environment: process.env.GOCARDLESS_ENVIRONMENT === 'live' ? 'live' : 'sandbox',
    });
    return this.gocardless;
  }

  private async handleEvent(event: CanonicalEvent): Promise<void> {
    if (event.type === 'invoice.failed') {
      const payload = event.payload as { invoice?: Invoice; decline?: DeclineEvent };
      if (payload.invoice) {
        const stratum = deriveStratum(payload.invoice, payload.decline);
        const { bucket } = this.openCase({ invoice: payload.invoice, stratum, occurredAt: event.occurredAt });
        // Feed the shadow-mode baseline measurement (no-op unless the merchant is onboarding).
        this.onboarding.recordFailure(payload.invoice.merchantId, {
          invoiceId: payload.invoice.id,
          declineCode: payload.decline?.code ?? DeclineCode.Unknown,
          amount: payload.invoice.amount.amount,
        });
        this.logger.debug(`Opened recovery case for ${payload.invoice.id} → ${bucket}`);
      }
      return;
    }
    if (event.type === 'invoice.paid') {
      const payload = event.payload as { invoice?: Invoice };
      if (payload.invoice) {
        // During shadow, a paid invoice is a BASELINE recovery (Lift isn't acting).
        this.onboarding.recordBaselineRecovery(payload.invoice.merchantId, payload.invoice.id);
      }
      return;
    }
    // TODO(lift): handle payment_method.updated (retry), subscription.updated (state sync).
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

/**
 * Derive a holdout stratum from a failed invoice + its decline. Scaffold-level:
 * MRR tier is proxied from the invoice amount and issuer region is unknown until
 * BIN metadata is joined. TODO(lift): use real MRR + issuer-region from the
 * subscription / payment-method BIN.
 */
function deriveStratum(invoice: Invoice, decline?: DeclineEvent): Stratum {
  return {
    mrrTier: mrrTierFromAmount(invoice.amount.amount),
    declineFamily: decline?.family ?? DeclineFamily.Gray,
    issuerRegion: 'unknown',
  };
}

/** Coarse MRR-tier bucket from an amount in minor units (proxy until real MRR is joined). */
function mrrTierFromAmount(minor: number): MrrTier {
  if (minor < 2_000) return 'micro'; // < $20
  if (minor < 10_000) return 'small'; // < $100
  if (minor < 50_000) return 'mid'; // < $500
  if (minor < 200_000) return 'large'; // < $2,000
  return 'enterprise';
}
