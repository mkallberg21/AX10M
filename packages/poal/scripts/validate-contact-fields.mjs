/**
 * Live-sandbox contact-field validation harness (CLI).
 *
 * Confirms, against a processor's REAL sandbox, that the dunning contact (email / phone) our
 * adapters extract still matches the live payload/API — the counterpart to the docs review in
 * packages/poal/CONTACT-FIELDS.md. For each processor you point it at, it builds the real adapter
 * from YOUR sandbox credentials, replays a webhook you captured, and reports the contact that
 * resolved (MASKED). For API-lookup adapters (shopify / gocardless / zuora) the replay also
 * triggers the live enrichment GET against the sandbox, so it validates that path too.
 *
 *   corepack pnpm --filter @ax10m/poal build        # once, to produce dist/
 *   node packages/poal/scripts/validate-contact-fields.mjs
 *
 * NOTHING is committed and NO charge is made — this only verifies webhook signatures and does
 * read-only enrichment GETs. All credentials come from the environment; none are printed.
 *
 * Per processor <P> (lower-case id, e.g. stripe, gocardless), set:
 *   AX10M_VAL_<P>_CONFIG_FILE   path to a JSON credentials bag for buildAdapter, e.g.
 *                               { "secretKey": "...", "webhookSecret": "...", "baseUrl": "https://sandbox..." }
 *                               (or AX10M_VAL_<P>_CONFIG with the JSON inline)
 *   AX10M_VAL_<P>_BODY_FILE     path to the captured raw webhook body (exact bytes)
 *   AX10M_VAL_<P>_HEADERS_FILE  path to a JSON object of the webhook's headers (incl. the
 *                               signature header) (or AX10M_VAL_<P>_HEADERS inline)
 * Optional:
 *   AX10M_VAL_PROCESSORS        comma list to run (default: every <P> that has a BODY file set)
 *   AX10M_VAL_MERCHANT_ID       merchant id stamped on events (default "validate")
 *   --strict                    exit non-zero if any processor errors
 */

import { readFileSync } from 'node:fs';
import { buildAdapter, validateContactFor, formatReport } from '../dist/index.js';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0].replace(/^\/\*+/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}
const strict = argv.includes('--strict');
const env = process.env;
const merchantId = env.AX10M_VAL_MERCHANT_ID || 'validate';

/** Read a value from either <name>_FILE (path) or <name> (inline). Returns undefined if neither. */
function readSource(name) {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8');
  return env[name];
}

// Which processors to run: explicit list, else every one with a BODY configured.
const explicit = (env.AX10M_VAL_PROCESSORS || '').split(',').map((s) => s.trim()).filter(Boolean);
const discovered = Object.keys(env)
  .map((k) => /^AX10M_VAL_([A-Z0-9]+)_BODY(_FILE)?$/.exec(k))
  .filter(Boolean)
  .map((m) => m[1].toLowerCase());
const processors = [...new Set(explicit.length ? explicit : discovered)];

if (processors.length === 0) {
  console.error('No processors configured. Set AX10M_VAL_<P>_BODY_FILE / _CONFIG_FILE / _HEADERS_FILE (see --help).');
  process.exit(2);
}

const rows = [];
const skipped = [];
for (const proc of processors) {
  const P = proc.toUpperCase();
  const configRaw = readSource(`AX10M_VAL_${P}_CONFIG`);
  const body = readSource(`AX10M_VAL_${P}_BODY`);
  const headersRaw = readSource(`AX10M_VAL_${P}_HEADERS`);
  if (!configRaw || !body) {
    skipped.push(`${proc} (missing ${!configRaw ? 'CONFIG' : ''}${!configRaw && !body ? ' + ' : ''}${!body ? 'BODY' : ''})`);
    continue;
  }
  let config, headers;
  try {
    config = JSON.parse(configRaw);
    headers = headersRaw ? JSON.parse(headersRaw) : {};
  } catch (err) {
    rows.push({ processor: proc, status: 'error', error: `bad JSON in CONFIG/HEADERS: ${err.message}` });
    continue;
  }
  try {
    const adapter = buildAdapter(proc, merchantId, config); // real transport → hits the sandbox for lookups
    rows.push(await validateContactFor(proc, adapter, { body, headers }));
  } catch (err) {
    rows.push({ processor: proc, status: 'error', error: err.message });
  }
}

console.log('\nContact-field validation (live sandbox) — values masked\n');
console.log(formatReport(rows));
if (skipped.length) console.log(`\nskipped: ${skipped.join(', ')}`);
console.log('\nstatus: contact = email/phone resolved · no-contact = ingested but payload had none · no-failed-event = no invoice.failed · error = ingest/lookup failed');

if (strict && rows.some((r) => r.status === 'error')) process.exit(1);
