/**
 * Credential encryption at rest (AES-256-GCM).
 *
 * Merchant processor credentials are NEVER stored in plaintext and NEVER logged. Each
 * blob is `base64(iv ‖ authTag ‖ ciphertext)` under a 256-bit key held only in the
 * environment (`AX10M_ENCRYPTION_KEY`, 64 hex chars) — in production a KMS/HSM-wrapped
 * key. GCM gives authenticated encryption, so a tampered blob fails to decrypt rather
 * than yielding garbage. (Design invariant: no real secrets in the repo, ever.)
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LEN = 12; // 96-bit nonce (GCM standard)
const TAG_LEN = 16;

/** Encrypt a UTF-8 plaintext into a base64 `iv‖tag‖ciphertext` blob. */
export function encryptCredentials(plaintext: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt a blob produced by `encryptCredentials`. Throws if the key or blob is wrong/tampered. */
export function decryptCredentials(blob: string, key: Buffer): string {
  assertKey(key);
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Load the 32-byte key from the environment. Fails closed if absent/malformed. */
export function loadKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const hex = env.AX10M_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('AX10M_ENCRYPTION_KEY must be 64 hex chars (a 256-bit key). Generate with generateKeyHex().');
  }
  return Buffer.from(hex, 'hex');
}

/** Generate a fresh 256-bit key as hex (for dev/setup; store it in the environment, never the repo). */
export function generateKeyHex(): string {
  return randomBytes(32).toString('hex');
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error(`encryption key must be 32 bytes; got ${key.length}`);
}
