/**
 * Generate `bin-table.sample.json` — a PUBLIC, network-brand BIN starter table built from
 * the openly-documented ISO/IEC 7812 issuer-identification-number (IIN) ranges.
 *
 *   node data/gen-bin-sample.mjs
 *
 * HONEST SCOPE: this maps a BIN prefix to its card NETWORK/brand only (public knowledge —
 * e.g. Visa starts with 4, Amex 34/37, Mastercard 51–55 + 2221–2720). It deliberately does
 * NOT claim issuer identity, issuer country/region, or debit/prepaid — those are NOT
 * derivable from the network prefix and require a LICENSED commercial BIN database. Region
 * is 'unknown' here on purpose. Point AX10M_BIN_TABLE_PATH at a licensed export (same
 * BinRange JSON shape, with region/issuerId/country/cardType filled in) for those signals.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rows = [];
const add = (prefix, brand) => rows.push({ prefix, brand, region: 'unknown' });

add('4', 'visa'); // Visa: all 4xxxxx
add('34', 'amex');
add('37', 'amex');
for (const p of ['51', '52', '53', '54', '55']) add(p, 'mastercard'); // MC classic
for (let n = 2221; n <= 2720; n++) add(String(n), 'mastercard'); // MC 2-series (2221–2720)
add('6011', 'discover');
add('65', 'discover');
for (const p of ['644', '645', '646', '647', '648', '649']) add(p, 'discover');
add('35', 'jcb'); // JCB (3528–3589; 35 is JCB per ISO 7812)
add('62', 'unionpay');
for (const p of ['300', '301', '302', '303', '304', '305', '36', '38', '39']) add(p, 'diners');

const here = path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here, 'bin-table.sample.json'), JSON.stringify(rows, null, 0) + '\n');
// eslint-disable-next-line no-console
console.log(`wrote bin-table.sample.json — ${rows.length} public network-brand BIN ranges (region/issuer/cardType intentionally unknown; join a licensed DB for those)`);
