/**
 * A recovery policy: given the OBSERVABLE facts of a failed invoice (never the latent
 * recovery truth), produce an ordered list of recovery actions (day + kind). The
 * simulator strips `latent` before calling `plan`, so a policy structurally cannot peek
 * at the world's hidden state.
 */

import type { ActionKind, SimInvoice } from '../world/world.js';

/** What the policy is allowed to see — the invoice minus its hidden latent state. */
export type ObservedInvoice = Omit<SimInvoice, 'latent'>;

export interface RecoveryAction {
  /** Days since decline at which the action fires. */
  day: number;
  kind: ActionKind;
}

export interface Policy {
  readonly name: string;
  /** Ordered recovery actions (by day). Empty = do nothing (suppress). */
  plan(obs: ObservedInvoice): RecoveryAction[];
}

export function observed(inv: SimInvoice): ObservedInvoice {
  const { latent: _latent, ...rest } = inv;
  return rest;
}
