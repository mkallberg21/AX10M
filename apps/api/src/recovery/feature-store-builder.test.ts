import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeclineCode } from '@ax10m/canonical';
import { buildFeatureStore } from './feature-store-builder.js';

// Repo-root data/bin-table.sample.json (this file is apps/api/src/recovery/*).
const SAMPLE = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../data/bin-table.sample.json');

const enrichCtx = (bin: string) => ({
  merchantId: 'm',
  customerId: 'c',
  bin,
  declineCode: DeclineCode.InsufficientFunds,
  amountMinor: 5000,
  currency: 'USD',
  attemptNumber: 1,
  now: '2026-08-15T00:00:00.000Z',
});

describe('buildFeatureStore (BIN table loading)', () => {
  it('returns null when no BIN table path is configured (service keeps the seed)', () => {
    expect(buildFeatureStore({})).toBeNull();
  });

  it('loads the shipped public network-brand table and resolves brands (region honestly unknown)', () => {
    const store = buildFeatureStore({ AX10M_BIN_TABLE_PATH: SAMPLE });
    expect(store).not.toBeNull();
    // The public table maps prefix → network brand; region stays unknown (needs a licensed DB).
    expect(store!.binLookup('411111')).toMatchObject({ brand: 'visa', region: 'unknown' });
    expect(store!.binLookup('222100')).toMatchObject({ brand: 'mastercard' }); // MC 2-series
    expect(store!.binLookup('340000')).toMatchObject({ brand: 'amex' });
    // …and a real region/cardType is absent (not fabricated).
    const f = store!.enrich(enrichCtx('411111'));
    expect(f.issuerRegion).toBe('unknown');
    expect(f.cardType).toBe('unknown');
  });

  it('falls back to null (seed) when the file is missing or malformed', () => {
    expect(buildFeatureStore({ AX10M_BIN_TABLE_PATH: '/nonexistent/bin.json' })).toBeNull();
  });
});
