/**
 * Deterministic JSON + SHA-256 helpers shared by the signed records in this package
 * (acceptance records, and anything else hashed-then-signed). Object keys are sorted
 * recursively so the hash is stable across runs and machines — the same discipline the
 * attribution Uplift Statement uses.
 */

import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted recursively; arrays keep order (order is meaningful).
 * Undefined-valued keys are OMITTED — matching `JSON.stringify` and, crucially, a jsonb
 * round-trip (which drops undefined) — so an absent field and an explicit `undefined` hash
 * identically. Without this, signing a record with `undefined` optionals then re-hashing after
 * a DB round-trip would disagree.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
