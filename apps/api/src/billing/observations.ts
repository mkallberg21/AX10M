/**
 * Reconstruct billing observations from the persisted ledger.
 *
 * The billable fee is 12% of the PROVEN incremental uplift (holdout lower bound), not gross
 * recovered. To compute it, @ax10m/attribution needs one UpliftObservation per failed invoice
 * carrying its holdout arm, cluster, stratum, covariate, and the realized net-recovered outcome.
 * The ledger already has all of it: `holdout.assigned` gives arm/cluster/stratum/covariate at
 * failure time; `case.recovered` − `case.reversed` + `case.reversal_reverted` give the net outcome.
 *
 * A billing PERIOD is the cohort of invoices ASSIGNED (failed) within [start, end); their outcome
 * is measured as of now (a recovery/reversal may land after the window closes — that's fine, the
 * cohort is fixed by assignment time). Pure + deterministic.
 */

import type { UpliftObservation } from '@ax10m/attribution';

export interface BillingPeriod {
  label: string; // "YYYY-MM"
  startMs: number; // inclusive
  endMs: number; // exclusive
}

/** Minimal ledger-entry shape this reader needs (LedgerEntry is structurally assignable). */
export interface BillingLedgerEntry {
  merchantId: string;
  type: string;
  occurredAt: string;
  detail: Record<string, unknown>;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The previous full calendar month (UTC) relative to `nowIso` — what a monthly run bills. */
export function previousMonth(nowIso: string): BillingPeriod {
  const now = new Date(nowIso);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  const label = new Date(start).toISOString().slice(0, 7);
  return { label, startMs: start, endMs: end };
}

/** Distinct merchant ids present in the ledger. */
export function merchantsInLedger(entries: readonly BillingLedgerEntry[]): string[] {
  return [...new Set(entries.map((e) => e.merchantId))];
}

/**
 * Build the UpliftObservation cohort for one merchant + period. The cohort is the set of invoices
 * whose `holdout.assigned` occurred in the window; each observation's outcome is that invoice's
 * net recovered amount (all-time), so a recovery or reversal after the window is reflected.
 */
export function reconstructObservations(entries: readonly BillingLedgerEntry[], merchantId: string, period: BillingPeriod): UpliftObservation[] {
  // Net recovered per invoice, all-time (recovery may post after the assignment window).
  const net = new Map<string, number>();
  for (const e of entries) {
    if (e.merchantId !== merchantId) continue;
    const invoiceId = str(e.detail.invoiceId);
    if (!invoiceId) continue;
    if (e.type === 'case.recovered') net.set(invoiceId, (net.get(invoiceId) ?? 0) + num(e.detail.amount));
    else if (e.type === 'case.reversed') net.set(invoiceId, (net.get(invoiceId) ?? 0) - num(e.detail.amount));
    else if (e.type === 'case.reversal_reverted') net.set(invoiceId, (net.get(invoiceId) ?? 0) + num(e.detail.amount));
  }

  const observations: UpliftObservation[] = [];
  for (const e of entries) {
    if (e.type !== 'holdout.assigned' || e.merchantId !== merchantId) continue;
    const t = Date.parse(e.occurredAt);
    if (Number.isNaN(t) || t < period.startMs || t >= period.endMs) continue;
    const invoiceId = str(e.detail.invoiceId);
    const bucket = str(e.detail.bucket);
    if (!invoiceId || (bucket !== 'treatment' && bucket !== 'control')) continue;
    const outcome = net.get(invoiceId) ?? 0; // net recovered $ for this invoice (minor units)
    observations.push({
      arm: bucket,
      cluster: str(e.detail.customerId) ?? invoiceId,
      stratum: str(e.detail.stratumKey) ?? 'default',
      outcome,
      covariate: num(e.detail.amount), // invoice face value → CUPED covariate
      recovered: outcome > 0,
    });
  }
  return observations;
}
