/**
 * The world model (Phase 1, Step A). Generates synthetic streams of failed invoices
 * with a LATENT recovery state, and adjudicates whether a policy's recovery action
 * succeeds. Key fairness property: recovery requires an action inside the invoice's
 * [onsetDay, closeDay] window — a policy is rewarded for TIMING attempts when the
 * invoice is actually recoverable, and gets nothing for attempts outside it.
 *
 * DEAD-CREDENTIAL declines (expired / lost / stolen / closed cards) are modeled
 * separately: a plain retry recovers a reissued card ONLY via PASSIVE token pass-through
 * (the baseline's only path); the overlay adds ACTIVE Account Updater (`card_refresh`),
 * a backup rail (`alternate_rail`), and dunning (`card_update`) — recoveries a retry on
 * the original card structurally cannot reach. This split is what lets an overlay beat a
 * blanket retry for a reason the fairness sweep can't explain away.
 *
 * All randomness is seeded and threaded. No `@ax10m/recovery-engine` import — the world
 * knows nothing about the policy under test.
 */

import { DeclineCode, type IssuerRegion } from '@ax10m/canonical';
import { bernoulli, deriveSeed, lognormal, mulberry32, normal, uniform, weightedIndex, type Rng } from '../rng.js';
import {
  ACTIVE_AU_COVERAGE,
  ALT_RAIL_ONSET_DAY,
  ALT_RAIL_PREVALENCE,
  AMOUNT_MU_LOG,
  AMOUNT_SIGMA_LOG,
  BASE_RECOVERABLE,
  DECLINE_MIX,
  DEFAULT_REISSUE_RATE,
  DUNNING_ONSET_DAY,
  DUNNING_RESPONSE,
  INVOICES_PER_CUSTOMER_WEIGHTS,
  ONSET_KIND,
  ONSET_PARAMS,
  PASSIVE_TOKEN_COVERAGE,
  REGION_MIX,
  REISSUE_RATE,
  RESIDUAL_SUCCESS_ALT_RAIL,
  RESIDUAL_SUCCESS_CARD_UPDATE,
  RESIDUAL_SUCCESS_DUNNING,
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
  /** Scales the OVERLAY-ONLY dead-credential paths (active-AU edge, alt-rail, dunning). */
  credEdgeScale: number;
}

export const DEFAULT_WORLD_PARAMS: WorldParams = {
  recoverableScale: 1,
  onsetScale: 1,
  windowScale: 1,
  residualScale: 1,
  nsfShareScale: 1,
  credEdgeScale: 1,
};

export type ActionKind = 'retry' | 'card_update' | 'card_refresh' | 'alternate_rail';

/** Latent dead-credential capabilities (present only for reissue-kind declines). */
export interface CredLatent {
  reissued: boolean;
  reissueDay: number;
  /** A plain retry recovers the reissued card (passive network-token pass-through). */
  passiveTokenRail: boolean;
  /** Active Account Updater recovers the reissued card (⊇ passiveTokenRail). */
  activeAuCovered: boolean;
  /** Customer has a usable stored backup method. */
  hasAltRail: boolean;
  /** Customer acts on a dunning card-update prompt. */
  dunningResponder: boolean;
}

