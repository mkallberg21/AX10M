/**
 * Resolve the Ed25519 signer used for BOTH signed acceptance records and monthly Uplift
 * Statements, so a merchant's contract acceptance and their bills carry the same org key. In
 * production this is a KMS/HSM key (AX10M_BILLING_SIGNING_KEY PEM); unset → an ephemeral dev key
 * (warns; not verifiable across runs).
 */

import { Logger } from '@nestjs/common';
import { createEd25519Signer, type Signer } from '@ax10m/attribution';

const logger = new Logger('BillingSigner');

export function resolveBillingSigner(env: NodeJS.ProcessEnv = process.env): Signer {
  const pem = env.AX10M_BILLING_SIGNING_KEY;
  if (pem) return createEd25519Signer('ax10m-billing', pem).signer;
  logger.warn('AX10M_BILLING_SIGNING_KEY not set — signing acceptances/statements with an EPHEMERAL key (not verifiable across runs). Set it in production.');
  return createEd25519Signer('ax10m-billing-ephemeral').signer;
}

/** AX10M's remittance details shown on invoices (bank / pay-link). Config-driven, safe default. */
export function resolveRemitTo(env: NodeJS.ProcessEnv = process.env): string {
  return env.AX10M_BILLING_REMIT_TO?.trim() || 'Remittance details will be provided by your AX10M account manager.';
}
