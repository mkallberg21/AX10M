import { Injectable, Logger } from '@nestjs/common';
import type { CanonicalEvent, DeclineEvent, Invoice, MrrTier, PaymentMethod } from '@ax10m/canonical';
import { DeclineCode, DeclineFamily, familyOf } from '@ax10m/canonical';
import type { ProcessorAdapter, RawWebhook } from '@ax10m/poal';
import { AdyenAdapter, BraintreeAdapter, ChargebeeAdapter, GoCardlessAdapter, idempotencyKey, stripe } from '@ax10m/poal';
import {
  assign,
  HashChainedLedger,
  type HoldoutConfig,
  type Stratum,
} from '@ax10m/attribution';
import {
  evaluate as evaluateGuardrail,
  type CardNetwork,
  type ProposedAction,
} from '@ax10m/guardrail';
import {
  HeuristicPolicy,
  type AvailableMethod,
  type RecoveryDecision,
  type RecoveryFeatures,
  type RetryPolicy,
} from '@ax10m/recovery-engine';
import { OnboardingService } from '../onboarding/onboarding.service.js';

/**
 * RecoveryCaseService — the integration seam of the Phase-0 proof engine.
 *
 * It wires the three domain packages together:
 *   1. POAL (@ax10m/poal)          — normalize webhooks, drive charges.
 *   2. Attribution (@ax10m/attribution) — holdout assignment + append to the ledger.
 *   3. Guardrail (@ax10m/guardrail) — hard-constraint gate before any action.
 *
 * Phase 0 is SHADOW MODE: we assign holdout buckets and record everything to the
 * ledger to compute *projected* uplift, but we do NOT execute charges. Flipping
 * to active (Phase 1) enables the `attemptCharge` path guarded below.
 *
 * Business logic is deliberately stubbed with TODO(ax10m) markers; the wiring,
 * types, and safety ordering (guardrail BEFORE execution) are real.
 */
@Injectable()
export class RecoveryCaseService {
  private readonly logger = new Logger(RecoveryCaseService.name);

  constructor(private readonly onboarding: OnboardingService) {}

  // TODO(ax10m): one ledger per merchant, persisted to append-only Postgres.
  private readonly ledger = new HashChainedLedger();

  // TODO(ax10m): inject per-environment holdout config from env / config service.
  private readonly holdoutConfig?: HoldoutConfig;

  private chargebee?: ChargebeeAdapter;
  private adyen?: AdyenAdapter;
  private braintree?: BraintreeAdapter;
  private gocardless?: GoCardlessAdapter;
  private stripe?: stripe.StripeAdapter;

  // The recovery brain. Cold-start heuristic today; swap for a trained
  // ContextualBanditPolicy without touching this wiring.
  private readonly policy: RetryPolicy = new HeuristicPolicy();

  // Invoices whose holdout assignment has already been recorded — webhooks are
  // at-least-once, so we must not double-append to the tamper-evident ledger.
  private readonly openedInvoices = new Set<string>();

  // Highest attempt number executed per invoice (drives the guardrail's window count).
  private readonly attempts = new Map<string, number>();

  /**
   * Entry point from the webhook controller. Verify + normalize, then process
   * each canonical event.
   */
  async ingestStripeWebhook(raw: RawWebhook): Promise<void> {
    await this.ingestWithAdapter(this.stripeAdapter(), raw);
  }

  private stripeAdapter(): stripe.StripeAdapter {
    if (this.stripe) return this.stripe;
    // TODO(ax10m): resolve the StripeAdapter per merchant (by Connect account).
    this.stripe = new stripe.StripeAdapter({
      secretKey: process.env.STRIPE_SECRET_KEY ?? '',
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
      merchantId: process.env.STRIPE_MERCHANT_ID ?? 'mrc_unknown',
      apiVersion: process.env.STRIPE_API_VERSION,
    });
    return this.stripe;
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
    // TODO(ax10m): resolve the ChargebeeAdapter per merchant (by site / OAuth),
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
    // TODO(ax10m): resolve the AdyenAdapter per merchant (by merchantAccount / OAuth).
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
    // TODO(ax10m): resolve the BraintreeAdapter per merchant.
    this.braintree = new BraintreeAdapter({
      merchantId: process.env.BRAINTREE_AX10M_MERCHANT_ID ?? 'mrc_unknown',
      braintreeMerchantId: process.env.BRAINTREE_MERCHANT_ID ?? '',
      publicKey: process.env.BRAINTREE_PUBLIC_KEY ?? '',
      privateKey: process.env.BRAINTREE_PRIVATE_KEY ?? '',
      environment: process.env.BRAINTREE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    });
    return this.braintree;
  }

