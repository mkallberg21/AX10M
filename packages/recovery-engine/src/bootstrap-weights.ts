/**
 * Shipped bootstrap recoverability prior.
 *
 * Fitted by `trainBootstrap()` (train-cli.ts) on the grounded synthetic corpus — a
 * deterministic run (corpus seed 42, split seed 7, train seed 11). Held-out metrics:
 * trained AUC 0.8814 vs heuristic AUC 0.8694, log-loss 0.3853. This is a BOOTSTRAP
 * prior, not a claim of real-world lift; retrain on the live ledger via
 * `samplesFromLedger` once outcomes exist. Regenerate — do not hand-edit — per the
 * train-cli.ts header.
 */

import type { RecoverabilityWeights } from './logistic.js';

export const BOOTSTRAP_RECOVERABILITY_WEIGHTS: RecoverabilityWeights = {
  w: [
    0.8674529407108857, 1.929618446457936, 2.0768376875465875, 1.02780918935547, 0.9735159575505323,
    1.9162436788636872, -2.356503799447911, -2.2522725813000264, -2.337045936229741, -2.547774772156207,
    -0.00017700698810964633, 0.003046747732454811, -0.0007097497166225015, 0.38392796964212844,
    0.001610010273581861, -1.524404969713298, -0.002851313107505174, -1.0760729545416154, -0.40614927832681585,
    -0.46874256420180416, -0.3143667972835115, -0.32678869532336596, -0.33141156191903254, 0.1686384764592868,
    1.8104867813843362, -2.9135357617094355, -1.2252760426310667, 3.41097215762851,
  ],
  b: -2.033594753612319,
  meta: {
    corpus: 'synthetic-bootstrap',
    corpusN: 8000,
    trainedAuc: 0.8814,
    heuristicAuc: 0.8694,
    logLoss: 0.3853,
    note: 'Bootstrap prior fit on a grounded synthetic DGP — retrain on the live ledger via samplesFromLedger.',
  },
};
