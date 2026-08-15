/**
 * Recovery feature store — the enrichment layer + the data flywheel.
 *
 * The recoverability model is only as good as its inputs, and the highest-signal
 * inputs are not on the invoice: how often THIS customer's failures recover, how often
 * THIS issuer/BIN approves a retry, which region the issuer is in. Those are learned
 * from accumulated outcomes. This store maintains those aggregates and turns a raw
 * failure into an enriched `RecoveryFeatures`.
 *
 * Two design rules make it trustworthy:
 *  1. LEAKAGE-FREE: `enrich()` reads only PAST outcomes. The caller enriches at
 *     decision time and records the realized outcome afterward, so a case never
 *     influences its own features.
 *  2. COLD-START SAFE: rates are Beta-shrunk toward a prior, so a customer/issuer with
 *     no history returns the prior mean, converging to the empirical rate as evidence
 *     accumulates. No divide-by-zero, no overconfident 0/1 from a single observation.
 *
 * In production the aggregates are backed by a persistent store (Postgres/Redis/Feast);
 * this in-memory implementation is the reference logic and is what the API wires today.
 */

import { DeclineCode, type IssuerRegion } from '@ax10m/canonical';
import type { RecoveryFeatures } from './recoverability.js';

/** Beta prior as pseudo-counts. mean = alpha/(alpha+beta); strength = alpha+beta. */
export interface BetaPrior {
  alpha: number;
  beta: number;
}

/** Build a Beta prior from a target mean and a strength (in pseudo-observations). */
export function betaFromMeanStrength(mean: number, strength: number): BetaPrior {
  const m = mean < 0 ? 0 : mean > 1 ? 1 : mean;
  return { alpha: m * strength, beta: (1 - m) * strength };
}

/** Shrink an empirical rate toward the prior: (s + α) / (n + α + β). */
export function shrinkRate(successes: number, total: number, prior: BetaPrior): number {
  return (successes + prior.alpha) / (total + prior.alpha + prior.beta);
}

// ── issuer / region / card metadata from BIN ───────────────────────────────────

/** What a BIN lookup yields — the joined issuer/BIN signals. */
export interface BinInfo {
  region: IssuerRegion;
  /** Stable issuer identity — approval rates aggregate by THIS (real signal), not a raw
   *  BIN prefix, so every BIN an issuer owns shares one learned rate. */
  issuerId?: string;
  /** Issuer country (ISO 3166-1 alpha-2), when the table provides it. */
  country?: string;
  /** Card brand (visa / mastercard / amex / …). */
  brand?: string;
  /** Product type — debit/prepaid recover differently than credit. */
  cardType?: 'credit' | 'debit' | 'prepaid';
}

/** Maps a card BIN/IIN to issuer/region/card metadata. */
export interface IssuerRegionIndex {
  region(bin: string | undefined): IssuerRegion;
  lookup(bin: string | undefined): BinInfo;
}

/** One BIN-prefix → issuer/region/card rule. */
export interface BinRange extends BinInfo {
  prefix: string;
}

const UNKNOWN_BIN: BinInfo = { region: 'unknown' };

/**
 * Longest-prefix BIN → issuer/region/card lookup over a rules table. The default table is
 * a small ILLUSTRATIVE seed — load a licensed BIN database (`BinRegionIndex.from(...)`,
 * e.g. from `AX10M_BIN_TABLE_PATH`) for production coverage. The mechanism (longest-prefix
 * match, issuer identity, unknown fallback) is what's real; the specific ranges are
 * placeholders until a real table is joined.
 */
export class BinRegionIndex implements IssuerRegionIndex {
  private readonly ranges: BinRange[];
  constructor(ranges: BinRange[]) {
    // Longest prefixes first so `lookup()` returns the most specific match.
    this.ranges = ranges.slice().sort((a, b) => b.prefix.length - a.prefix.length);
  }
  static from(ranges: BinRange[]): BinRegionIndex {
    return new BinRegionIndex(ranges);
  }
  lookup(bin: string | undefined): BinInfo {
    if (!bin) return UNKNOWN_BIN;
    const digits = bin.replace(/\D/g, '');
    for (const r of this.ranges) {
      if (digits.startsWith(r.prefix)) {
        const { prefix: _p, ...info } = r;
        return info;
      }
    }
    return UNKNOWN_BIN;
  }
  region(bin: string | undefined): IssuerRegion {
    return this.lookup(bin).region;
  }
}

