/**
 * Signed clickwrap acceptance — the tamper-evident record that a specific person accepted a
 * specific version of the terms, at a specific fee schedule, at a specific time. Signed with the
 * same Ed25519 machinery as the Uplift Statement, so "they agreed to v1 of the terms at 12% on
 * this date" is a durable, independently-verifiable artifact if a fee is ever disputed.
 */

import type { Signer } from '@ax10m/attribution';
import { sha256Hex, stableStringify } from './canonical-json.js';
import type { AuthorizedSigner, BillingAccount, FeeSchedule, PayerTrack } from './account.js';
import { currentTerms, type TermsVersion } from './terms.js';

export interface AcceptanceRecord {
  accountId: string;
  merchantId: string;
  /** Terms version tag accepted. */
  termsVersion: string;
  /** SHA-256 of the exact terms body accepted — binds the record to the precise words. */
  termsHash: string;
  /** Snapshot of the economics agreed to (so a later schedule change can't rewrite history). */
  feeSchedule: FeeSchedule;
  payerTrack: PayerTrack;
  /** Whether the signer authorized recurring auto-charges (true on the auto_pay track). */
  autoPayAuthorized: boolean;
  acceptedBy: AuthorizedSigner;
  acceptedAt: string;
  /** Best-effort request provenance for the clickwrap record. */
  ip?: string;
  userAgent?: string;
}

export interface SignedAcceptanceRecord extends AcceptanceRecord {
  /** SHA-256 of the canonical record (minus these signing fields). */
  recordHash: string;
  /** Ed25519 signature over `recordHash`. */
  signature: string;
  signingKeyId: string;
}

/** Sign an acceptance record: hash the canonical form, sign the hash. */
export function signAcceptance(record: AcceptanceRecord, signer: Signer): SignedAcceptanceRecord {
  const recordHash = sha256Hex(stableStringify(record));
  return { ...record, recordHash, signature: signer.sign(recordHash), signingKeyId: signer.keyId };
}

/** Verify a signed acceptance's hash matches its content (signature verification is the caller's, with the pubkey). */
export function acceptanceHashMatches(signed: SignedAcceptanceRecord): boolean {
  const { recordHash, signature, signingKeyId, ...core } = signed;
  return sha256Hex(stableStringify(core)) === recordHash;
}

/**
 * Assemble + sign an acceptance record for a just-created BillingAccount against a terms version
 * (defaults to the current terms). Pure given `acceptedAt` and the terms.
 */
export function buildAcceptance(params: {
  account: BillingAccount;
  acceptedBy: AuthorizedSigner;
  acceptedAt: string;
  autoPayAuthorized: boolean;
  signer: Signer;
  terms?: TermsVersion;
  ip?: string;
  userAgent?: string;
}): SignedAcceptanceRecord {
  const terms = params.terms ?? currentTerms();
  const record: AcceptanceRecord = {
    accountId: params.account.accountId,
    merchantId: params.account.merchantId,
    termsVersion: terms.version,
    termsHash: terms.bodyHash,
    feeSchedule: params.account.feeSchedule,
    payerTrack: params.account.payerTrack,
    autoPayAuthorized: params.autoPayAuthorized,
    acceptedBy: params.acceptedBy,
    acceptedAt: params.acceptedAt,
    ip: params.ip,
    userAgent: params.userAgent,
  };
  return signAcceptance(record, params.signer);
}
