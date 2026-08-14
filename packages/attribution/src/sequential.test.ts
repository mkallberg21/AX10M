import { describe, expect, it } from 'vitest';
import {
  computeBillableUplift,
  fitCuped,
  msprtHalfWidth,
  msprtHalfWidthFromSe,
  DEFAULT_SEQUENTIAL_CONFIG,
  type SequentialUpliftConfig,
  type UpliftObservation,
} from './sequential.js';

/** Deterministic PRNG (LCG) — no Math.random, so tests are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Build window-closed observations for one arm. outcome = amount if recovered
 * else 0; covariate = amount (a strong predictor of outcome variance → CUPED
 * should bite). One invoice per customer (cluster).
 */
function makeArm(params: {
  arm: 'control' | 'treatment';
  n: number;
  rate: number;
  meanAmount: number;
  spread: number;
  seed: number;
  stratum?: string;
  clusterPrefix?: string;
}): UpliftObservation[] {
  const rng = lcg(params.seed);
  const out: UpliftObservation[] = [];
  for (let i = 0; i < params.n; i++) {
    const recovered = rng() < params.rate;
    const amount = Math.round(params.meanAmount + (rng() - 0.5) * params.spread);
    out.push({
      arm: params.arm,
      cluster: `${params.clusterPrefix ?? params.arm}_${i}`,
      stratum: params.stratum ?? 's1',
      outcome: recovered ? amount : 0,
      covariate: amount,
      recovered,
    });
  }
  return out;
}

const billableConfig: SequentialUpliftConfig = {
  ...DEFAULT_SEQUENTIAL_CONFIG,
  tau2: 4_000_000,
  expectedControlFraction: 0.1,
};

describe('msprtHalfWidth', () => {
  it('is non-negative and zero for degenerate inputs', () => {
    expect(msprtHalfWidth(0, 100, 1e6, 0.05)).toBe(0);
    expect(msprtHalfWidth(1e6, 0, 1e6, 0.05)).toBe(0);
    expect(msprtHalfWidth(1e6, 100, 0, 0.05)).toBe(0);
    expect(msprtHalfWidth(1e6, 100, 1e6, 0.05)).toBeGreaterThan(0);
  });

  it('agrees with the SE-form when n = perObsVar/SE²', () => {
    const perObsVar = 250_000; // (~$5 sd)²
    const n = 900;
    const tau2 = 1_000_000;
    const alpha = 0.05;
    const se = Math.sqrt(perObsVar / n);
    const h1 = msprtHalfWidth(perObsVar, n, tau2, alpha);
    const h2 = msprtHalfWidthFromSe(se, tau2, alpha);
    expect(h1).toBeCloseTo(h2, 6);
  });

  it('is WIDER than a fixed-horizon 95% CI (the price of anytime validity)', () => {
    const se = 150;
    const fixed = 1.96 * se;
    const anytime = msprtHalfWidthFromSe(se, 4_000_000, 0.05);
    expect(anytime).toBeGreaterThan(fixed);
  });

  it('shrinks toward zero as the sample grows (√(log n / n) rate)', () => {
    const perObsVar = 1_000_000;
    const tau2 = 4_000_000;
    const small = msprtHalfWidth(perObsVar, 1_000, tau2, 0.05);
    const large = msprtHalfWidth(perObsVar, 1_000_000, tau2, 0.05);
    expect(large).toBeLessThan(small);
    expect(large).toBeGreaterThan(0);
  });
});

describe('fitCuped', () => {
  it('returns zero θ for an uninformative covariate (cannot manufacture signal)', () => {
    const y = [10, 0, 30, 0, 50];
    const xConst = [7, 7, 7, 7, 7];
    const fit = fitCuped(y, xConst);
    expect(fit.theta).toBe(0);
    expect(fit.varianceReduction).toBe(0);
  });

  it('reduces variance on a correlated covariate without moving the mean', () => {
    const rng = lcg(42);
    const y: number[] = [];
    const x: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const base = rng() * 100;
      x.push(base);
      y.push(base + (rng() - 0.5) * 20); // y strongly tracks x
    }
    const fit = fitCuped(y, x);
    expect(fit.varianceReduction).toBeGreaterThan(0.5); // ρ² should be high

    const ybar = y.reduce((a, b) => a + b, 0) / y.length;
    const xbar = fit.xbar;
    const adjusted = y.map((yi, i) => yi - fit.theta * (x[i]! - xbar));
    const adjMean = adjusted.reduce((a, b) => a + b, 0) / adjusted.length;
    // CUPED preserves the mean (unbiased).
    expect(adjMean).toBeCloseTo(ybar, 6);

    const rawVar = variance(y);
    const adjVar = variance(adjusted);
    expect(adjVar).toBeLessThan(rawVar);
  });
});

