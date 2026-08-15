/**
 * Convert a licensed BIN-database CSV export into the BinRange JSON that
 * AX10M_BIN_TABLE_PATH consumes.
 *
 *   corepack pnpm --filter @ax10m/recovery-engine build   # once
 *   node data/bin-csv-to-json.mjs <input.csv> <output.json> [--col field=Header ...] [--no-region-from-country] [--delimiter ;]
 *
 * Columns auto-detect from common aliases (BIN/IIN/prefix, brand/scheme/network,
 * type/product_type, country/country_code, issuer/bank_name). Override any with
 * `--col prefix=BIN --col brand=Scheme --col cardType="Product Type"`. Region is derived
 * from the country code when the export has no region column (issuer region is a model
 * feature). See data/README.md.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseBinCsv } from '../packages/recovery-engine/dist/bin-csv.js';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const [input, output] = positional;
if (!input || !output) {
  console.error('usage: node data/bin-csv-to-json.mjs <input.csv> <output.json> [--col field=Header ...] [--no-region-from-country] [--delimiter <c>]');
  process.exit(2);
}

const columns = {};
let delimiter;
let deriveRegionFromCountry = true;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--col') {
    const [field, ...rest] = (args[++i] ?? '').split('=');
    if (field && rest.length) columns[field] = rest.join('=');
  } else if (args[i] === '--delimiter') {
    delimiter = args[++i];
  } else if (args[i] === '--no-region-from-country') {
    deriveRegionFromCountry = false;
  }
}

const ranges = parseBinCsv(readFileSync(input, 'utf8'), { columns, delimiter, deriveRegionFromCountry });
writeFileSync(output, JSON.stringify(ranges, null, 0) + '\n');

const withRegion = ranges.filter((r) => r.region !== 'unknown').length;
const withType = ranges.filter((r) => r.cardType).length;
const withIssuer = ranges.filter((r) => r.issuerId).length;
console.log(`wrote ${output} — ${ranges.length} BIN ranges (region ${withRegion}, cardType ${withType}, issuerId ${withIssuer}). Point AX10M_BIN_TABLE_PATH at it.`);