/**
 * Illustrative seed table — NOT authoritative; swap for a real BIN DB. Includes a couple
 * of issuerId/country examples to exercise the joined-signal path.
 */
export const DEFAULT_BIN_REGION_INDEX = BinRegionIndex.from([
  { prefix: '4', region: 'na', brand: 'visa' }, // placeholder default for Visa ranges
  { prefix: '41', region: 'na', brand: 'visa', country: 'US' },
  { prefix: '42', region: 'emea', brand: 'visa', country: 'GB' },
  { prefix: '49', region: 'emea', brand: 'visa' },
  { prefix: '414720', region: 'na', brand: 'visa', country: 'US', issuerId: 'example_bank_na', cardType: 'credit' }, // issuerId/country example
  { prefix: '51', region: 'na', brand: 'mastercard' },
  { prefix: '52', region: 'latam', brand: 'mastercard' },
  { prefix: '53', region: 'emea', brand: 'mastercard' },
  { prefix: '55', region: 'na', brand: 'mastercard' },
  { prefix: '35', region: 'apac', brand: 'jcb' }, // JCB — APAC
  { prefix: '62', region: 'apac', brand: 'unionpay' }, // UnionPay — APAC
  { prefix: '34', region: 'na', brand: 'amex' }, // Amex
  { prefix: '37', region: 'na', brand: 'amex' },
]);

// ── the store ──────────────────────────────────────────────────────────────────

export interface FeatureStoreConfig {
  /** Prior for a customer's recovery rate (mean should match the population base rate). */
  customerPrior: BetaPrior;
  /** Prior for an issuer/BIN's approval rate (neutral 0.5). */
  issuerPrior: BetaPrior;
  regionIndex: IssuerRegionIndex;
}

export const DEFAULT_FEATURE_STORE_CONFIG: FeatureStoreConfig = {
  customerPrior: betaFromMeanStrength(0.35, 8), // matches the heuristic's old constant, but shrinks
  issuerPrior: betaFromMeanStrength(0.5, 10),
  regionIndex: DEFAULT_BIN_REGION_INDEX,
};

/** Everything observed about a failed invoice at decision time. */
export interface EnrichmentContext {
  merchantId: string;
  customerId: string;
  /** Card BIN/IIN (first 6-8 digits), for issuer region + approval prior. */
  bin?: string;
  /** Customer signup time, if known (best tenure source). */
  customerCreatedAt?: string;
  /** When this invoice first failed (for daysSinceFirstFail). */
  firstFailedAt?: string;
  declineCode: DeclineCode;
  amountMinor: number;
  currency: string;
  attemptNumber: number;
  /** Decision-time instant (ISO). Passed in for determinism. */
  now: string;
}

interface CustomerAgg {
  total: number;
  recovered: number;
  firstSeen: string;
  createdAt?: string;
}
interface IssuerAgg {
  total: number;
  recovered: number;
}

const MS_PER_DAY = 86_400_000;
const daysBetween = (fromIso: string | undefined, toIso: string): number => {
  if (!fromIso) return 0;
  const d = (Date.parse(toIso) - Date.parse(fromIso)) / MS_PER_DAY;
  return Number.isFinite(d) && d > 0 ? d : 0;
};

export class RecoveryFeatureStore {
  private readonly customers = new Map<string, CustomerAgg>();
  private readonly issuers = new Map<string, IssuerAgg>();

  constructor(private readonly config: FeatureStoreConfig = DEFAULT_FEATURE_STORE_CONFIG) {}

  private static customerKey(merchantId: string, customerId: string): string {
    return `${merchantId}:${customerId}`;
  }
  /**
   * Aggregate approval rates by the REAL issuer identity when the BIN table provides it
   * (all of an issuer's BINs share one learned rate — more signal); otherwise fall back to
   * the raw 8-digit BIN prefix.
   */
  private issuerKeyFor(bin: string | undefined): string | undefined {
    if (!bin) return undefined;
    const info = this.config.regionIndex.lookup(bin);
    return info.issuerId ?? bin.replace(/\D/g, '').slice(0, 8);
  }