describe('computeBillableUplift', () => {
  const control = makeArm({ arm: 'control', n: 1200, rate: 0.4, meanAmount: 10_000, spread: 6_000, seed: 1 });
  const treatment = makeArm({ arm: 'treatment', n: 10_800, rate: 0.55, meanAmount: 10_000, spread: 6_000, seed: 2 });
  const obs = [...control, ...treatment];

  it('bills the LOWER BOUND, strictly below the point estimate, and is billable on a clean large sample', () => {
    const r = computeBillableUplift(obs, billableConfig);
    expect(r.treatmentRate).toBeGreaterThan(r.controlRate);
    expect(r.deltaPer).toBeGreaterThan(0);
    expect(r.lowerPer).toBeLessThan(r.deltaPer); // under-claim
    expect(r.lowerPer).toBeGreaterThan(0);
    expect(r.billable).toBe(true);
    expect(r.gateReasons).toHaveLength(0);
  });

  it('charges exactly feeRate of the newly-proven increment', () => {
    const prior = 1_000_00; // $1,000 already billed this epoch
    const r = computeBillableUplift(obs, billableConfig, prior);
    expect(r.billableIncrement.amount).toBe(r.lowerDollarsCum.amount - prior);
    expect(r.fee.amount).toBe(Math.round(r.billableIncrement.amount * billableConfig.feeRate));
  });

  it('CUPED tightens the interval → a higher (or equal) billable lower bound', () => {
    const withCuped = computeBillableUplift(obs, { ...billableConfig, useCuped: true });
    const withoutCuped = computeBillableUplift(obs, { ...billableConfig, useCuped: false });
    expect(withCuped.cupedVarianceReduction).toBeGreaterThan(0);
    expect(withCuped.se).toBeLessThan(withoutCuped.se);
    expect(withCuped.halfWidth).toBeLessThan(withoutCuped.halfWidth);
    expect(withCuped.lowerPer).toBeGreaterThanOrEqual(withoutCuped.lowerPer);
  });

  it('withholds the fee below the minimum sample size', () => {
    const c = makeArm({ arm: 'control', n: 100, rate: 0.4, meanAmount: 10_000, spread: 6_000, seed: 3 });
    const t = makeArm({ arm: 'treatment', n: 200, rate: 0.55, meanAmount: 10_000, spread: 6_000, seed: 4 });
    const r = computeBillableUplift([...c, ...t], billableConfig);
    expect(r.billable).toBe(false);
    expect(r.fee.amount).toBe(0);
    expect(r.gateReasons.join(' ')).toMatch(/treated invoices|control customers/);
  });

  it('auto-pauses billing on a sample-ratio mismatch', () => {
    // 30/70 split against an expected 10% control → SRM breach.
    const c = makeArm({ arm: 'control', n: 3000, rate: 0.4, meanAmount: 10_000, spread: 6_000, seed: 5, clusterPrefix: 'c' });
    const t = makeArm({ arm: 'treatment', n: 7000, rate: 0.55, meanAmount: 10_000, spread: 6_000, seed: 6, clusterPrefix: 't' });
    const r = computeBillableUplift([...c, ...t], billableConfig);
    expect(r.srm.breached).toBe(true);
    expect(r.billable).toBe(false);
    expect(r.gateReasons.join(' ')).toMatch(/SRM/);
  });

  it('treats a negative increment as a credit, never a silent absorption (§7.4)', () => {
    const cum = computeBillableUplift(obs, billableConfig).lowerDollarsCum.amount;
    const r = computeBillableUplift(obs, billableConfig, cum + 500_00); // prior exceeds cumulative
    expect(r.billable).toBe(true);
    expect(r.billableIncrement.amount).toBeLessThan(0);
    expect(r.fee.amount).toBeLessThan(0); // a credit
  });

  it('post-stratifies across heterogeneous cohorts', () => {
    const cEnt = makeArm({ arm: 'control', n: 400, rate: 0.45, meanAmount: 50_000, spread: 10_000, seed: 7, stratum: 'ent', clusterPrefix: 'ce' });
    const tEnt = makeArm({ arm: 'treatment', n: 3600, rate: 0.58, meanAmount: 50_000, spread: 10_000, seed: 8, stratum: 'ent', clusterPrefix: 'te' });
    const cMic = makeArm({ arm: 'control', n: 400, rate: 0.3, meanAmount: 2_000, spread: 1_000, seed: 9, stratum: 'mic', clusterPrefix: 'cm' });
    const tMic = makeArm({ arm: 'treatment', n: 3600, rate: 0.4, meanAmount: 2_000, spread: 1_000, seed: 10, stratum: 'mic', clusterPrefix: 'tm' });
    const r = computeBillableUplift([...cEnt, ...tEnt, ...cMic, ...tMic], billableConfig);
    expect(r.perStratum.map((s) => s.stratumKey).sort()).toEqual(['ent', 'mic']);
    // Aggregate is a treated-volume-weighted average of within-stratum effects.
    const wSum = r.perStratum.reduce((a, s) => a + s.weight, 0);
    expect(wSum).toBeCloseTo(1, 6);
  });
});

/** Population variance helper for assertions. */
function variance(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
}
