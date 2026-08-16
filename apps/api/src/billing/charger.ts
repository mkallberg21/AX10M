/**
 * BillingCharger — the seam that actually collects AX10M's fee from the merchant. Fenced like the
 * recovery money path: the default NEVER charges (it records the statement as an auditable
 * invoice), and a real provider only moves money when explicitly wired AND live billing is on.
 * Charging AX10M's own fee is an outward-facing financial action, so it stays behind a flag.
 */

export interface BillingChargeRequest {
  merchantId: string;
  period: string; // "YYYY-MM"
  amountMinor: number; // the fee, minor units
  currency: string;
  statementHash: string; // ties the charge to the signed statement
}

export interface BillingChargeReceipt {
  status: 'charged' | 'skipped' | 'failed';
  provider: string;
  reference?: string;
  reason?: string;
}

export interface BillingCharger {
  charge(req: BillingChargeRequest): Promise<BillingChargeReceipt>;
}

/**
 * Default charger: records nothing external and collects nothing. The statement is still written
 * to the ledger (the invoice), but no money moves. Swap in a real provider (e.g. Stripe Billing)
 * behind AX10M_LIVE_BILLING to actually collect.
 */
export class NoopBillingCharger implements BillingCharger {
  async charge(_req: BillingChargeRequest): Promise<BillingChargeReceipt> {
    return { status: 'skipped', provider: 'noop', reason: 'no billing provider wired — statement recorded, not charged' };
  }
}
