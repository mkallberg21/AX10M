/**
 * Deterministic PRNG for the backtest — self-contained (not imported from the engine)
 * so the world model shares no randomness source with the policy under test.
 * mulberry32 + a few samplers. Everything is seeded and threaded explicitly; there is
 * no `Math.random` anywhere in this package.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a child seed from a base seed + a string tag (stable, order-independent). */
export function deriveSeed(base: number, tag: string): number {
  let h = base >>> 0;
  for (let i = 0; i < tag.length; i++) {
    h = Math.imul(h ^ tag.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Approximate standard normal via Box–Muller (deterministic given rng). */
export function normal(rng: Rng, mean: number, sd: number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + sd * z;
}

/** Lognormal by exponentiating a normal (for invoice amounts). */
export function lognormal(rng: Rng, muLog: number, sigmaLog: number): number {
  return Math.exp(normal(rng, muLog, sigmaLog));
}

/** Sample an index from a weight vector (weights need not be normalized). */
export function weightedIndex(rng: Rng, weights: readonly number[]): number {
  const total = weights.reduce((a, w) => a + w, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

export const bernoulli = (rng: Rng, p: number): boolean => rng() < p;
