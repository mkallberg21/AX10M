# AX10M Recovery Services Agreement — **DRAFT**

> ⚠️ **DRAFT — NOT LEGAL ADVICE. REVIEW BY COUNSEL REQUIRED BEFORE USE.**
>
> This is starter text so the opt-in flow has real, versioned terms to hash and sign. The
> canonical, machine-hashed body lives in [`src/terms.ts`](src/terms.ts) as `CURRENT_TERMS_BODY`
> — **this file is the human-readable mirror and the two must be kept in sync** (the acceptance
> record binds to the hash of the `terms.ts` body). Before using with a real customer, counsel
> must review the fee mechanic, the finance-charge / usury compliance per jurisdiction, the
> auto-pay authorization language, and the limitation/warranty/indemnity/governing-law clauses
> (§9 is a placeholder).

**Version:** `2026-08-16.v1-draft`

---

1. **Service.** AX10M provides automated failed-payment recovery that operates alongside the
   Merchant's payment processor(s). AX10M measures the incremental recovery it produces using a
   randomized holdout (a control group that receives no AX10M treatment), so the Merchant is
   billed only for recovery AX10M can prove it caused.

2. **Fee.** The Merchant pays AX10M **12% of the Proven Incremental Uplift** for each monthly
   period. "Proven Incremental Uplift" = the holdout-verified lower bound of the net incremental
   recovered amount newly proven in that period, per the signed monthly Uplift Statement. AX10M
   never bills the same uplift twice, and bills **$0** in any period the holdout has not proven
   positive incremental recovery at the required confidence.

3. **Net of reversals.** The billable amount is net of refunds and chargebacks (fee clawed back on
   reversal; re-accrued if a chargeback is later won and funds reinstated).

4. **Billing & payment terms.** Monthly invoice for the prior period, **due net-14**.
   - **Auto-pay:** the Merchant authorizes AX10M (via its processor) to auto-charge the designated
     payment method on/after the invoice date; revocable on notice.
   - **Invoice:** due within 14 days by the remittance methods on the invoice.

5. **Late finance charge.** Undisputed amounts unpaid after net-14 accrue **1.5%/month** (or the
   max rate permitted by law, if lower) on the outstanding balance from the due date until paid.
   This is a finance charge on overdue amounts, **not a penalty** — the fee rate itself does not
   change.

6. **Disputes.** Each Uplift Statement is signed and independently verifiable against the
   Merchant's own processor payout reports. Good-faith disputes raised within net-14 pause finance
   charges on the disputed amount while pending.

7. **No card data.** AX10M does not store card numbers (SAQ-A; opaque processor tokens only).

8. **Term & termination.** Either party may terminate on notice; accrued fees remain payable.

9. **Limitation.** *[PLACEHOLDER — limitation of liability, warranty disclaimer, indemnity,
   governing law, arbitration/venue to be supplied by counsel.]*
