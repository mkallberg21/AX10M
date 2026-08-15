/**
 * Verify an AX10M signed Uplift Statement — for a skeptical CFO who trusts nothing.
 *
 *   node scripts/verify-statement.mjs \
 *     apps/dashboard/public/uplift-statement.json \
 *     apps/dashboard/public/ax10m-demo-pubkey.pem \
 *     apps/dashboard/public/uplift-ledger.json
 *
 * Checks, using only public inputs (no trust in AX10M):
 *   1. The statement HASH recomputes from the canonical content.
 *   2. The Ed25519 SIGNATURE verifies against the published public key.
 *   3. The hash-chained LEDGER verifies (verifyChain) and its head matches the statement.
 * Exit code 0 iff all pass.
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
// Resolve the built @ax10m/attribution verifier relative to this script (repo-internal;
// a shipped CFO verifier would bundle it). Run `pnpm --filter @ax10m/attribution build` first.
const attrib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'attribution', 'dist', 'index.js');
const { verifyReconciliationSignature, verifyChain } = await import(pathToFileURL(attrib).href);

const [stmtPath, pubkeyPath, ledgerPath] = process.argv.slice(2);
if (!stmtPath || !pubkeyPath) {
  console.error('usage: node scripts/verify-statement.mjs <statement.json> <pubkey.pem> [ledger.json]');
  process.exit(2);
}

const statement = JSON.parse(await fs.readFile(stmtPath, 'utf8'));
const pubkey = await fs.readFile(pubkeyPath, 'utf8');

const { hashMatches, signatureValid } = verifyReconciliationSignature(statement, pubkey);

let ledgerOk = null;
let headMatches = null;
if (ledgerPath) {
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  const chain = verifyChain(ledger);
  ledgerOk = chain.valid;
  const head = ledger.length ? ledger[ledger.length - 1].hash : '0'.repeat(64);
  headMatches = head === statement.ledgerHead;
}

const line = (ok, label) => `  ${ok ? 'PASS' : 'FAIL'}  ${label}`;
console.log(`Verifying ${stmtPath} (${statement.merchantId} · ${statement.period})`);
console.log(line(hashMatches, 'statement hash recomputes'));
console.log(line(signatureValid, `Ed25519 signature valid (key ${statement.signingKeyId})`));
if (ledgerPath) {
  console.log(line(ledgerOk, 'hash-chained ledger verifies (verifyChain)'));
  console.log(line(headMatches, 'ledger head matches statement'));
}
console.log(`  fee billed: $${((statement.fee?.fee ?? 0) / 100).toFixed(2)} (billable=${statement.fee?.billable})`);

const allOk = hashMatches && signatureValid && (ledgerPath ? ledgerOk && headMatches : true);
console.log(allOk ? '\nRESULT: VERIFIED ✓ — the number is exactly what was signed, tamper-evident.' : '\nRESULT: FAILED ✗');
process.exit(allOk ? 0 : 1);
