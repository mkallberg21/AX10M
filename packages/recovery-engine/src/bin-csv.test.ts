import { describe, expect, it } from 'vitest';
import { parseBinCsv, parseCsv, regionFromCountry } from './bin-csv.js';

describe('parseCsv', () => {
  it('handles quoted fields with commas, escaped quotes, and CRLF', () => {
    const csv = 'a,b\r\n"x,y","he said ""hi"""\r\n1,2\r\n';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['x,y', 'he said "hi"'],
      ['1', '2'],
    ]);
  });
});

describe('regionFromCountry', () => {
  it('maps ISO alpha-2 to a coarse region, unknown otherwise', () => {
    expect(regionFromCountry('US')).toBe('na');
    expect(regionFromCountry('gb')).toBe('emea');
    expect(regionFromCountry('BR')).toBe('latam');
    expect(regionFromCountry('JP')).toBe('apac');
    expect(regionFromCountry('ZZ')).toBe('unknown');
    expect(regionFromCountry(undefined)).toBe('unknown');
  });
});

describe('parseBinCsv', () => {
  it('auto-detects common vendor column aliases and normalizes values', () => {
    const csv = [
      'BIN,Scheme,Product Type,Country,Bank Name',
      '424242,VISA,Credit,US,Chase',
      '531000,Mastercard,Debit,DE,Deutsche Bank',
      '4000-01,Visa Electron,PREPAID,BR,Nubank',
      ',,,,', // blank prefix skipped
    ].join('\n');
    const ranges = parseBinCsv(csv);
    expect(ranges).toEqual([
      { prefix: '424242', region: 'na', brand: 'visa', issuerId: 'Chase', country: 'US', cardType: 'credit' },
      { prefix: '531000', region: 'emea', brand: 'mastercard', issuerId: 'Deutsche Bank', country: 'DE', cardType: 'debit' },
      { prefix: '400001', region: 'latam', brand: 'visa', issuerId: 'Nubank', country: 'BR', cardType: 'prepaid' },
    ]);
  });

  it('honors explicit column overrides and a custom delimiter', () => {
    const csv = 'iin;net;region\n34;American Express;na\n';
    const ranges = parseBinCsv(csv, { delimiter: ';', columns: { prefix: 'iin', brand: 'net', region: 'region' } });
    expect(ranges).toEqual([{ prefix: '34', region: 'na', brand: 'amex' }]);
  });

  it('derives region from country only when there is no region column, unless disabled', () => {
    const csv = 'bin,country\n4111,US\n';
    expect(parseBinCsv(csv)[0]!.region).toBe('na'); // derived
    expect(parseBinCsv(csv, { deriveRegionFromCountry: false })[0]!.region).toBe('unknown');
  });

  it('throws a clear error when no prefix/BIN column is present', () => {
    expect(() => parseBinCsv('brand,country\nvisa,US\n')).toThrow(/no prefix\/BIN column/);
  });
});
