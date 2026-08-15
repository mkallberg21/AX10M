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
import { aaTest, baselineReachSweep, powerCurve, sensitivitySweep } from './checks.js';
import { computeByCode, computeVerdict, cumulativePerInvoice, renderLiftSvg, renderReportMd, type RunResults } from './report.js';

const STREAM_SEED = 20260814;
const N_CUSTOMERS = 40_000;
const MAX_CHART_DAY = 40;

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
  // If the engine only beats the DEFAULT baseline but loses to one that retries as
  // far, the top-line must say so — the "gain" is a window-length artifact.
  const rFirst = baselineReach[0];
  const rLast = baselineReach[baselineReach.length - 1];
  if (rFirst && rLast && rFirst.rateDiff > 0 && rLast.rateDiff < 0) {
    verdict += ' — BUT this edge is a longer-retry-window artifact: against a baseline that retries as far as the engine, the engine LOSES (see the fairness sweep). On recovery rate alone the engine does not beat a persistent baseline.';
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