export interface SimInvoice {
  id: string;
  customerId: string;
  declineCode: DeclineCode;
  amountMinor: number;
  issuerRegion: IssuerRegion;
  /** Hidden truth the policy never sees. */
  latent: { recoverable: boolean; onsetDay: number; closeDay: number; cred?: CredLatent };
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

/** Build the dead-credential latent for a reissue-kind decline. */
function sampleCred(code: DeclineCode, rng: Rng, params: WorldParams): { cred: CredLatent; recoverable: boolean; onsetDay: number } {
  const reissueDay = sampleOnset('reissue', rng, params);
  const reissued = bernoulli(rng, clamp01((REISSUE_RATE[code] ?? DEFAULT_REISSUE_RATE) * params.recoverableScale));
  const passiveTokenRail = reissued && bernoulli(rng, clamp01(PASSIVE_TOKEN_COVERAGE));
  // Active AU is a SUPERSET of passive, at the higher coverage level. The extra coverage
  // (beyond passive) is the overlay's edge, and is what credEdgeScale sweeps.
  const extraP = PASSIVE_TOKEN_COVERAGE >= 1 ? 0 : (ACTIVE_AU_COVERAGE - PASSIVE_TOKEN_COVERAGE) / (1 - PASSIVE_TOKEN_COVERAGE);
  const activeExtra = bernoulli(rng, clamp01(extraP * params.credEdgeScale));
  const activeAuCovered = reissued && (passiveTokenRail || activeExtra);
  const hasAltRail = bernoulli(rng, clamp01(ALT_RAIL_PREVALENCE * params.credEdgeScale));
  const dunningResponder = bernoulli(rng, clamp01(DUNNING_RESPONSE * params.credEdgeScale));
  const cred: CredLatent = { reissued, reissueDay, passiveTokenRail, activeAuCovered, hasAltRail, dunningResponder };
  // Recoverable by SOME path: a reissued card, a backup rail, or a dunning responder.
  const recoverable = reissued || hasAltRail || dunningResponder;
  return { cred, recoverable, onsetDay: reissueDay };
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

      let latent: SimInvoice['latent'];
      if (ONSET_KIND[code] === 'reissue') {
        const { cred, recoverable, onsetDay } = sampleCred(code, rng, params);
        latent = { recoverable, onsetDay, closeDay, cred };
      } else {
        const recoverable = bernoulli(rng, clamp01(BASE_RECOVERABLE[code] * params.recoverableScale));
        const onsetDay = sampleOnset(ONSET_KIND[code], rng, params);
        latent = { recoverable, onsetDay, closeDay };
      }
      invoices.push({ id: `${customerId}_inv_${k}`, customerId, declineCode: code, amountMinor, issuerRegion: region, latent });
    }
  }
  return invoices;
}

/**
 * Does a recovery action on `day` (days since decline) succeed?
 *
 * Dead-credential declines (latent.cred present) split by action:
 *   retry          → passive token pass-through only (reissued && passiveTokenRail)
 *   card_refresh   → active Account Updater (reissued && activeAuCovered ⊇ passive)
 *   alternate_rail → a stored backup method (hasAltRail), no reissue wait
 *   card_update    → dunning (dunningResponder), after a short response latency
 * Everything else (funds/transient/soft) keeps the original retry/timing model.
 */
export function actionSucceeds(inv: SimInvoice, day: number, kind: ActionKind, rng: Rng, params: WorldParams = DEFAULT_WORLD_PARAMS): boolean {
  const { recoverable, onsetDay, closeDay, cred } = inv.latent;
  if (!recoverable) return false;
  if (day > closeDay) return false;
  const resid = (base: number): boolean => rng() < clamp01(base * params.residualScale);

  if (cred) {
    switch (kind) {
      case 'retry':
        return cred.reissued && cred.passiveTokenRail && day >= cred.reissueDay && resid(RESIDUAL_SUCCESS_RETRY);
      case 'card_refresh':
        return cred.reissued && cred.activeAuCovered && day >= cred.reissueDay && resid(RESIDUAL_SUCCESS_RETRY);
      case 'alternate_rail':
        return cred.hasAltRail && day >= ALT_RAIL_ONSET_DAY && resid(RESIDUAL_SUCCESS_ALT_RAIL);
      case 'card_update':
        return cred.dunningResponder && day >= DUNNING_ONSET_DAY && resid(RESIDUAL_SUCCESS_DUNNING);
      default:
        return false;
    }
  }

  // Funds / transient / soft declines — original model.
  if (day < onsetDay) return false;
  if (kind === 'card_refresh' || kind === 'alternate_rail') return false; // not applicable here
  if (kind === 'card_update') return rng() < clamp01(RESIDUAL_SUCCESS_CARD_UPDATE * params.residualScale) * 0.3;
  return resid(RESIDUAL_SUCCESS_RETRY);
}
