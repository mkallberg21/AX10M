import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPglite, type DbHandle } from './client.js';
import { applyMigrations } from './migrate.js';
import { decryptCredentials, encryptCredentials, generateKeyHex, loadKeyFromEnv } from './crypto.js';
import { LedgerRepository } from './ledger-repo.js';
import { ConnectionRepository } from './connection-repo.js';
import { loadDemoSeed } from './seed.js';

const KEY = Buffer.from(generateKeyHex(), 'hex');
const tmpDirs: string[] = [];
function newTmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ax10m-pglite-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('credential encryption', () => {
  it('round-trips and never exposes plaintext', () => {
    const secret = JSON.stringify({ secretKey: 'PLAINTEXT_secret_value_xyz', webhookSecret: 'PLAINTEXT_wh' });
    const blob = encryptCredentials(secret, KEY);
    expect(blob).not.toContain('PLAINTEXT');
    expect(decryptCredentials(blob, KEY)).toBe(secret);
  });

  it('fails to decrypt with the wrong key (authenticated)', () => {
    const blob = encryptCredentials('hello', KEY);
    expect(() => decryptCredentials(blob, Buffer.from(generateKeyHex(), 'hex'))).toThrow();
  });

  it('loadKeyFromEnv fails closed on a missing/short key', () => {
    expect(() => loadKeyFromEnv({} as NodeJS.ProcessEnv)).toThrow(/64 hex/);
    expect(() => loadKeyFromEnv({ AX10M_ENCRYPTION_KEY: 'abc' } as unknown as NodeJS.ProcessEnv)).toThrow();
  });
});

describe('ledger — restart safety (§Phase 4 acceptance)', () => {
  it('the hash-chained ledger survives a restart and verifyChain still passes', async () => {
    const dir = newTmpDir();

    // First "process": write three entries, then close the connection.
    let handle: DbHandle = await createPglite(dir);
    await applyMigrations(handle.db);
    const repo1 = new LedgerRepository(handle.db);
    await repo1.append({ merchantId: 'mrc_1', type: 'holdout.assigned', occurredAt: '2026-08-14T00:00:00.000Z', detail: { bucket: 'treatment' } });
    await repo1.append({ merchantId: 'mrc_1', type: 'charge.succeeded', occurredAt: '2026-08-14T00:01:00.000Z', detail: { amount: 14900 } });
    await repo1.append({ merchantId: 'mrc_2', type: 'case.recovered', occurredAt: '2026-08-14T00:02:00.000Z', detail: { amount: 5000 } });
    const headBefore = await repo1.head();
    await handle.close();

    // Second "process": reopen the SAME data dir — a genuine restart.
    handle = await createPglite(dir);
    const repo2 = new LedgerRepository(handle.db);
    const entries = await repo2.all();
    const verification = await repo2.verify();

    expect(entries).toHaveLength(3);
    expect(verification.valid).toBe(true);
    expect(await repo2.head()).toBe(headBefore); // head survived the restart
    expect(await repo2.forMerchant('mrc_1')).toHaveLength(2);

    await handle.close();
  });

  it('detects tampering after a restart (chain breaks)', async () => {
    const dir = newTmpDir();
    let handle = await createPglite(dir);
    await applyMigrations(handle.db);
    const repo = new LedgerRepository(handle.db);
    await repo.append({ merchantId: 'mrc_1', type: 'holdout.assigned', occurredAt: 't0', detail: { a: 1 } });
    await repo.append({ merchantId: 'mrc_1', type: 'charge.succeeded', occurredAt: 't1', detail: { a: 2 } });
    // Tamper with a historical row's detail directly in the DB.
    await handle.db.execute(sql`UPDATE ledger_entries SET detail = '{"a": 999}' WHERE seq = 0`);
    await handle.close();

    handle = await createPglite(dir);
    const verification = await new LedgerRepository(handle.db).verify();
    expect(verification.valid).toBe(false);
    expect(verification.brokenAt).toBe(0);
    await handle.close();
  });
});

describe('connection repository — credentials encrypted at rest', () => {
  it('stores ciphertext (not plaintext) and decrypts on read', async () => {
    const handle = await createPglite();
    await applyMigrations(handle.db);
    const repo = new ConnectionRepository(handle.db, KEY);
    await repo.upsert({ connectionId: 'stripe-A', merchantId: 'mrc_A', processor: 'stripe', isDefault: true, config: { secretKey: 'PLAINTEXT_do_not_leak', webhookSecret: 'PLAINTEXT_wh' } });

    // Raw read: the stored blob must NOT contain the plaintext secret.
    const raw = (await handle.db.execute(sql`SELECT credentials_encrypted FROM merchant_connections WHERE connection_id = 'stripe-A'`)) as unknown as { rows: Array<{ credentials_encrypted: string }> };
    expect(raw.rows[0]!.credentials_encrypted).not.toContain('PLAINTEXT');

    const conn = await repo.get('stripe-A');
    expect(conn?.merchantId).toBe('mrc_A');
    expect(conn?.config.secretKey).toBe('PLAINTEXT_do_not_leak'); // decrypted for the caller
    expect((await repo.defaultFor('stripe'))?.connectionId).toBe('stripe-A');
    expect(await repo.get('nope')).toBeUndefined();
    await handle.close();
  });
});

describe('demo seed', () => {
  it('loads the demo dataset and the ledger verifies', async () => {
    const handle = await createPglite();
    const res = await loadDemoSeed(handle.db, KEY);
    expect(res.merchant).toBe('mrc_demo');
    expect(res.ledgerEntries).toBeGreaterThan(0);
    expect((await new LedgerRepository(handle.db).verify()).valid).toBe(true);
    const conn = await new ConnectionRepository(handle.db, KEY).defaultFor('stripe');
    expect(conn?.merchantId).toBe('mrc_demo');
    expect(typeof conn?.config.secretKey).toBe('string');
    await handle.close();
  });
});