  /**
   * Stamp first-contact time for a customer (drives tenure). Idempotent — keeps the
   * earliest instant. Call when a case opens.
   */
  observe(params: { merchantId: string; customerId: string; now: string; customerCreatedAt?: string }): void {
    const key = RecoveryFeatureStore.customerKey(params.merchantId, params.customerId);
    const c = this.customers.get(key);
    if (!c) {
      this.customers.set(key, { total: 0, recovered: 0, firstSeen: params.now, createdAt: params.customerCreatedAt });
      return;
    }
    if (Date.parse(params.now) < Date.parse(c.firstSeen)) c.firstSeen = params.now;
    if (params.customerCreatedAt && !c.createdAt) c.createdAt = params.customerCreatedAt;
  }

  /**
   * Record a realized recovery outcome. Updates the customer's recovery rate and (when
   * the BIN is known) the issuer's approval rate — the flywheel. MUST be called AFTER
   * `enrich()` for the same case to stay leakage-free.
   */
  recordOutcome(params: { merchantId: string; customerId: string; bin?: string; recovered: boolean; now?: string }): void {
    const key = RecoveryFeatureStore.customerKey(params.merchantId, params.customerId);
    const c = this.customers.get(key) ?? { total: 0, recovered: 0, firstSeen: params.now ?? '1970-01-01T00:00:00.000Z' };
    c.total += 1;
    if (params.recovered) c.recovered += 1;
    this.customers.set(key, c);

    const ik = this.issuerKeyFor(params.bin);
    if (ik) {
      const a = this.issuers.get(ik) ?? { total: 0, recovered: 0 };
      a.total += 1;
      if (params.recovered) a.recovered += 1;
      this.issuers.set(ik, a);
    }
  }

  /** Turn a raw failure into an enriched feature vector from accumulated history. */
  enrich(ctx: EnrichmentContext): RecoveryFeatures {
    const cKey = RecoveryFeatureStore.customerKey(ctx.merchantId, ctx.customerId);
    const c = this.customers.get(cKey);
    const priorRecoveryRate = shrinkRate(c?.recovered ?? 0, c?.total ?? 0, this.config.customerPrior);

    const ik = this.issuerKeyFor(ctx.bin);
    const issuer = ik ? this.issuers.get(ik) : undefined;
    const issuerApprovalPrior = shrinkRate(issuer?.recovered ?? 0, issuer?.total ?? 0, this.config.issuerPrior);

    const tenureSource = ctx.customerCreatedAt ?? c?.createdAt ?? c?.firstSeen ?? ctx.now;
    const binInfo = this.config.regionIndex.lookup(ctx.bin);

    return {
      declineCode: ctx.declineCode ?? DeclineCode.Unknown,
      amountMinor: ctx.amountMinor,
      currency: ctx.currency,
      issuerRegion: binInfo.region,
      cardType: binInfo.cardType ?? 'unknown',
      customerTenureDays: daysBetween(tenureSource, ctx.now),
      priorRecoveryRate,
      attemptNumber: ctx.attemptNumber,
      daysSinceFirstFail: daysBetween(ctx.firstFailedAt, ctx.now),
      issuerApprovalPrior,
    };
  }

  /** Observability: a customer's accumulated recovery stats (or undefined if unseen). */
  customerStats(merchantId: string, customerId: string): { total: number; recovered: number; rate: number } | undefined {
    const c = this.customers.get(RecoveryFeatureStore.customerKey(merchantId, customerId));
    if (!c) return undefined;
    return { total: c.total, recovered: c.recovered, rate: shrinkRate(c.recovered, c.total, this.config.customerPrior) };
  }

  /** Observability: an issuer/BIN's accumulated approval stats (or undefined if unseen). */
  issuerStats(bin: string): { total: number; recovered: number; rate: number } | undefined {
    const ik = this.issuerKeyFor(bin);
    const a = ik ? this.issuers.get(ik) : undefined;
    if (!a) return undefined;
    return { total: a.total, recovered: a.recovered, rate: shrinkRate(a.recovered, a.total, this.config.issuerPrior) };
  }
}
