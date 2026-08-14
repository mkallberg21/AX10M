/**
 * @ax10m/protocol — the AX10M Protocol (AXP).
 *
 * A small, versioned message vocabulary that lets processors, MoRs, billing platforms,
 * and merchants speak "payment uplift" the same way — the thing that makes AX10M a
 * standard rather than a single integration. Every message is a typed `AxpEnvelope`
 * with a kind (AXP-01..06), a semantic version, and a payload. This package is
 * intentionally dependency-light (canonical taxonomy only) and side-effect-free: it
 * defines the contract; the API/engine packages produce and consume it.
 *
 *   AXP-01  Decline-code normalization    (processor dialect → canonical taxonomy)
 *   AXP-02  Retry-sequence negotiation     (propose an ARSE schedule, get an ack)
 *   AXP-03  Uplift event reporting         (signed, holdout-verified incremental lift)
 *   AXP-04  Processor routing handshake    (capabilities + integration mode)
 *   AXP-05  MoR integration handshake      (who owns the token + dunning)
 *   AXP-06  Merchant onboarding handshake  (connection + shadow/active mode)
 */

import type { DeclineCode, DeclineFamily } from '@ax10m/canonical';

/** Current protocol version (semver). */
export const AXP_VERSION = '0.1.0';

/** The six message kinds. */
export type AxpKind = 'AXP-01' | 'AXP-02' | 'AXP-03' | 'AXP-04' | 'AXP-05' | 'AXP-06';

export const AXP_KINDS: readonly AxpKind[] = ['AXP-01', 'AXP-02', 'AXP-03', 'AXP-04', 'AXP-05', 'AXP-06'];

/** Every AXP message is a typed, versioned envelope. */
export interface AxpEnvelope<K extends AxpKind, P> {
  axp: K;
  version: string;
  /** Unique message id (idempotency / correlation). */
  id: string;
  /** ISO timestamp the message was issued. */
  issuedAt: string;
  payload: P;
}

// ── AXP-01 Decline-code normalization ────────────────────────────────────────
export type RecommendedAction = 'retry' | 'card_update' | 'suppress';

export interface AxpDeclineNormalization {
  processor: string;
  /** The processor's native decline/reason code. */
  rawCode: string | null;
  canonicalCode: DeclineCode;
  family: DeclineFamily;
  retriable: boolean;
  recommendedAction: RecommendedAction;
}
export type Axp01 = AxpEnvelope<'AXP-01', AxpDeclineNormalization>;

// ── AXP-02 Retry-sequence negotiation ────────────────────────────────────────
export interface AxpRetryStep {
  attemptNumber: number;
  at: string;
  action: RecommendedAction;
  methodRef?: string;
}
export interface AxpRetrySequenceProposal {
  caseId: string;
  merchantId: string;
  network?: string;
  steps: AxpRetryStep[];
}
export type Axp02Proposal = AxpEnvelope<'AXP-02', AxpRetrySequenceProposal>;

export interface AxpRetrySequenceAck {
  caseId: string;
  accepted: boolean;
  /** If the counterparty (processor/MoR) trims or reschedules steps, the accepted set. */
  acceptedSteps?: AxpRetryStep[];
  reason?: string;
}
export type Axp02Ack = AxpEnvelope<'AXP-02', AxpRetrySequenceAck>;

// ── AXP-03 Uplift event reporting ────────────────────────────────────────────
export interface AxpUpliftEvent {
  merchantId: string;
  /** Reporting period, e.g. an ISO date or `2026-08`. */
  period: string;
  /** Holdout-verified LOWER-BOUND incremental recovered amount (minor units). */
  incrementalRecoveredMinor: number;
  currency: string;
  /** Confidence level of the lower bound (e.g. 0.95). */
  confidence: number;
  /** Fee billed against the lower bound (minor units) — AX10M bills 12%. */
  feeMinor: number;
  /** Hash-chain head of the attribution ledger this statement was derived from. */
  ledgerHead: string;
  /** Detached signature over the statement (e.g. Ed25519), for CFO-verifiable audit. */
  signature?: string;
}
export type Axp03 = AxpEnvelope<'AXP-03', AxpUpliftEvent>;

// ── AXP-04 Processor routing handshake ───────────────────────────────────────
export type IntegrationMode = 'drive' | 'co-drive' | 'advisory';
export interface AxpProcessorHandshake {
  processor: string;
  integrationMode: IntegrationMode;
  capabilities: {
    externalRetryControl: boolean;
    accountUpdater: boolean;
    networkTokens: boolean;
    partialCapture: boolean;
    pauseNativeDunning: boolean;
    webhooks: boolean;
    listPaymentMethods: boolean;
  };
  /** Protocol versions this counterparty supports. */
  supportedVersions: string[];
}
export type Axp04 = AxpEnvelope<'AXP-04', AxpProcessorHandshake>;

// ── AXP-05 MoR integration handshake ─────────────────────────────────────────
export interface AxpMorHandshake {
  mor: string;
  /** MoR owns the payment token (AX10M cannot drive a charge). */
  ownsToken: boolean;
  /** MoR runs its own dunning/retry engine. */
  ownsDunning: boolean;
  /** AX10M's role is measurement + advisory only. */
  measurementOnly: boolean;
  /** Channels AX10M is permitted to act on (the comms it controls). */
  permittedCommsChannels: string[];
}
export type Axp05 = AxpEnvelope<'AXP-05', AxpMorHandshake>;

// ── AXP-06 Merchant onboarding handshake ─────────────────────────────────────
export interface AxpMerchantOnboarding {
  merchantId: string;
  processor: string;
  /** The per-merchant webhook connection id (see per-merchant routing). */
  connectionId: string;
  /** Shadow = measure only (Phase 0); active = drive recovery (Phase 1). */
  mode: 'shadow' | 'active';
}
export type Axp06 = AxpEnvelope<'AXP-06', AxpMerchantOnboarding>;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a well-formed envelope. `id`/`issuedAt` are supplied by the caller (determinism). */
export function makeEnvelope<K extends AxpKind, P>(axp: K, id: string, issuedAt: string, payload: P): AxpEnvelope<K, P> {
  return { axp, version: AXP_VERSION, id, issuedAt, payload };
}

/** True if a value is an AXP kind string. */
export function isAxpKind(v: unknown): v is AxpKind {
  return typeof v === 'string' && (AXP_KINDS as readonly string[]).includes(v);
}

/** Structural validation of an envelope (kind, version, id, issuedAt, payload present). */
export function isAxpEnvelope(v: unknown): v is AxpEnvelope<AxpKind, unknown> {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    isAxpKind(e.axp) &&
    typeof e.version === 'string' &&
    typeof e.id === 'string' &&
    typeof e.issuedAt === 'string' &&
    'payload' in e
  );
}
