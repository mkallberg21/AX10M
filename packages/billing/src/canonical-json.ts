/**
 * Deterministic JSON + SHA-256 helpers shared by the signed records in this package
 * (acceptance records, and anything else hashed-then-signed). Object keys are sorted
 * recursively so the hash is stable across runs and machines — the same discipline the
 * attribution Uplift Statement uses.
 */

import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted recursively. Arrays keep order (order is meaningful). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
