/**
 * Reproducible bootstrap-weights trainer.
 *
 * Fits the shipped `LogisticRecoverability` prior on the grounded synthetic corpus
 * (simulate.ts), holding out a test split to report honest metrics. Deterministic
 * under the seeds below, so re-running regenerates identical weights.
 *
 * Regenerate the committed weights with:
 *   pnpm --filter @ax10m/recovery-engine build
 *   node -e "import('./packages/recovery-engine/dist/train-cli.js').then(m=>console.log(JSON.stringify(m.trainBootstrap().weights)))"
 * then paste into bootstrap-weights.ts.
 */

import { simulateSamples } from './simulate.js';
import { evaluate, splitTrainTest, trainLogisticRecoverability } from './training.js';
import { LogisticRecoverability, type RecoverabilityWeights } from './logistic.js';
import { HeuristicRecoverability } from './recoverability.js';

export interface BootstrapResult {
  weights: RecoverabilityWeights;
  trainedAuc: number;
  heuristicAuc: number;
  logLoss: number;
}

const CORPUS_N = 8000;
const CORPUS_SEED = 42;
const SPLIT_SEED = 7;
const TRAIN_SEED = 11;

/** Fit the bootstrap prior and report held-out metrics vs the heuristic. */
export function trainBootstrap(): BootstrapResult {
  const { samples } = simulateSamples(CORPUS_N, CORPUS_SEED);
  const { train, test } = splitTrainTest(samples, 0.25, SPLIT_SEED);
  const { weights } = trainLogisticRecoverability(train, { iterations: 3000, lr: 0.4, l2: 1e-4, seed: TRAIN_SEED });

  const trained = new LogisticRecoverability(weights);
  const heuristic = new HeuristicRecoverability();
  const trainedMetrics = evaluate(trained, test);
  const heuristicMetrics = evaluate(heuristic, test);

  weights.meta = {
    corpus: 'synthetic-bootstrap',
    corpusN: CORPUS_N,
    trainedAuc: round(trainedMetrics.auc),
    heuristicAuc: round(heuristicMetrics.auc),
    logLoss: round(trainedMetrics.logLoss),
    note: 'Bootstrap prior fit on a grounded synthetic DGP — retrain on the live ledger via samplesFromLedger.',
  };

  return {
    weights,
    trainedAuc: trainedMetrics.auc,
    heuristicAuc: heuristicMetrics.auc,
    logLoss: trainedMetrics.logLoss,
  };
}

function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
