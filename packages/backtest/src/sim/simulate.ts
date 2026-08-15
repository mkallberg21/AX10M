/**
 * Run a policy over a stream of invoices and adjudicate each through the world model.
 * A policy's actions are tried in day order; the first one the world lets succeed
 * recovers the invoice (records the day, for the cumulative chart). All success draws
 * are seeded per invoice, so the whole run is deterministic.
 */

import { deriveSeed, mulberry32 } from '../rng.js';
import { actionSucceeds, type SimInvoice, type WorldParams, DEFAULT_WORLD_PARAMS } from '../world/world.js';
import { observed, type Policy } from '../policy/policy.js';

export interface InvoiceOutcome {
  invoice: SimInvoice;
  recovered: boolean;
  recoveredMinor: number;
  /** Day the recovery landed (null if never recovered). */
  recoveryDay: number | null;
  /** Charge-retry attempts actually FIRED (up to success). Drives the cost/compliance objective. */
  retriesMade: number;
}

export function runPolicy(
  invoices: readonly SimInvoice[],
  policy: Policy,
  seed: number,
  params: WorldParams = DEFAULT_WORLD_PARAMS,
): InvoiceOutcome[] {
  const out: InvoiceOutcome[] = [];
  for (const inv of invoices) {
    const actions = policy.plan(observed(inv)).slice().sort((a, b) => a.day - b.day);
    const rng = mulberry32(deriveSeed(seed, inv.id));
    let recovered = false;
    let recoveryDay: number | null = null;
    let retriesMade = 0;
    for (const a of actions) {
      if (a.kind === 'retry') retriesMade++; // count network charge attempts fired
      if (actionSucceeds(inv, a.day, a.kind, rng, params)) {
        recovered = true;
        recoveryDay = a.day;
        break;
      }
    }
    out.push({ invoice: inv, recovered, recoveredMinor: recovered ? inv.amountMinor : 0, recoveryDay, retriesMade });
  }
  return out;
}

/** Overall recovery rate + recovered dollars for an arm. */
export function armSummary(outcomes: readonly InvoiceOutcome[]): { n: number; recovered: number; rate: number; recoveredMinor: number } {
  const n = outcomes.length;
  const recovered = outcomes.filter((o) => o.recovered).length;
  const recoveredMinor = outcomes.reduce((a, o) => a + o.recoveredMinor, 0);
  return { n, recovered, rate: n > 0 ? recovered / n : 0, recoveredMinor };
}
