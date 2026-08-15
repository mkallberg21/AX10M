/**
 * Regenerate the dashboard demo data from the Phase-1 world model.
 *
 *   corepack pnpm --filter @ax10m/backtest build   # ensure the generator is built
 *   corepack pnpm --filter @ax10m/dashboard gen-demo
 *
 * Writes:
 *   app/demo-data.json                 — the page's numbers (small; no per-row list)
 *   public/uplift-statement.json       — the full Ed25519-signed reconciliation export
 *   public/uplift-statement.csv        — the CFO reconciliation CSV
 *   public/uplift-ledger.json          — the hash-chained ledger (for verifyChain)
 *   public/ax10m-demo-pubkey.pem       — the public key to verify the signature
 *
 * The committed outputs let `pnpm dev` show the full demo with no credentials and no
 * regeneration. The signing key is ephemeral; only the public key is published.
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildDemoData } from '@ax10m/backtest';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', 'app');
const pubDir = path.resolve(here, '..', 'public');

const data = buildDemoData();

const pageData = {
  onboarding: data.onboarding,
  statement: data.statement,
  reconSummary: data.reconSummary,
  reconResult: data.reconResult,
  retrain: data.retrain,
  meta: data.meta,
};

await fs.mkdir(appDir, { recursive: true });
await fs.mkdir(pubDir, { recursive: true });
await fs.writeFile(path.join(appDir, 'demo-data.json'), JSON.stringify(pageData, null, 2) + '\n');
await fs.writeFile(path.join(pubDir, 'uplift-statement.json'), JSON.stringify(data.fullExport, null, 2) + '\n');
await fs.writeFile(path.join(pubDir, 'uplift-statement.csv'), data.csv + '\n');
await fs.writeFile(path.join(pubDir, 'uplift-ledger.json'), JSON.stringify(data.ledger, null, 2) + '\n');
await fs.writeFile(path.join(pubDir, 'ax10m-demo-pubkey.pem'), data.publicKeyPem);

// eslint-disable-next-line no-console
console.log(
  `demo generated: control rate ${(data.statement.result.controlRate * 100).toFixed(1)}% vs treatment ${(data.statement.result.treatmentRate * 100).toFixed(1)}%, ` +
    `fee $${(data.statement.result.fee.amount / 100).toFixed(2)}, billable=${data.statement.result.billable}. ` +
    `Wrote demo-data.json + public/uplift-statement.{json,csv} + ledger + pubkey.`,
);
