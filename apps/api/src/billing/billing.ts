/**
 * Monthly Uplift Statement — the honest invoice for AX10M's 12% fee.
 *
 * The fee is 12% of the PROVEN incremental uplift (holdout mSPRT lower bound) newly proven this
 * period, never re-billing prior periods. All the statistics live in @ax10m/attribution
 * (`buildBillableStatement` → `computeBillableUplift`); this module scopes a period, derives the
 * prior-billed watermark from the ledger, signs the statement (Ed25519), and returns it.
 *
 * SAFE-BY-DEFAULT: producing/recording a statement moves NO money — it's an auditable invoice.
 * Charging the merchant is a separate, flag-gated step (see charger.ts).
 */

import { createHash } from 'node:crypto';
import { buildBillableStatement, type BillableStatement, type SequentialUpliftConfig, type Signer } from '@ax10m/attribution';
import { reconstructObservations, type BillingLedgerEntry, type BillingPeriod } from './observations.js';

export interface SignedBillableStatement extends BillableStatement {
  /** SHA-256 of the canonical statement (minus these signing fields). */
  statementHash: string;
  /** Ed25519 signature over `statementHash`. */
  signature: string;
  signingKeyId: string;
}

/** Deterministic JSON: object keys sorted recursively, so the hash is stable across runs. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Sign a statement: hash the canonical form, sign the hash. Anyone can verify with the pubkey. */
export function signStatement(statement: BillableStatement, signer: Signer): SignedBillableStatement {
  const statementHash = sha256Hex(stableStringify(statement));
  return { ...statement, statementHash, signature: signer.sign(statementHash), signingKeyId: signer.keyId };
}

/** Verify a signed statement's hash matches its content (signature verification is the caller's, with the pubkey). */
export function statementHashMatches(signed: SignedBillableStatement): boolean {
  const { statementHash, signature, signingKeyId, ...core } = signed;
  return sha256Hex(stableStringify(core)) === statementHash;
}

/**
 * The prior-billed watermark = the cumulative proven lower-bound dollars from the LATEST prior
 * `uplift.statement` for this merchant (minor units). computeBillableUplift bills only the
 * increment over this, so we never re-bill. Zero if the merchant has never been billed.
 */
export function priorBilledFromLedger(entries: readonly BillingLedgerEntry[], merchantId: string): number {
  let latestAt = -Infinity;
  let watermark = 0;
  for (const e of entries) {
    if (e.type !== 'uplift.statement' || e.merchantId !== merchantId) continue;
    const t = Date.parse(e.occurredAt);
    const cum = (e.detail as { lowerDollarsCum?: number }).lowerDollarsCum;
    if (!Number.isNaN(t) && t >= latestAt && typeof cum === 'number') {
      latestAt = t;
      watermark = cum;
    }
  }
  return watermark;
}

/** Compute + sign one merchant's Uplift Statement for a period. Pure given `nowIso` (via ledgerHead). */
export function computeMerchantStatement(params: {
  entries: readonly BillingLedgerEntry[];
  merchantId: string;
  period: BillingPeriod;
  ledger: Parameters<typeof buildBillableStatement>[0]['ledger'];
  ledgerHead: string;
  signer: Signer;
  config?: SequentialUpliftConfig;
}): SignedBillableStatement {
  const observations = reconstructObservations(params.entries, params.merchantId, params.period);
  const priorBilledDollars = priorBilledFromLedger(params.entries, params.merchantId);
  const statement = buildBillableStatement({
    merchantId: params.merchantId,
    period: params.period.label,
    observations,
    priorBilledDollars,
    ledger: params.ledger,
    ledgerHead: params.ledgerHead,
    config: params.config,
  });
  return signStatement(statement, params.signer);
}
