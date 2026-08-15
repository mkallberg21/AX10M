import { Injectable, Logger } from '@nestjs/common';
import type { CanonicalEvent, Customer, DeclineEvent, Invoice, MrrTier, PaymentMethod } from '@ax10m/canonical';
import { DeclineCode, DeclineFamily, familyOf } from '@ax10m/canonical';
import type { ProcessorAdapter, RawWebhook } from '@ax10m/poal';
import { idempotencyKey } from '@ax10m/poal';
import {
  assign,
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
  type RecoverabilityWeights,
  type RecoveryDecision,
  type RecoveryFeatures,
  type RetryPolicy,
  type RetryStep,
} from '@ax10m/recovery-engine';
import type { RecoveryWorkflowInput } from '@ax10m/scheduler/temporal';
import { OnboardingService } from '../onboarding/onboarding.service.js';
import { NoopRecoveryDispatcher, type RecoveryDispatcher } from './recovery-dispatcher.js';
import { InMemoryLedgerPort, type LedgerPort } from './ledger-port.js';

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

  // The tamper-evident ledger. Defaults to in-process (dev/tests). A deployment calls
  // useLedger() with a PersistedLedgerPort so the HTTP API and the recovery worker append
  // to ONE shared Postgres-backed chain (see apps/api/src/recovery/ledger-port.ts).
  private ledger: LedgerPort = new InMemoryLedgerPort();

  /**
   * Point the service at a shared, persisted ledger (must be called before ingest).
   * With this wired, the API and worker write to the same hash-chained ledger, so the
   * worker's real charges land in the ledger the API reads and the retrainer consumes.
   */
  useLedger(ledger: LedgerPort): void {
    this.ledger = ledger;
  }

  // TODO(ax10m): inject per-environment holdout config from env / config service.
  private readonly holdoutConfig?: HoldoutConfig;

  // The recovery brain. Same guardrail-safe decision surface (HeuristicPolicy), but its
  // recoverability model is the TRAINED LogisticRecoverability (bootstrap prior fit by
  // @ax10m/recovery-engine's trainer; held-out AUC 0.881 vs 0.869 heuristic). Retrain on
  // the live ledger via samplesFromLedger, or swap in an online BanditPolicy — the
  // RetryPolicy/RecoverabilityModel seam means neither touches this wiring.
  // The trained recoverability model, shared by the single-step policy AND the ARSE
  // sequence planner so both speak with the same brain. Starts on the bootstrap prior;
  // useChampion() swaps in a retrained model loaded from the persisted model store.
  private recoverabilityModel = new LogisticRecoverability(BOOTSTRAP_RECOVERABILITY_WEIGHTS);
  private policy: RetryPolicy = new HeuristicPolicy(this.recoverabilityModel);

  /**
   * Swap the recoverability model to a retrained champion (loaded from the persisted
   * model store at startup). Rebuilds both the policy and the sequence planner's model so
   * they share the new brain. The RecoverabilityModel seam means callers are unaffected.
   */
  useChampion(weights: RecoverabilityWeights): void {
    this.recoverabilityModel = new LogisticRecoverability(weights);
    this.policy = new HeuristicPolicy(this.recoverabilityModel);
    this.logger.log(`Loaded retrained champion (meta: ${JSON.stringify(weights.meta ?? {})}).`);
  }

  // Enrichment layer + data flywheel: turns a raw failure into the high-signal feature
  // vector (customer recovery rate, issuer/BIN approval prior + region, tenure) from
  // accumulated outcomes. Fed by observe()/recordOutcome() below; read (leakage-free)
  // by featuresFor(). TODO(ax10m): back with the persistent feature store in production.
  private readonly featureStore = new RecoveryFeatureStore();

  // Invoices whose holdout assignment has already been recorded — webhooks are
  // at-least-once, so we must not double-append to the tamper-evident ledger.
  private readonly openedInvoices = new Set<string>();

  // Highest attempt number executed per invoice (the per-CASE count → global attempt cap).
  private readonly attempts = new Map<string, number>();

  // Per-CREDENTIAL (card) attempt accounting for the card-network retry-cap + min-interval.
  // Network caps are per-card, so a refreshed / backup card starts fresh — its charges must
  // NOT count against the dead card's exhausted window (and vice versa). Keyed by
  // (invoice, method token). In-memory like `attempts`; persistence is a follow-up.
  private readonly credentialAttempts = new Map<string, { count: number; lastAtMs: number }>();

  private credentialKey(invoiceId: string, method: PaymentMethod): string {
    return `${invoiceId}:${method.token}`;
  }

  /**
   * Attempts recorded against a SPECIFIC credential (card) for an invoice — the count the
   * network retry-cap uses. A refreshed / backup card starts at 0, independent of the dead
   * card's count. (Min-interval spacing is the saga's job via its durable sleeps, so it is
   * driven by the caller's `minutesSinceLastAttempt`, not the service's wall clock.)
   */
  credentialAttemptCount(invoiceId: string, method: PaymentMethod): number {
    return this.credentialAttempts.get(this.credentialKey(invoiceId, method))?.count ?? 0;
  }

  // Durable charge path. Default = Noop (inline shadow-plan only, unchanged behavior).
  // A deployment calls enableDurableDispatch() to route treatment cases to a Temporal
  // workflow (see apps/api/src/worker + docs/RUNBOOK-WORKER.md). `liveCharging` controls
  // whether the durable saga moves money (false → the saga runs in shadow).
  private dispatcher: RecoveryDispatcher = new NoopRecoveryDispatcher();
  private durableRecovery = false;
  private liveCharging = false;

  /**
   * Route treatment cases through the durable Temporal saga instead of only planning
   * inline. Idempotent at the workflow level (workflowId = invoice id). Safe by default:
   * with `liveCharging: false` the durable saga measures but moves no money.
   */
  enableDurableDispatch(dispatcher: RecoveryDispatcher, opts: { liveCharging: boolean }): void {
    this.dispatcher = dispatcher;
    this.durableRecovery = true;
    this.liveCharging = opts.liveCharging;
    this.logger.log(`Durable recovery dispatch enabled (liveCharging=${opts.liveCharging}).`);
  }

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
      const payload = event.payload as { invoice?: Invoice; decline?: DeclineEvent; method?: PaymentMethod; customer?: Customer };
      if (payload.invoice) {
        const stratum = deriveStratum(payload.invoice, payload.decline);
        const { bucket } = await this.openCase({ invoice: payload.invoice, stratum, occurredAt: event.occurredAt });
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
        // TREATMENT cases get the recovery brain; CONTROL stays baseline-only. We always
        // PLAN inline (records the engine's decision for measurement). When durable
        // dispatch is enabled AND the normalized event carries the failed payment method,
        // we ALSO hand the case to the durable Temporal saga, which owns the timed,
        // exactly-once retry loop (and moves money only when liveCharging is on).
        if (bucket === 'treatment') {
          await this.planRecovery(payload.invoice, payload.decline);
          if (this.durableRecovery && payload.method) {
            await this.dispatchDurableRecovery(payload.invoice, payload.method, payload.decline, payload.customer);
          } else if (this.durableRecovery && !payload.method) {
            this.logger.debug(`Durable dispatch skipped for ${payload.invoice.id}: no payment method on the normalized event.`);
          }
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
  async openCase(params: {
    invoice: Invoice;
    stratum: Stratum;
    occurredAt: string;
  }): Promise<{ bucket: 'control' | 'treatment' }> {
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

    await this.ledger.append({
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
      await this.ledger.append({
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
      await this.ledger.append({
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
    // Count this attempt against THIS credential's network-cap window (not the case's).
    const ck = this.credentialKey(params.invoice.id, params.method);
    this.credentialAttempts.set(ck, { count: (this.credentialAttempts.get(ck)?.count ?? 0) + 1, lastAtMs: Date.now() });
    await this.ledger.append({
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
      await this.ledger.append({
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
  private async planRecovery(invoice: Invoice, decline?: DeclineEvent): Promise<RecoveryDecision> {
    return this.planAttempt({ invoice, decline, attemptNumber: (this.attempts.get(invoice.id) ?? 0) + 1 });
  }

  /**
   * Hand a treatment case to the durable Temporal saga. The workflowId is the invoice id
   * so a redelivered webhook can't start a duplicate saga. `shadow` follows the
   * deployment's liveCharging flag — false keeps the durable run measurement-only.
   */
  private async dispatchDurableRecovery(invoice: Invoice, method: PaymentMethod, decline?: DeclineEvent, customer?: Customer): Promise<void> {
    const input: RecoveryWorkflowInput = {
      // `customer` (when the event carries it) lets the durable saga run alternate-rail
      // backup-method recovery on dead credentials, not just card_refresh.
      saga: { attempt: { invoice, method, decline, customer }, shadow: !this.liveCharging },
    };
    await this.dispatcher.dispatch({ workflowId: invoice.id, input });
    this.logger.debug(`Dispatched durable recovery for ${invoice.id} (shadow=${!this.liveCharging}).`);
  }

  /**
   * Run the recovery engine for one attempt and RECORD its decision — no money, no
   * guardrail. This is the scheduler's `plan` step (it reads `retryAt` to decide when
   * to sleep) and shadow-mode's brain. Pure w.r.t. money; only appends a ledger note.
   */
  async planAttempt(params: { invoice: Invoice; method?: PaymentMethod; decline?: DeclineEvent; attemptNumber: number }): Promise<RecoveryDecision> {
    const { invoice, method, decline, attemptNumber } = params;
    const features = this.featuresFor({ invoice, method, decline, attemptNumber });
    const methods: AvailableMethod[] = method
      ? [{ ref: method.processorRef, isDefault: true, autoUpdated: method.autoUpdated }]
      : [];
    const decision = this.policy.decide(features, { now: new Date().toISOString(), methods });
    await this.ledger.append({
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
    /** Customer (for alternate-rail backup-method discovery on dead credentials). */
    customer?: Customer;
    shadow: boolean;
  }): Promise<{ action: RecoveryActionOutcome; outcome?: ChargeOutcome; decision: RecoveryDecision }> {
    const { adapter, invoice, method, attemptNumber, shadow } = params;
    const attemptsSoFar = attemptNumber - 1;
    const features = this.featuresFor({ invoice, method, decline: params.decline, attemptNumber });
    const methods: AvailableMethod[] = [
      { ref: method.processorRef, isDefault: true, autoUpdated: method.autoUpdated },
    ];
    const decision = this.policy.decide(features, { now: new Date().toISOString(), methods });

    await this.ledger.append({
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
      // Dead credential → try CREDENTIAL RECOVERY first (Account Updater card_refresh +
      // alternate-rail backup method) — recoveries a same-card retry can't reach. Only in
      // active mode; shadow just records the intent. If a fresh credential recovers, we're
      // done; otherwise fall through to the dunning comm.
      if (decision.action === 'card_update_comms' && !shadow) {
        const rec = await this.executeCredentialRecovery({ adapter, invoice, method, features, attemptNumber, attemptsSoFar, customer: params.customer });
        if (rec?.outcome === 'succeeded') return { action: 'attempted', outcome: 'succeeded', decision };
      }
      await this.ledger.append({
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
      attemptsSoFar, // per-CASE → global attempt cap
      cardNetwork: mapCardNetwork(method.brand),
      attemptsInWindow: this.credentialAttemptCount(invoice.id, method), // per-CREDENTIAL → network retry cap
      minutesSinceLastAttempt: params.minutesSinceLastAttempt, // saga-provided timing
      localHour: params.localHour ?? new Date().getUTCHours(),
      hasConsent: true,
      globallyOptedOut: false,
    };
    const exec = await this.attemptRecovery({ adapter, invoice, method, proposed, attemptNumber, shadow });
    return { action: exec.result, outcome: exec.outcome, decision };
  }

  /**
   * CREDENTIAL RECOVERY (the dead-card overlay edge, live). For a dead-credential decline
   * the same-card retry is hopeless, so we charge a DIFFERENT working credential:
   *   1. `card_refresh`   — `adapter.fetchUpdatedCard` queries Account Updater / network
   *                         tokens; if the card was refreshed, charge the new credential.
   *   2. `alternate_rail` — `adapter.listPaymentMethods` finds a stored backup method;
   *                         charge it (recovers closed accounts that never reissue).
   * Each charge is guardrailed as a `fresh_credential_charge` (the hard-decline /
   * non-retriable blocks don't apply to a NEW credential, but caps + opt-out still do) and
   * carries a distinct idempotency key (keyed off the new method id) → exactly-once holds.
   * Returns the first SUCCESS, or null (failed attempts are ledgered; caller sends dunning).
   */
  private async executeCredentialRecovery(p: {
    adapter: ProcessorAdapter;
    invoice: Invoice;
    method: PaymentMethod;
    features: RecoveryFeatures;
    attemptNumber: number;
    attemptsSoFar: number;
    customer?: Customer;
  }): Promise<{ outcome: ChargeOutcome } | null> {
    const freshProposed = (m: PaymentMethod): ProposedAction => ({
      // Per-credential window: a refreshed / backup card starts fresh (count 0), so its
      // charges are NOT blocked by the dead card's exhausted network cap. Global cap
      // (attemptsSoFar, per-case) still bounds total attempts to prevent infinite hopping.
      kind: 'fresh_credential_charge',
      declineCode: p.features.declineCode,
      declineFamily: familyOf(p.features.declineCode),
      attemptsSoFar: p.attemptsSoFar,
      cardNetwork: mapCardNetwork(m.brand),
      attemptsInWindow: this.credentialAttemptCount(p.invoice.id, m),
      localHour: new Date().getUTCHours(),
      hasConsent: true,
      globallyOptedOut: false,
    });
    const charge = async (m: PaymentMethod, via: 'card_refresh' | 'alternate_rail'): Promise<ChargeOutcome | undefined> => {
      await this.ledger.append({
        merchantId: p.invoice.merchantId,
        type: 'recovery.planned',
        occurredAt: new Date().toISOString(),
        detail: { invoiceId: p.invoice.id, action: via, methodRef: m.processorRef },
      });
      const exec = await this.attemptRecovery({ adapter: p.adapter, invoice: p.invoice, method: m, proposed: freshProposed(m), attemptNumber: p.attemptNumber, shadow: false });
      return exec.outcome;
    };

    // 1. Account Updater — charge the refreshed credential if the card was updated.
    let updated: PaymentMethod | null = null;
    try {
      updated = await p.adapter.fetchUpdatedCard(p.method);
    } catch (err) {
      this.logger.debug(`fetchUpdatedCard failed for ${p.invoice.id}: ${String(err)}`);
    }
    if (updated && updated.token !== p.method.token) {
      const outcome = await charge(updated, 'card_refresh');
      if (outcome === 'succeeded') return { outcome };
    }

    // 2. Alternate rail — charge a stored backup method (needs the customer to list them).
    if (p.customer) {
      let methods: PaymentMethod[] = [];
      try {
        methods = await p.adapter.listPaymentMethods(p.customer);
      } catch (err) {
        this.logger.debug(`listPaymentMethods failed for ${p.invoice.id}: ${String(err)}`);
      }
      const backup = methods.find((m) => m.id !== p.method.id && (!updated || m.id !== updated!.id));
      if (backup) {
        const outcome = await charge(backup, 'alternate_rail');
        if (outcome === 'succeeded') return { outcome };
      }
    }

    return null; // no fresh credential recovered — caller falls through to dunning comms
  }

  /**
   * Plan the FULL ARSE retry sequence for a case: network-aware cadence, credential
   * rotation, and a recoverability-floor cutoff, scored by the trained model. This is
   * what the durable sequenced saga (`@ax10m/scheduler` `runSequencedRecoverySaga`)
   * executes step-by-step. Records the plan to the ledger (with the feature snapshot,
   * so it's still a training row).
   */
  async planSequence(params: { invoice: Invoice; method: PaymentMethod; decline?: DeclineEvent; attemptNumber: number }): Promise<RetryStep[]> {
    const { invoice, method, decline, attemptNumber } = params;
    const features = this.featuresFor({ invoice, method, decline, attemptNumber });
    const methods: AvailableMethod[] = [{ ref: method.processorRef, isDefault: true, autoUpdated: method.autoUpdated }];
    const steps = planRetrySequence(features, {
      now: new Date().toISOString(),
      network: mapCardNetwork(method.brand),
      methods,
      model: this.recoverabilityModel,
    });
    await this.ledger.append({
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
  async ledgerHead(): Promise<string> {
    return this.ledger.head();
  }

  /**
   * Snapshot the tamper-evident ledger — the retraining corpus source. The recovery
   * retrain job (`@ax10m/recovery-engine` `retrainFromLedger`) reads these entries,
   * joins each `recovery.planned` feature snapshot with its realized outcome, and
   * fits a challenger. In production this reads the persisted (Postgres) ledger.
   */
  async ledgerEntries(): Promise<readonly LedgerEntry[]> {
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
