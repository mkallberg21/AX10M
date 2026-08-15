/**
 * Build a RecoveryFeatureStore with a REAL (licensed) BIN table joined in, so the issuer
 * region / issuer identity / card metadata come from real data instead of the illustrative
 * seed. The table is a JSON array of BinRange (`{ prefix, region, issuerId?, country?,
 * brand?, cardType? }`) at `AX10M_BIN_TABLE_PATH`. Returns null when unset → the service
 * keeps its default (seed) store. Reading the file lives here (app layer); the engine stays
 * pure/portable.
 */

import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { BinRegionIndex, DEFAULT_FEATURE_STORE_CONFIG, RecoveryFeatureStore, type BinRange } from '@ax10m/recovery-engine';

const logger = new Logger('FeatureStoreBuilder');

export function buildFeatureStore(env: NodeJS.ProcessEnv = process.env): RecoveryFeatureStore | null {
  const path = env.AX10M_BIN_TABLE_PATH;
  if (!path) return null;
  try {
    const ranges = JSON.parse(readFileSync(path, 'utf8')) as BinRange[];
    if (!Array.isArray(ranges) || ranges.length === 0) throw new Error('BIN table is empty or not an array');
    logger.log(`Loaded ${ranges.length} BIN ranges from ${path} — real issuer/region signals joined.`);
    return new RecoveryFeatureStore({ ...DEFAULT_FEATURE_STORE_CONFIG, regionIndex: BinRegionIndex.from(ranges) });
  } catch (err) {
    logger.error(`Failed to load BIN table from ${path}; falling back to the seed table. ${String(err)}`);
    return null;
  }
}
