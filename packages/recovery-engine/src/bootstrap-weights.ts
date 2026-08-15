/**
 * Shipped bootstrap recoverability prior.
 *
 * Fitted by `trainBootstrap()` (train-cli.ts) on the grounded synthetic corpus — a
 * deterministic run (corpus seed 42, split seed 7, train seed 11). Held-out metrics:
 * trained AUC 0.8757 vs heuristic AUC 0.8563, log-loss 0.3881.
 * Includes the card-product-type features (credit/debit/prepaid). This is a BOOTSTRAP
 * prior, not a claim of real-world lift; retrain on the live ledger via
 * `samplesFromLedger` once outcomes exist. Regenerate — do not hand-edit — per the
 * train-cli.ts header.
 */

import type { RecoverabilityWeights } from './logistic.js';

export const BOOTSTRAP_RECOVERABILITY_WEIGHTS: RecoverabilityWeights = {
  w: [0.9305014804868945, 1.9746666561161454, 1.9164252735024638, 0.8663526599247791, 1.2656132541898835, 2.0405854288670904, -2.506720049759609, -2.405746503887675, -2.4772048843416994, -2.3422345571403986, -0.00017700698810964633, 0.003046747732454811, -0.0007097497166225015, 0.6184682749990336, 0.001610010273581861, -1.5754191948935745, -0.002851313107505174, -1.021110329400589, -0.23616554903572978, -0.34011036038706693, -0.2856634634198469, -0.5153539104132234, -0.32228158701539295, 0.12670698793673216, 1.9368589805806615, -2.9208896145645595, -1.1618400364599357, 3.4434339907128333, -0.21375729585341594, -0.5062990331075305, -0.9785212529750347],
  b: -1.8722610394423298,
  meta: {"corpus":"synthetic-bootstrap","corpusN":8000,"trainedAuc":0.8757,"heuristicAuc":0.8563,"logLoss":0.3881,"note":"Bootstrap prior fit on a grounded synthetic DGP — retrain on the live ledger via samplesFromLedger."},
};
