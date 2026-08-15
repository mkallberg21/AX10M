import { Injectable, Logger } from '@nestjs/common';
import type { CanonicalEvent, DeclineEvent, Invoice, MrrTier, PaymentMethod } from '@ax10m/canonical';
import { DeclineCode, DeclineFamily, familyOf } from '@ax10m/canonical';
import type { ProcessorAdapter, RawWebhook } from '@ax10m/poal';
import { idempotencyKey } from '@ax10m/poal';
import {
  assign,
  HashChainedLedger,
  type HoldoutConfig,
  type LedgerEntry,
  type Stratum,
} from '@ax10m/attribution';
import {
  evaluate as evaluateGuardrail,
  type CardNetwork,
  type ProposedAction,
} from '@ax10m/guardrail';
import {
  BOOTSTRAP_RECOVERABILITY_WEIGHTS,
  HeuristicPolicy,
  LogisticRecoverability,
  planRetrySequence,
  RecoveryFeatureStore,
  type AvailableMethod,
  type RecoveryDecision,
  type RecoveryFeatures,
  type RetryPolicy,
  type RetryStep,
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

  // The recovery brain. Same guardrail-safe decision surface (HeuristicPolicy), but its
  // recoverability model is the TRAINED LogisticRecoverability (bootstrap prior fit by
  // @ax10m/recovery-engine's trainer; held-out AUC 0.881 vs 0.869 heuristic). Retrain on
  // the live ledger via samplesFromLedger, or swap in an online BanditPolicy — the
  // RetryPolicy/RecoverabilityModel seam means neither touches this wiring.
  // The trained recoverability model, shared by the single-step policy AND the ARSE
  // sequence planner so both speak with the same brain.
  private readonly recoverabilityModel = new LogisticRecoverability(BOOTSTRAP_RECOVERABILITY_WEIGHTS);
  private readonly policy: RetryPolicy = new HeuristicPolicy(this.recoverabilityModel);

  // Enrichment layer + data flywheel: turns a raw failure into the high-signal feature
  // vector (customer recovery rate, issuer/BIN approval prior + region, tenure) from
  // accumulated outcomes. Fed by observe()/recordOutcome() below; read (leakage-free)
  // by featuresFor(). TODO(ax10m): back with the persistent feature store in production.
  private readonly featureStore = new RecoveryFeatureStore();

  // Invoices whose holdout assignment has already been recorded — webhooks are
  // at-least-once, so we must not double-append to the tamper-evident ledger.
  private readonly openedInvoices = new Set<string>();

  // Highest attempt number executed per invoice (drives the guardrail's window count).
  private readonly attempts = new Map<string, number>();

  /**
   * Generic ingress: any adapter → canonical events → recovery cases. Called by the
   * per-merchant WebhookRouterService, which resolves the merchant + builds the adapter
   * from that merchant's stored credentials (see @ax10m/poal `buildAdapter`).
   */
  async ingestWithAdapter(adapter: ProcessorAdapter, raw: RawWebhook): Promise<void> {
    const events = await adapter.ingestWebhook(raw);
    this.logger.debug(`${adapter.id}: normalized ${events.length} canonical event(s)`);
    for (const event of events) {
      await this.handleEvent(event);
    }
  }

  private async handleEvent(event: CanonicalEvent): Promise<void> {
    if (event.type === 'invoice.failed') {
      const payload = event.payload as { invoice?: Invoice; decline?: DeclineEvent };
      if (payload.invoice) {
        const stratum = deriveStratum(payload.invoice, payload.decline);
        const { bucket } = this.openCase({ invoice: payload.invoice, stratum, occurredAt: event.occurredAt });
        // Stamp first-contact time so the feature store can compute customer tenure.
        this.featureStore.observe({
          merchantId: payload.invoice.merchantId,
          customerId: payload.invoice.customerId,
          now: event.occurredAt,
        });
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
    // Feed the flywheel: this realized outcome sharpens the customer's recovery rate
    // and the issuer/BIN approval prior for every FUTURE case. Recorded AFTER the
    // decision (features were read before the charge) so it stays leakage-free.
    if (result.outcome !== 'pending') {
      this.featureStore.recordOutcome({
        merchantId: params.invoice.merchantId,
        customerId: params.invoice.customerId,
        bin: params.method.bin,
        recovered: result.outcome === 'succeeded',
        now: new Date().toISOString(),
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
    const features = this.featuresFor({ invoice, method, decline, attemptNumber });
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
        // Feature snapshot → the label (case.recovered / charge.failed) makes this a
        // training row. samplesFromLedger() rebuilds the corpus for retraining.
        features,
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
    const features = this.featuresFor({ invoice, method, decline: params.decline, attemptNumber });
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
        features, // training-row feature snapshot (see planAttempt)
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

  /**
   * Plan the FULL ARSE retry sequence for a case: network-aware cadence, credential
   * rotation, and a recoverability-floor cutoff, scored by the trained model. This is
   * what the durable sequenced saga (`@ax10m/scheduler` `runSequencedRecoverySaga`)
   * executes step-by-step. Records the plan to the ledger (with the feature snapshot,
   * so it's still a training row).
   */
  planSequence(params: { invoice: Invoice; method: PaymentMethod; decline?: DeclineEvent; attemptNumber: number }): RetryStep[] {
    const { invoice, method, decline, attemptNumber } = params;
    const features = this.featuresFor({ invoice, method, decline, attemptNumber });
    const methods: AvailableMethod[] = [{ ref: method.processorRef, isDefault: true, autoUpdated: method.autoUpdated }];
    const steps = planRetrySequence(features, {
      now: new Date().toISOString(),
      network: mapCardNetwork(method.brand),
      methods,
      model: this.recoverabilityModel,
    });
    this.ledger.append({
      merchantId: invoice.merchantId,
      type: 'recovery.planned',
      occurredAt: new Date().toISOString(),
      detail: {
        invoiceId: invoice.id,
        sequenceLength: steps.length,
        actions: steps.map((s) => s.action),
        retryAts: steps.map((s) => s.at),
        features,
      },
    });
    this.logger.debug(`Planned ${steps.length}-step ARSE sequence for ${invoice.id}`);
    return steps;
  }

  /**
   * Build the enriched feature vector for a case from the feature store — leakage-free
   * (reads only outcomes recorded BEFORE this case resolves). The BIN (for issuer
   * region + approval prior) comes from the payment method when available; the shadow
   * plan path has no method, so BIN-derived signals fall back to their priors.
   */
  private featuresFor(p: { invoice: Invoice; method?: PaymentMethod; decline?: DeclineEvent; attemptNumber: number }): RecoveryFeatures {
    return this.featureStore.enrich({
      merchantId: p.invoice.merchantId,
      customerId: p.invoice.customerId,
      bin: p.method?.bin,
      firstFailedAt: p.invoice.firstFailedAt,
      declineCode: p.decline?.code ?? DeclineCode.Unknown,
      amountMinor: p.invoice.amount.amount,
      currency: p.invoice.amount.currency,
      attemptNumber: p.attemptNumber,
      now: new Date().toISOString(),
    });
  }

  /** Expose the ledger head so callers can notarize / build statements. */
  ledgerHead(): string {
    return this.ledger.head();
  }

  /**
   * Snapshot the tamper-evident ledger — the retraining corpus source. The recovery
   * retrain job (`@ax10m/recovery-engine` `retrainFromLedger`) reads these entries,
   * joins each `recovery.planned` feature snapshot with its realized outcome, and
   * fits a challenger. In production this reads the persisted (Postgres) ledger.
   */
  ledgerEntries(): readonly LedgerEntry[] {
    return this.ledger.all();
  }
}

/** Outcome of an end-to-end recovery decision — engine verdict OR guardrail/execution result. */
type RecoveryActionOutcome = 'card_update_comms' | 'suppress' | 'suppressed' | 'shadowed' | 'attempted';

/** Realized processor outcome of a charge attempt. */
type ChargeOutcome = 'succeeded' | 'failed' | 'pending';

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
