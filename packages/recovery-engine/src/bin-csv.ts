/**
 * CSV → BinRange converter for a licensed BIN-database export.
 *
 * Commercial BIN DBs ship as CSV with varying column names, so this auto-detects common
 * aliases (BIN/IIN/prefix, brand/scheme/network, type/product_type, country/country_code,
 * issuer/bank_name) and lets the caller override any of them. Values are normalized to the
 * `BinRange` vocabulary the feature store expects, and — since region is a MODEL feature —
 * the issuer region is derived from the country code when the export doesn't carry a region
 * column. Pure (string in → BinRange[] out); the file I/O lives in the CLI (`data/`).
 */

import type { IssuerRegion } from '@ax10m/canonical';
import type { BinRange } from './feature-store.js';

export type BinCsvField = 'prefix' | 'region' | 'issuerId' | 'country' | 'brand' | 'cardType';
export type BinCsvColumnMap = Partial<Record<BinCsvField, string>>;

export interface BinCsvOptions {
  /** Explicit header name per field (case-insensitive), overriding auto-detection. */
  columns?: BinCsvColumnMap;
  /** Field delimiter. Default ','. */
  delimiter?: string;
  /** Derive issuer region from the country column when there's no region column. Default true. */
  deriveRegionFromCountry?: boolean;
}

/** Header aliases per field — the first that matches a CSV header wins. */
const ALIASES: Record<BinCsvField, readonly string[]> = {
  prefix: ['bin', 'iin', 'prefix', 'bin_number', 'binnumber', 'card_bin', 'bin_range', 'number'],
  brand: ['brand', 'scheme', 'network', 'card_scheme', 'card_brand', 'cardbrand'],
  cardType: ['type', 'card_type', 'cardtype', 'product_type', 'producttype', 'product'],
  country: ['country', 'country_code', 'countrycode', 'iso_country', 'country_iso', 'issuer_country', 'alpha2'],
  issuerId: ['issuer', 'issuer_name', 'issuer_id', 'issuerid', 'bank', 'bank_name', 'institution'],
  region: ['region', 'issuer_region'],
};

/** RFC-4180-ish CSV parse: handles quoted fields, escaped quotes, commas/newlines in quotes. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, ''); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* ignore; \n handles the break */ }
    else field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const BRANDS: Record<string, string> = {
  visa: 'visa', 'visa electron': 'visa',
  mastercard: 'mastercard', master: 'mastercard', mc: 'mastercard', maestro: 'mastercard',
  amex: 'amex', 'american express': 'amex',
  discover: 'discover',
  jcb: 'jcb',
  unionpay: 'unionpay', 'china unionpay': 'unionpay', cup: 'unionpay',
  diners: 'diners', 'diners club': 'diners', 'diners club international': 'diners',
};
function normalizeBrand(v: string): string | undefined {
  const k = v.trim().toLowerCase();
  if (!k) return undefined;
  return BRANDS[k] ?? k;
}

function normalizeCardType(v: string): BinRange['cardType'] {
  const k = v.trim().toLowerCase();
  if (k.includes('prepaid')) return 'prepaid';
  if (k.includes('debit')) return 'debit';
  if (k.includes('credit') || k.includes('charge')) return 'credit';
  return undefined;
}

/** Country (ISO 3166-1 alpha-2) → coarse issuer region. Unmapped → 'unknown'. */
const COUNTRY_REGION: Record<string, IssuerRegion> = {
  US: 'na', CA: 'na',
  GB: 'emea', IE: 'emea', DE: 'emea', FR: 'emea', ES: 'emea', IT: 'emea', NL: 'emea', BE: 'emea',
  SE: 'emea', NO: 'emea', DK: 'emea', FI: 'emea', PL: 'emea', PT: 'emea', CH: 'emea', AT: 'emea',
  RU: 'emea', TR: 'emea', ZA: 'emea', AE: 'emea', SA: 'emea', IL: 'emea', GR: 'emea', CZ: 'emea', RO: 'emea',
  BR: 'latam', MX: 'latam', AR: 'latam', CL: 'latam', CO: 'latam', PE: 'latam', UY: 'latam', EC: 'latam',
  CN: 'apac', JP: 'apac', IN: 'apac', AU: 'apac', NZ: 'apac', KR: 'apac', SG: 'apac', HK: 'apac',
  TW: 'apac', TH: 'apac', MY: 'apac', ID: 'apac', PH: 'apac', VN: 'apac',
};
export function regionFromCountry(country: string | undefined): IssuerRegion {
  if (!country) return 'unknown';
  return COUNTRY_REGION[country.trim().toUpperCase()] ?? 'unknown';
}

function normalizeRegion(v: string): IssuerRegion | undefined {
  const k = v.trim().toLowerCase();
  return (['na', 'emea', 'latam', 'apac', 'unknown'] as const).find((r) => r === k);
}

/** Canonicalize a column name so "Bank Name", "bank_name", "bank-name" all compare equal. */
const canon = (h: string): string => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/** Resolve the CSV column index for a field (explicit override → alias auto-detect). */
function resolveColumn(field: BinCsvField, header: string[], override?: string): number {
  const canonHeader = header.map(canon);
  if (override) return canonHeader.indexOf(canon(override));
  for (const alias of ALIASES[field]) {
    const idx = canonHeader.indexOf(canon(alias));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Convert a licensed BIN-DB CSV export into `BinRange[]` for AX10M_BIN_TABLE_PATH. */
export function parseBinCsv(text: string, options: BinCsvOptions = {}): BinRange[] {
  const rows = parseCsv(text, options.delimiter);
  if (rows.length < 2) return [];
  const header = rows[0]!;
  const cols = options.columns ?? {};
  const idx = {
    prefix: resolveColumn('prefix', header, cols.prefix),
    region: resolveColumn('region', header, cols.region),
    issuerId: resolveColumn('issuerId', header, cols.issuerId),
    country: resolveColumn('country', header, cols.country),
    brand: resolveColumn('brand', header, cols.brand),
    cardType: resolveColumn('cardType', header, cols.cardType),
  };
  if (idx.prefix < 0) throw new Error(`parseBinCsv: no prefix/BIN column found in header [${header.join(', ')}]. Pass options.columns.prefix.`);
  const deriveRegion = options.deriveRegionFromCountry ?? true;

  const at = (row: string[], i: number): string | undefined => (i >= 0 ? row[i]?.trim() : undefined);
  const out: BinRange[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const prefix = (at(row, idx.prefix) ?? '').replace(/\D/g, '');
    if (!prefix) continue;

    const country = at(row, idx.country) || undefined;
    const regionRaw = at(row, idx.region);
    const region = (regionRaw && normalizeRegion(regionRaw)) || (deriveRegion ? regionFromCountry(country) : 'unknown');

    const range: BinRange = { prefix, region };
    const brand = at(row, idx.brand) ? normalizeBrand(at(row, idx.brand)!) : undefined;
    if (brand) range.brand = brand;
    const issuerId = at(row, idx.issuerId);
    if (issuerId) range.issuerId = issuerId;
    if (country) range.country = country.toUpperCase();
    const cardType = at(row, idx.cardType) ? normalizeCardType(at(row, idx.cardType)!) : undefined;
    if (cardType) range.cardType = cardType;
    out.push(range);
  }
  return out;
}
