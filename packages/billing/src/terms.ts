/**
 * Versioned commercial terms + a tamper-evident hash of the exact text a merchant accepts.
 *
 * The canonical, machine-hashed terms body lives here as `CURRENT_TERMS_BODY` (so `hashTerms`
 * is deterministic and an acceptance record binds to the precise words agreed to). `TERMS.md`
 * in this package is the human-readable mirror.
 *
 * ⚠️ DRAFT — NOT LEGAL ADVICE. This starter text exists so the opt-in flow has real, versioned
 * terms to hash and sign. It MUST be reviewed by counsel (fee mechanic, finance-charge / usury
 * compliance per jurisdiction, auto-pay authorization language, dispute + limitation clauses)
 * before it is used with a real customer.
 */

import { sha256Hex } from './canonical-json.js';

export interface TermsVersion {
  /** Human version tag, e.g. "2026-08-16.v1-draft". */
  version: string;
  /** ISO date the version takes effect. */
  effectiveAt: string;
  /** SHA-256 hex of the exact terms body. */
  bodyHash: string;
}

/** SHA-256 of a terms body — the value bound into a signed acceptance record. */
export function hashTerms(body: string): string {
  return sha256Hex(body);
}

export const CURRENT_TERMS_VERSION = '2026-08-16.v1-draft';
export const CURRENT_TERMS_EFFECTIVE_AT = '2026-08-16';

/**
 * DRAFT AX10M Recovery Services Agreement (starter). Numbers here MUST match DEFAULT_FEE_SCHEDULE.
 * Keep this and TERMS.md in sync. Review by counsel required before production use.
 */
export const CURRENT_TERMS_BODY = `AX10M RECOVERY SERVICES AGREEMENT — DRAFT (v2026-08-16.v1-draft)

*** DRAFT — NOT LEGAL ADVICE. REVIEW BY COUNSEL REQUIRED BEFORE USE. ***

1. SERVICE. AX10M provides automated failed-payment recovery that operates alongside the
   Merchant's payment processor(s). AX10M measures the incremental recovery it produces using a
   randomized holdout (a control group that receives no AX10M treatment), so the Merchant is
   billed only for recovery that AX10M can prove it caused.

2. FEE. The Merchant agrees to pay AX10M a fee equal to twelve percent (12%) of the Proven
   Incremental Uplift for each monthly billing period. "Proven Incremental Uplift" means the
   holdout-verified lower bound of the net incremental recovered amount newly proven in that
   period, as reported in the signed monthly Uplift Statement. AX10M never bills the same uplift
   twice, and bills $0 in any period in which the holdout has not proven positive incremental
   recovery at the required statistical confidence.

3. NET OF REVERSALS. The billable amount is net of refunds and chargebacks. If a recovered
   payment is later refunded or charged back, the corresponding fee is clawed back; if a
   chargeback is subsequently won and the funds reinstated, the fee is re-accrued.

4. BILLING & PAYMENT TERMS. AX10M issues an invoice monthly for the prior period. Payment is due
   net fourteen (14) days from the invoice date.
   (a) Auto-Pay. If the Merchant enrolls in auto-pay, the Merchant authorizes AX10M (via its
       payment processor) to automatically charge the Merchant's designated payment method for
       each monthly fee on or after the invoice date. The Merchant may revoke this authorization
       on notice, after which invoices are due on the net-14 terms below.
   (b) Invoice. If the Merchant is invoiced, payment is due within fourteen (14) days by the
       remittance methods stated on the invoice.

5. LATE FINANCE CHARGE. Undisputed amounts not paid within the net-14 term accrue a finance
   charge of one and one-half percent (1.5%) per month (or the maximum rate permitted by
   applicable law, if lower) on the outstanding balance, from the due date until paid. This is a
   finance charge on overdue amounts, not a penalty, and the fee rate itself does not change.

6. DISPUTES. Each Uplift Statement is signed and independently verifiable against the Merchant's
   own processor payout reports. The Merchant may dispute an invoice in good faith within the
   net-14 term by written notice identifying the disputed amount and basis; the finance charge
   does not accrue on amounts disputed in good faith while the dispute is pending resolution.

7. NO CARD DATA. AX10M does not store the Merchant's card numbers. Payment methods are handled by
   the payment processor under SAQ-A scope; AX10M holds only opaque processor tokens.

8. TERM & TERMINATION. Either party may terminate on notice. Fees accrued for periods before
   termination remain payable. Termination does not waive amounts already proven and billed.

9. LIMITATION. [PLACEHOLDER — limitation of liability, warranty disclaimer, indemnity, governing
   law, and arbitration/venue to be supplied by counsel.]

By accepting, the individual accepting represents that they are authorized to bind the Merchant
to this Agreement, and the Merchant agrees to the fee, billing, and payment terms above.`;

/** The current terms version descriptor (version + effective date + body hash). */
export function currentTerms(): TermsVersion {
  return {
    version: CURRENT_TERMS_VERSION,
    effectiveAt: CURRENT_TERMS_EFFECTIVE_AT,
    bodyHash: hashTerms(CURRENT_TERMS_BODY),
  };
}
