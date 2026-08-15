/**
 * The world model (Phase 1, Step A). Generates synthetic streams of failed invoices
 * with a LATENT recovery state, and adjudicates whether a policy's recovery action
 * succeeds. Key fairness property: recovery requires an action inside the invoice's
 * [onsetDay, closeDay] window — a policy is rewarded for TIMING attempts when the
 * invoice is actually recoverable, and gets nothing for attempts outside it. It cannot
 * "buy" recovery by retrying blindly.
 *
 * All randomness is seeded and threaded. No `@ax10m/recovery-engine` import — the world
 * knows nothing about the policy under test.
 */

import { DeclineCode, type IssuerRegion } from '@ax10m/canonical';
import { bernoulli, deriveSeed, lognormal, mulberry32, normal, uniform, weightedIndex, type Rng } from '../rng.js';
import {
  AMOUNT_MU_LOG,
  AMOUNT_SIGMA_LOG,
  BASE_RECOVERABLE,
  DECLINE_MIX,
  INVOICES_PER_CUSTOMER_WEIGHTS,
  ONSET_KIND,
  ONSET_PARAMS,
  REGION_MIX,
  RESIDUAL_SUCCESS_CARD_UPDATE,
  RESIDUAL_SUCCESS_RETRY,
  WINDOW_CLOSE_DAY,
  type OnsetKind,
} from './sources.js';

/** Scalar multipliers on the world's key parameters, for the ±30% sensitivity sweep. */
export interface WorldParams {
  recoverableScale: number;
  onsetScale: number;
  windowScale: number;
  residualScale: number;
  /** Scales the NSF share of the decline mix (mix renormalized). */
  nsfShareScale: number;
}

export const DEFAULT_WORLD_PARAMS: WorldParams = {
  recoverableScale: 1,
  onsetScale: 1,
  windowScale: 1,
  residualScale: 1,
  nsfShareScale: 1,
};

export type ActionKind = 'retry' | 'card_update';

export interface SimInvoice {
  id: string;
  customerId: string;
  declineCode: DeclineCode;
  amountMinor: number;
  issuerRegion: IssuerRegion;
  /** Hidden truth the policy never sees. */
  latent: { recoverable: boolean; onsetDay: number; closeDay: number };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

function declineWeights(params: WorldParams): number[] {
  return DECLINE_MIX.map((d) => (d.code === DeclineCode.InsufficientFunds ? d.share * params.nsfShareScale : d.share));
}

function sampleOnset(kind: OnsetKind, rng: Rng, params: WorldParams): number {
  let day: number;
  switch (kind) {
    case 'immediate':
      day = uniform(rng, 0.1, ONSET_PARAMS.immediateMaxDay);
      break;
    case 'payday': {
      const cycle = ONSET_PARAMS.paydayCycles[rng() < 0.5 ? 0 : 1]!;
      day = Math.max(0.5, uniform(rng, 1, cycle) + normal(rng, 0, ONSET_PARAMS.paydayJitterSd));
      break;
    }
    case 'reissue':
      day = Math.max(3, normal(rng, ONSET_PARAMS.reissueMeanDay, ONSET_PARAMS.reissueSd));
      break;
    case 'uniform':
    default:
      day = uniform(rng, ONSET_PARAMS.uniformLoDay, ONSET_PARAMS.uniformHiDay);
      break;
  }
  return day * params.onsetScale;
}

/** Generate a deterministic stream keyed on `seed`. */
export function generateStream(nCustomers: number, seed: number, params: WorldParams = DEFAULT_WORLD_PARAMS): SimInvoice[] {
  const weights = declineWeights(params);
  const regionWeights = REGION_MIX.map((r) => r.share);
  const invoices: SimInvoice[] = [];
  const closeDay = Math.round(WINDOW_CLOSE_DAY * params.windowScale);

  for (let c = 0; c < nCustomers; c++) {
    const customerId = `cus_${c}`;
    const rng = mulberry32(deriveSeed(seed, customerId));
    const nInv = weightedIndex(rng, INVOICES_PER_CUSTOMER_WEIGHTS);
    for (let k = 0; k < nInv; k++) {
      const code = DECLINE_MIX[weightedIndex(rng, weights)]!.code;
      const region = REGION_MIX[weightedIndex(rng, regionWeights)]!.region;
      const amountMinor = Math.max(100, Math.round(lognormal(rng, AMOUNT_MU_LOG, AMOUNT_SIGMA_LOG)));
      const recoverable = bernoulli(rng, clamp01(BASE_RECOVERABLE[code] * params.recoverableScale));
      const onsetDay = sampleOnset(ONSET_KIND[code], rng, params);
      invoices.push({
        id: `${customerId}_inv_${k}`,
        customerId,
        declineCode: code,
        amountMinor,
        issuerRegion: region,
        latent: { recoverable, onsetDay, closeDay },
      });
    }
  }
  return invoices;
}

/**
 * Does a recovery action on `day` (days since decline) succeed? True only if the
 * invoice is recoverable AND the action lands inside [onsetDay, closeDay]. A same-card
 * retry on a dead-credential invoice works only after reissue onset (Account Updater
 * refreshes the token); a card_update comm is the intended lever there and is weak
 * elsewhere. Draw is per-action (residual execution noise).
 */
export function actionSucceeds(inv: SimInvoice, day: number, kind: ActionKind, rng: Rng, params: WorldParams = DEFAULT_WORLD_PARAMS): boolean {
  const { recoverable, onsetDay, closeDay } = inv.latent;
  if (!recoverable) return false;
  if (day < onsetDay || day > closeDay) return false;
  const isDeadCred = ONSET_KIND[inv.declineCode] === 'reissue';
  const base = kind === 'card_update' ? RESIDUAL_SUCCESS_CARD_UPDATE : RESIDUAL_SUCCESS_RETRY;
  // A card-update comm aimed at a non-dead-credential decline (e.g. NSF) is the wrong
  // lever and mostly wasted.
  const applicability = kind === 'card_update' && !isDeadCred ? 0.3 : 1;
  return rng() < clamp01(base * params.residualScale) * applicability;
}
