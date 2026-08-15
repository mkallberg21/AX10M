/**
 * Seed CLI. Opens the DB from the environment (DATABASE_URL → Postgres, else a local
 * pglite dir), applies migrations, loads the demo dataset, and confirms the ledger
 * still verifies.
 *
 *   corepack pnpm --filter @ax10m/persistence seed
 */

import { pathToFileURL } from 'node:url';
import { openFromEnv } from './client.js';
import { generateKeyHex, loadKeyFromEnv } from './crypto.js';
import { loadDemoSeed } from './seed.js';
import { LedgerRepository } from './ledger-repo.js';

async function main(): Promise<void> {
  let key: Buffer;
  try {
    key = loadKeyFromEnv();
  } catch {
    const hex = generateKeyHex();
    // eslint-disable-next-line no-console
    console.warn(`AX10M_ENCRYPTION_KEY not set — using an EPHEMERAL key for this run. To keep credentials decryptable, set:\n  AX10M_ENCRYPTION_KEY=${hex}`);
    key = Buffer.from(hex, 'hex');
  }

  const handle = await openFromEnv();
  try {
    const res = await loadDemoSeed(handle.db, key);
    const verification = await new LedgerRepository(handle.db).verify();
    // eslint-disable-next-line no-console
    console.log(
      `seeded: merchant ${res.merchant}, connection ${res.connectionId}, ${res.ledgerEntries} ledger entries · ` +
        `verifyChain: ${verification.valid ? 'VALID ✓' : `INVALID ✗ (${verification.reason})`}`,
    );
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
