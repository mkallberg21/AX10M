/**
 * Credential recovery — the overlay's edge on DEAD-CREDENTIAL declines (expired / lost /
 * stolen / closed / reissued cards), where a blanket retry structurally cannot win: you
 * cannot retry your way to a card number that changed.
 *
 * A plain retry only recovers a reissued card if the processor happens to pass the new
 * token through automatically (partial "passive" network-token / Account-Updater
 * coverage). This module drives the recoveries the passive path MISSES:
 *
 *   1. card_refresh   — actively query the card networks' Account Updater (Visa VAU /
 *                       Mastercard ABU / network tokens) for the new PAN/expiry and charge
 *                       THAT. Covers more reissued cards than passive pass-through, across
 *                       every processor — not just the ones with it built in.
 *   2. alternate_rail — charge a stored BACKUP method (second card / wallet / bank debit)
 *                       when the primary credential is dead. Recovers invoices no retry on
 *                       the original card ever can (closed accounts included).
 *   3. dunning        — prompt the customer to update the card, then charge the update.
 *
 * These map to real adapter capabilities that already exist on `ProcessorAdapter`
 * (`fetchUpdatedCard`, `listPaymentMethods`) — this planner decides WHICH to try and WHEN;
 * the adapters execute. The cadence spans the reissue window (a new card typically lands
 * over ~2–4 weeks), so the Account-Updater probes keep checking until it does.
 */

import { DeclineFamily, familyOf } from '@ax10m/canonical';
import { classifyDecline } from './decline-intel.js';
import type { AvailableMethod } from './policy.js';
import type { RecoveryFeatures } from './recoverability.js';

export type CredentialAction = 'card_refresh' | 'alternate_rail' | 'dunning';

export interface CredentialStep {
  /** ISO time to fire the step. */
  at: string;
  action: CredentialAction;
  /** Method to charge (a discovered/updated credential or a backup rail), when known. */
  methodRef?: string;
  rationale: string;
}

export interface CredentialContext {
  now: string;
  methods: AvailableMethod[];
}

const DAY_MS = 86_400_000;
const iso = (base: number, days: number): string => new Date(base + days * DAY_MS).toISOString();

/**
 * Is this a dead-credential decline — the case credential recovery targets? Hard-family
 * codes and expired cards need a NEW/updated credential, not another attempt on the old
 * one. (Fraud is excluded: never chase it.)
 */
export function isCredentialProblem(code: RecoveryFeatures['declineCode']): boolean {
  const cls = classifyDecline(code);
  if (cls.family === DeclineFamily.Hard && cls.recommendedAction === 'suppress') return false; // fraud
  return cls.recommendedAction === 'card_update';
}

/**
 * Plan the credential-recovery sequence for a dead-credential decline. Returns [] for
 * declines this path doesn't target (soft/funds declines go through ARSE retries instead).
 *
 * The Account-Updater probes are spread across the reissue window so at least one lands
 * after the new card is issued; the alternate rail is tried early (it doesn't wait on a
 * reissue); dunning nudges the customer in parallel.
 */
export function planCredentialRecovery(features: RecoveryFeatures, ctx: CredentialContext): CredentialStep[] {
  if (!isCredentialProblem(features.declineCode)) return [];
  const base = Date.parse(ctx.now);
  const alternate = ctx.methods.find((m) => !m.isDefault);
  const family = familyOf(features.declineCode);

  const steps: CredentialStep[] = [];

  // Try a backup rail immediately — it doesn't depend on a card reissue.
  steps.push({
    at: iso(base, 1),
    action: 'alternate_rail',
    methodRef: alternate?.ref,
    rationale: 'primary credential is dead — attempt a stored backup payment method',
  });

  // Account-Updater probes across the reissue window (a new card lands over ~2–4 weeks).
  // Closed/hard cards are less likely to reissue; still probe, but that's what alt-rail /
  // dunning are for.
  const probeDays = family === DeclineFamily.Hard ? [3, 21] : [2, 10, 21, 31];
  for (const d of probeDays) {
    steps.push({
      at: iso(base, d),
      action: 'card_refresh',
      rationale: `query Account Updater / network token for a refreshed credential (day ${d})`,
    });
  }

  // Dunning nudges in parallel (customer-driven card update).
  steps.push({ at: iso(base, 3), action: 'dunning', rationale: 'prompt the customer to update the card' });
  steps.push({ at: iso(base, 15), action: 'dunning', rationale: 'second card-update reminder before the window closes' });

  return steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
