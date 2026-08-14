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

// ── issuer region from BIN ─────────────────────────────────────────────────────

/** Maps a card BIN/IIN to a coarse issuer region. */
export interface IssuerRegionIndex {
  region(bin: string | undefined): IssuerRegion;
}

/** One BIN-prefix → region rule. */
export interface BinRange {
  prefix: string;
  region: IssuerRegion;
}

/**
 * Longest-prefix BIN→region lookup over a rules table. The default table is a small
 * ILLUSTRATIVE seed — replace `BinRegionIndex.from(...)` with a licensed BIN database
 * for production coverage. The mechanism (longest-prefix match, unknown fallback) is
 * what's real; the specific ranges are placeholders.
 */
export class BinRegionIndex implements IssuerRegionIndex {
  private readonly ranges: BinRange[];
  constructor(ranges: BinRange[]) {
    // Longest prefixes first so `region()` returns the most specific match.
    this.ranges = ranges.slice().sort((a, b) => b.prefix.length - a.prefix.length);
  }
  static from(ranges: BinRange[]): BinRegionIndex {
    return new BinRegionIndex(ranges);
  }
  region(bin: string | undefined): IssuerRegion {
    if (!bin) return 'unknown';
    const digits = bin.replace(/\D/g, '');
    for (const r of this.ranges) if (digits.startsWith(r.prefix)) return r.region;
    return 'unknown';
  }
}

/** Illustrative seed table — NOT authoritative; swap for a real BIN DB. */
export const DEFAULT_BIN_REGION_INDEX = BinRegionIndex.from([
  { prefix: '4', region: 'na' }, // placeholder default for Visa ranges
  { prefix: '41', region: 'na' },
  { prefix: '42', region: 'emea' },
  { prefix: '49', region: 'emea' },
  { prefix: '51', region: 'na' },
  { prefix: '52', region: 'latam' },
  { prefix: '53', region: 'emea' },
  { prefix: '55', region: 'na' },
  { prefix: '35', region: 'apac' }, // JCB — APAC
  { prefix: '62', region: 'apac' }, // UnionPay — APAC
  { prefix: '34', region: 'na' }, // Amex
  { prefix: '37', region: 'na' },
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
  private static issuerKey(bin: string): string {
    return bin.replace(/\D/g, '').slice(0, 8);
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

    if (params.bin) {
      const ik = RecoveryFeatureStore.issuerKey(params.bin);
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

    const issuer = ctx.bin ? this.issuers.get(RecoveryFeatureStore.issuerKey(ctx.bin)) : undefined;
    const issuerApprovalPrior = shrinkRate(issuer?.recovered ?? 0, issuer?.total ?? 0, this.config.issuerPrior);

    const tenureSource = ctx.customerCreatedAt ?? c?.createdAt ?? c?.firstSeen ?? ctx.now;

    return {
      declineCode: ctx.declineCode ?? DeclineCode.Unknown,
      amountMinor: ctx.amountMinor,
      currency: ctx.currency,
      issuerRegion: this.config.regionIndex.region(ctx.bin),
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
    const a = this.issuers.get(RecoveryFeatureStore.issuerKey(bin));
    if (!a) return undefined;
    return { total: a.total, recovered: a.recovered, rate: shrinkRate(a.recovered, a.total, this.config.issuerPrior) };
  }
}
