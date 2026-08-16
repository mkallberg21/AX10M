/**
 * BillingPortalService — the opt-in + invoice orchestration behind the portal API.
 *
 * Opt-in flow: validate the submission → build the BillingAccount → sign a clickwrap acceptance
 * record (Ed25519, binding who/when/terms-version/fee) → persist both. No money moves here; the
 * account + acceptance are what later authorize the monthly charge/invoice.
 *
 * Invoice view: recompute the finance charge as-of now (net-14 → 1.5%/mo). Forward-to-AP:
 * COMPOSE a ready-to-send message to the accounts-payable address captured at opt-in (composition
 * only — sending is a separate, flag-gated transport).
 */

import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { Signer } from '@ax10m/attribution';
import {
  buildAcceptance,
  buildBillingAccount,
  CURRENT_TERMS_BODY,
  currentTerms,
  DEFAULT_FEE_SCHEDULE,
  invoiceAsOf,
  validateOptIn,
  type BillingAccount,
  type FeeSchedule,
  type Invoice,
  type OptInInput,
  type SignedAcceptanceRecord,
} from '@ax10m/billing';
import type { BillingAccountStore } from './billing-account-store.js';

const logger = new Logger('BillingPortal');

/** The account as returned to a client — the opaque payment token is never echoed back. */
export type AccountView = Omit<BillingAccount, 'paymentMethodRef'> & { hasPaymentMethod: boolean };

export interface OptInResult {
  account: AccountView;
  acceptance: {
    recordHash: string;
    termsVersion: string;
    signingKeyId: string;
    acceptedAt: string;
    payerTrack: BillingAccount['payerTrack'];
  };
}

export interface ForwardToApComposition {
  to: string;
  subject: string;
  body: string;
  /** True = composed only; the caller/transport decides whether to actually send. */
  composedOnly: true;
}

function toView(account: BillingAccount): AccountView {
  const { paymentMethodRef, ...rest } = account;
  return { ...rest, hasPaymentMethod: Boolean(paymentMethodRef) };
}

export class BillingPortalService {
  constructor(
    private readonly store: BillingAccountStore,
    private readonly signer: Signer,
    private readonly remitTo: string,
  ) {}

  /** The current terms (version + hash + body + fee schedule) for the portal to display pre-accept. */
  terms(): { version: string; effectiveAt: string; bodyHash: string; feeSchedule: FeeSchedule; body: string } {
    const t = currentTerms();
    return { ...t, feeSchedule: DEFAULT_FEE_SCHEDULE, body: CURRENT_TERMS_BODY };
  }

  /**
   * Opt a merchant in: validate, create the account, sign + persist the clickwrap acceptance.
   * Idempotent-ish: the account id is derived from the merchant, so re-opting-in updates the
   * account and appends a NEW acceptance record (a fresh signed agreement).
   */
  async optIn(input: OptInInput, ctx: { ip?: string; userAgent?: string; nowIso?: string }): Promise<OptInResult> {
    const errors = validateOptIn(input);
    if (errors.length > 0) throw new BadRequestException({ message: 'invalid opt-in', errors });

    const nowIso = ctx.nowIso ?? new Date().toISOString();
    const accountId = `acct_${input.merchantId}`;
    const account = buildBillingAccount(input, accountId, nowIso);
    const acceptance = buildAcceptance({
      account,
      acceptedBy: input.signer,
      acceptedAt: nowIso,
      autoPayAuthorized: input.payerTrack === 'auto_pay' ? input.autoPayAuthorized === true : false,
      signer: this.signer,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    await this.store.upsertAccount(account);
    await this.store.recordAcceptance(acceptance);
    logger.log(`Merchant ${input.merchantId} opted in (${input.payerTrack}); acceptance ${acceptance.recordHash.slice(0, 12)}… signed by ${acceptance.signingKeyId}.`);

    return {
      account: toView(account),
      acceptance: { recordHash: acceptance.recordHash, termsVersion: acceptance.termsVersion, signingKeyId: acceptance.signingKeyId, acceptedAt: acceptance.acceptedAt, payerTrack: acceptance.payerTrack },
    };
  }

  async accountFor(merchantId: string): Promise<AccountView> {
    const account = await this.store.accountForMerchant(merchantId);
    if (!account) throw new NotFoundException(`no billing account for merchant ${merchantId}`);
    return toView(account);
  }

  async invoicesFor(merchantId: string, nowIso = new Date().toISOString()): Promise<Invoice[]> {
    const invoices = await this.store.invoicesForMerchant(merchantId);
    return invoices.map((i) => invoiceAsOf(i, nowIso));
  }

  async invoice(invoiceNumber: string, nowIso = new Date().toISOString()): Promise<Invoice> {
    const inv = await this.store.getInvoice(invoiceNumber);
    if (!inv) throw new NotFoundException(`no invoice ${invoiceNumber}`);
    return invoiceAsOf(inv, nowIso);
  }

  /** All stored invoices (raw, not advanced as-of) — for the dunning sweep. */
  async allInvoices(): Promise<Invoice[]> {
    return this.store.allInvoices();
  }

  /**
   * Compose a forward of an invoice to the account's accounts-payable inbox. Composition only —
   * returns the ready-to-send message; no transport fires here. (Invoices are also auto-addressed
   * to this AP inbox at issue, so this is the manual "send it to AP now" affordance.)
   */
  async forwardToAp(invoiceNumber: string, nowIso = new Date().toISOString()): Promise<ForwardToApComposition> {
    const inv = await this.invoice(invoiceNumber, nowIso);
    const dollars = (minor: number): string => `${inv.currency} ${(minor / 100).toFixed(2)}`;
    const poLine = inv.poNumber ? `\nPO Number: ${inv.poNumber}` : '';
    const financeLine = inv.financeChargeMinor > 0 ? `\nIncludes late finance charge: ${dollars(inv.financeChargeMinor)}` : '';
    const subject = `Invoice ${inv.invoiceNumber} — AX10M recovery fee for ${inv.period} — ${dollars(inv.totalDueMinor)} due ${inv.dueAt.slice(0, 10)}`;
    const body = [
      `Please process the attached AX10M invoice for payment.`,
      ``,
      `Bill to:      ${inv.billTo.legalEntityName}`,
      `Invoice:      ${inv.invoiceNumber}`,
      `Period:       ${inv.period}`,
      `Amount due:   ${dollars(inv.totalDueMinor)}${financeLine}`,
      `Due date:     ${inv.dueAt.slice(0, 10)} (net-14)${poLine}`,
      `Remit to:     ${inv.remitTo}`,
      ``,
      `This fee is 12% of the incremental recovery AX10M proved this period using your own`,
      `randomized holdout. The amount is backed by a signed Uplift Statement (hash`,
      `${inv.statementHash}) that can be verified against your processor's payout reports.`,
    ].join('\n');
    return { to: inv.billTo.apContactEmail, subject, body, composedOnly: true };
  }
}
