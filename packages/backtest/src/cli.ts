/**
 * Backtest entrypoint. Runs the main engine-vs-baseline comparison through the real
 * estimator, then the four validity checks, and writes results.json / report.md /
 * lift.svg to packages/backtest/out/. Deterministic: fixed seeds → identical output.
 *
 *   corepack pnpm --filter @ax10m/backtest run backtest
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { deriveSeed } from './rng.js';
import { generateStream } from './world/world.js';
import { EnginePolicy } from './policy/engine-policy.js';
import { StripeSmartRetriesBaseline } from './baselines/smart-retries.js';
import { runComparison } from './estimate.js';
import { armSummary } from './sim/simulate.js';
import { aaTest, baselineReachSweep, fineSensitivity, netValueComparison, powerCurve, sensitivitySweep } from './checks.js';
import { computeByCode, computeVerdict, cumulativePerInvoice, renderLiftSvg, renderReportMd, type RunResults } from './report.js';

const STREAM_SEED = 20260814;
const N_CUSTOMERS = 40_000;
const MAX_CHART_DAY = 40;

const pp = (x: number): string => `${(x * 100).toFixed(2)} pp`;

export async function runBacktest(): Promise<RunResults> {
  const invoices = generateStream(N_CUSTOMERS, STREAM_SEED);
  const controlPolicy = new StripeSmartRetriesBaseline();
  const treatmentPolicy = new EnginePolicy();
  const controlSeed = deriveSeed(STREAM_SEED, 'control');
  const treatmentSeed = deriveSeed(STREAM_SEED, 'treatment');

  const cmp = runComparison({ invoices, controlPolicy, treatmentPolicy, controlSeed, treatmentSeed });
  const cs = armSummary(cmp.controlOutcomes);
  const ts = armSummary(cmp.treatmentOutcomes);
  const baselineReach = baselineReachSweep(20_000, deriveSeed(STREAM_SEED, 'reach'));
  let verdict = computeVerdict(cmp.estimate);
  // Fairness-aware caveat. The win is real vs the DEFAULT baseline (a capability edge:
  // dead-credential recovery a retry can't copy); against a maximally-persistent baseline
  // it narrows to ~parity on recovery rate (won on cost/compliance instead). State the
  // shape honestly regardless of the headline sign.
  const rFirst = baselineReach[0];
  const rLast = baselineReach[baselineReach.length - 1];
  if (rFirst && rLast) {
    if (rLast.rateDiff < -0.02) {
      verdict += ` — CAVEAT: the win is over the DEFAULT-reach baseline (${pp(rFirst.rateDiff)}); against a maximally-persistent baseline the engine LOSES on recovery rate (${pp(rLast.rateDiff)}). See the fairness sweep.`;
    } else if (Math.abs(rLast.rateDiff) <= 0.04) {
      verdict += ` — CAVEAT: this ${pp(rFirst.rateDiff)} win is over the DEFAULT-reach baseline (what merchants run); against a maximally-persistent baseline it is ~parity on recovery rate (${pp(rLast.rateDiff)}) — the durable edge is the dead-credential capability + cost/compliance, not raw rate vs an all-out retrier.`;
    }
  }

  const results: RunResults = {
    inputs: {
      nCustomers: N_CUSTOMERS,
      streamSeed: STREAM_SEED,
      controlSeed,
      treatmentSeed,
      controlPolicy: controlPolicy.name,
      treatmentPolicy: treatmentPolicy.name,
    },
    controlSummary: { n: cs.n, rate: cs.rate, recoveredMinor: cs.recoveredMinor },
    treatmentSummary: { n: ts.n, rate: ts.rate, recoveredMinor: ts.recoveredMinor },
    estimate: cmp.estimate,
    aa: aaTest(N_CUSTOMERS, deriveSeed(STREAM_SEED, 'aa')),
    power: powerCurve(deriveSeed(STREAM_SEED, 'power'), [1, 3, 5, 10]),
    sensitivity: sensitivitySweep(20_000, deriveSeed(STREAM_SEED, 'sens')),
    baselineReach,
    netValue: netValueComparison(N_CUSTOMERS, deriveSeed(STREAM_SEED, 'nv')),
    fineSensitivity: fineSensitivity(N_CUSTOMERS, deriveSeed(STREAM_SEED, 'fs')),
    byCode: computeByCode(cmp.controlOutcomes, cmp.treatmentOutcomes),
    verdict,
  };
  return results;
}

async function main(): Promise<void> {
  const results = await runBacktest();
  const outDir = path.resolve(fileURLToPath(new URL('../out/', import.meta.url)));
  await fs.mkdir(outDir, { recursive: true });

  // Re-run the main arms once for the chart series (cheap; same seeds → same outcomes).
  const invoices = generateStream(results.inputs.nCustomers, results.inputs.streamSeed);
  const cmp = runComparison({
    invoices,
    controlPolicy: new StripeSmartRetriesBaseline(),
    treatmentPolicy: new EnginePolicy(),
    controlSeed: results.inputs.controlSeed,
    treatmentSeed: results.inputs.treatmentSeed,
  });
  const ctrlSeries = cumulativePerInvoice(cmp.controlOutcomes, MAX_CHART_DAY);
  const treatSeries = cumulativePerInvoice(cmp.treatmentOutcomes, MAX_CHART_DAY);
  const svg = renderLiftSvg(ctrlSeries, treatSeries, results.estimate.lowerPer / 100, results.verdict);

  await fs.writeFile(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  await fs.writeFile(path.join(outDir, 'report.md'), renderReportMd(results));
  await fs.writeFile(path.join(outDir, 'lift.svg'), svg);

  // eslint-disable-next-line no-console
  console.log(results.verdict);
  // eslint-disable-next-line no-console
  console.log(`A/A: ${results.aa.passed ? 'PASS' : 'FAIL'} · wrote results.json, report.md, lift.svg → ${outDir}`);
}

// Run ONLY when invoked directly (dist/cli.js) — never on import (index re-exports this).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