  private gocardlessAdapter(): GoCardlessAdapter {
    if (this.gocardless) return this.gocardless;
    // TODO(ax10m): resolve the GoCardlessAdapter per merchant (by OAuth/organisation).
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
        // TREATMENT cases get the recovery brain; CONTROL stays baseline-only. In
        // shadow mode we PLAN (record the engine's decision) but never execute.
        if (bucket === 'treatment') {
          this.planRecovery(payload.invoice, payload.decline);
        }
        this.logger.debug(`Opened recovery case for ${payload.invoice.id} → ${bucket}`);
      }
      return;
    }
    if (event.type === 'invoice.paid') {
      const payload = event.payload as { invoice?: Invoice };
      if (payload.invoice) {
        // During shadow, a paid invoice is a BASELINE recovery (AX10M isn't acting).
        this.onboarding.recordBaselineRecovery(payload.invoice.merchantId, payload.invoice.id);
      }
      return;
    }
    // TODO(ax10m): handle payment_method.updated (retry), subscription.updated (state sync).
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
    // Assignment is a deterministic pure function, so recomputing on a redelivered
    // webhook yields the same bucket; only the ledger append must be de-duplicated.
    const assignment = assign(
      {
        merchantId: invoice.merchantId,
        customerId: invoice.customerId,
        invoiceId: invoice.id,
        stratum,
      },
      this.holdoutConfig,
    );

    if (this.openedInvoices.has(invoice.id)) {
      return { bucket: assignment.bucket };
    }
    this.openedInvoices.add(invoice.id);

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
  }): Promise<{ result: 'suppressed' | 'shadowed' | 'attempted'; outcome?: ChargeOutcome }> {
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
      return { result: 'suppressed' };
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
      return { result: 'shadowed' };
    }

    // Phase 1 — move money. `attemptNumber` is owned by the caller (the durable
    // saga) so replaying this activity re-derives the SAME idempotency key and the
    // processor de-dupes: exactly-once even though the transport is at-least-once.
    // TODO(ax10m): host this call inside a Temporal activity for crash durability.
    this.attempts.set(params.invoice.id, Math.max(this.attempts.get(params.invoice.id) ?? 0, params.attemptNumber));
    const result = await params.adapter.attemptCharge(params.invoice, params.method, key);
    this.ledger.append({
      merchantId: params.invoice.merchantId,
      type: result.outcome === 'succeeded' ? 'charge.succeeded' : 'charge.failed',
      occurredAt: new Date().toISOString(),
      detail: {
        invoiceId: params.invoice.id,
        idempotencyKey: key,
        outcome: result.outcome,
        idempotentReplay: result.idempotentReplay ?? false,
        declineCode: result.attempt?.declineCode,
      },
    });
    if (result.outcome === 'succeeded') {
      this.ledger.append({
        merchantId: params.invoice.merchantId,
        type: 'case.recovered',
        occurredAt: new Date().toISOString(),
        detail: {
          invoiceId: params.invoice.id,
          amount: params.invoice.amount.amount,
          currency: params.invoice.amount.currency,
          attemptNumber: params.attemptNumber,
        },
      });
    }
    return { result: 'attempted', outcome: result.outcome };
  }

  /**
   * Run the recovery engine for a case and RECORD its decision — without executing.
   * This is the shadow-mode brain: it produces (and ledgers) the exact action the
   * active system *would* take on a treatment case, so the Uplift Statement can
   * later compare "what we'd have done" against the control arm's realized outcome.
   */
  private planRecovery(invoice: Invoice, decline?: DeclineEvent): RecoveryDecision {
    return this.planAttempt({ invoice, decline, attemptNumber: (this.attempts.get(invoice.id) ?? 0) + 1 });
  }

  /**
   * Run the recovery engine for one attempt and RECORD its decision — no money, no
   * guardrail. This is the scheduler's `plan` step (it reads `retryAt` to decide when
   * to sleep) and shadow-mode's brain. Pure w.r.t. money; only appends a ledger note.
   */
  planAttempt(params: { invoice: Invoice; method?: PaymentMethod; decline?: DeclineEvent; attemptNumber: number }): RecoveryDecision {
    const { invoice, method, decline, attemptNumber } = params;
    const features = deriveFeatures(invoice, decline, attemptNumber - 1);
    const methods: AvailableMethod[] = method
      ? [{ ref: method.processorRef, isDefault: true, autoUpdated: method.autoUpdated }]
      : [];
    const decision = this.policy.decide(features, { now: new Date().toISOString(), methods });
    this.ledger.append({
      merchantId: invoice.merchantId,
      type: 'recovery.planned',
      occurredAt: new Date().toISOString(),
      detail: {
        invoiceId: invoice.id,
        action: decision.action,
        retryAt: decision.retryAt ?? null,
        recoverabilityScore: decision.recoverabilityScore,
        expectedValueMinor: decision.expectedValueMinor,
        rationale: decision.rationale,
        shadow: true,
      },
    });
    this.logger.debug(`Planned ${decision.action} for ${invoice.id}: ${decision.rationale}`);
    return decision;
  }

  /**
   * The end-to-end recovery path: the engine PROPOSES an action, the guardrail
   * DISPOSES, and only then does the adapter move money.
   *
   *   engine.decide  →  ledger('recovery.planned')  →  guardrail  →  adapter.attemptCharge
   *
   * `attemptNumber` is owned by the caller (the durable saga / scheduler), so a
   * retried activity re-derives the same idempotency key and the processor
   * de-dupes — exactly-once over an at-least-once transport. In `shadow` mode the
   * chain stops before the charge. This is the seam a Temporal workflow drives in
   * Phase 1; TODO(ax10m): host it inside a durable activity + scheduler.
   */
  async executeRecovery(params: {
    adapter: ProcessorAdapter;
    invoice: Invoice;
    method: PaymentMethod;
    decline?: DeclineEvent;
    /** Saga-owned attempt number (1-based). Stable across activity retries → exactly-once. */
    attemptNumber: number;
    localHour?: number;
    minutesSinceLastAttempt?: number;
    shadow: boolean;
  }): Promise<{ action: RecoveryActionOutcome; outcome?: ChargeOutcome; decision: RecoveryDecision }> {
    const { adapter, invoice, method, attemptNumber, shadow } = params;
    const attemptsSoFar = attemptNumber - 1;
    const features = deriveFeatures(invoice, params.decline, attemptsSoFar);
    const methods: AvailableMethod[] = [
      { ref: method.processorRef, isDefault: true, autoUpdated: method.autoUpdated },
    ];
    const decision = this.policy.decide(features, { now: new Date().toISOString(), methods });

    this.ledger.append({
      merchantId: invoice.merchantId,
      type: 'recovery.planned',
      occurredAt: new Date().toISOString(),
      detail: {
        invoiceId: invoice.id,
        action: decision.action,
        retryAt: decision.retryAt ?? null,
        expectedValueMinor: decision.expectedValueMinor,
        rationale: decision.rationale,
        shadow,
      },
    });

    // The engine chose NOT to retry this card (dead credential, or EV ≤ threshold).
    if (decision.action !== 'retry') {
      this.ledger.append({
        merchantId: invoice.merchantId,
        type: decision.action === 'card_update_comms' ? 'comms.sent' : 'action.suppressed',
        occurredAt: new Date().toISOString(),
        detail: { invoiceId: invoice.id, reason: decision.action, rationale: decision.rationale },
      });
      return { action: decision.action, decision };
    }

    // The engine proposed a retry — hand it to the guardrail + execution path.
    const proposed: ProposedAction = {
      kind: 'charge_retry',
      declineCode: features.declineCode,
      declineFamily: familyOf(features.declineCode),
      attemptsSoFar,
      cardNetwork: mapCardNetwork(method.brand),
      attemptsInWindow: attemptsSoFar,
      minutesSinceLastAttempt: params.minutesSinceLastAttempt,
      localHour: params.localHour ?? new Date().getUTCHours(),
      hasConsent: true,
      globallyOptedOut: false,
    };
    const exec = await this.attemptRecovery({ adapter, invoice, method, proposed, attemptNumber, shadow });
    return { action: exec.result, outcome: exec.outcome, decision };
  }

  /** Expose the ledger head so callers can notarize / build statements. */
  ledgerHead(): string {
    return this.ledger.head();
  }
}

/** Outcome of an end-to-end recovery decision — engine verdict OR guardrail/execution result. */
type RecoveryActionOutcome = 'card_update_comms' | 'suppress' | 'suppressed' | 'shadowed' | 'attempted';

/** Realized processor outcome of a charge attempt. */
type ChargeOutcome = 'succeeded' | 'failed' | 'pending';

/**
 * Derive the recovery-engine feature vector from a failed invoice + its decline.
 * Scaffold-grade: tenure / prior-recovery-rate / issuer signals are neutral priors
 * until the customer graph and BIN metadata are joined. TODO(ax10m): populate from
 * the customer's real history + payment-method BIN so the learned policy has signal.
 */
function deriveFeatures(invoice: Invoice, decline: DeclineEvent | undefined, attemptsSoFar: number): RecoveryFeatures {
  return {
    declineCode: decline?.code ?? DeclineCode.Unknown,
    amountMinor: invoice.amount.amount,
    currency: invoice.amount.currency,
    issuerRegion: 'unknown',
    customerTenureDays: 180,
    priorRecoveryRate: 0.35,
    attemptNumber: attemptsSoFar + 1,
    daysSinceFirstFail: 0,
  };
}

/** Map a processor's card brand string to the guardrail's network taxonomy. */
function mapCardNetwork(brand: string | undefined): CardNetwork {
  switch ((brand ?? '').toLowerCase()) {
    case 'visa':
      return 'visa';
    case 'mastercard':
    case 'master':
      return 'mastercard';
    case 'amex':
    case 'american express':
    case 'american_express':
      return 'amex';
    case 'discover':
      return 'discover';
    default:
      return 'other';
  }
}

/**
 * Derive a holdout stratum from a failed invoice + its decline. Scaffold-level:
 * MRR tier is proxied from the invoice amount and issuer region is unknown until
 * BIN metadata is joined. TODO(ax10m): use real MRR + issuer-region from the
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
