/**
 * The BillingAccount — the merchant's opt-in identity for AX10M's fee. Everything captured at
 * opt-in that we need to bill the company: the legal entity, where to send the invoice, who in
 * accounts payable receives it, PO policy, the payer track (auto-pay vs invoice), and a snapshot
 * of the agreed fee schedule.
 *
 * SAFETY: we NEVER store a card number here. `paymentMethodRef` is an opaque processor token
 * (e.g. a Stripe SetupIntent `pm_...`) obtained on the merchant's side (SAQ-A) — validateOptIn
 * scans it (and the other free-text fields) so a raw PAN can never land in this model.
 */

import type { CurrencyCode } from '@ax10m/canonical';

/** How the merchant pays: auto-charged from a stored method, or invoiced on net terms. */
export type PayerTrack = 'auto_pay' | 'invoice';

export type BillingAccountStatus = 'pending' | 'active' | 'suspended' | 'cancelled';

export interface PostalAddress {
  line1: string;
  line2?: string;
  city: string;
  region: string; // state / province
  postalCode: string;
  country: string; // ISO-3166 alpha-2
}

/** The human who accepted the terms on behalf of the company (bound into the acceptance record). */
export interface AuthorizedSigner {
  name: string;
  title: string;
  email: string;
}

/**
 * The commercial terms a merchant agrees to. The fee is a FIXED 12% of proven uplift; overdue
 * invoices accrue a monthly finance charge after the payment-term window. This mechanic — a fixed
 * price plus a standard late-interest charge — was chosen over a punitive rate-jump: it's
 * enforceable (a genuine finance charge, not a penalty) and it's what AP departments expect.
 */
export interface FeeSchedule {
  /** Fraction of proven lower-bound uplift billed (0.12 = 12%). */
  feeRate: number;
  currency: CurrencyCode;
  /** Net payment term in days from invoice issue (14 = net-14). */
  paymentTermsDays: number;
  /** Monthly finance charge on the overdue balance, applied after paymentTermsDays (0.015 = 1.5%/mo). */
  lateFinanceChargeMonthlyRate: number;
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  feeRate: 0.12,
  currency: 'USD',
  paymentTermsDays: 14,
  lateFinanceChargeMonthlyRate: 0.015,
};

export interface BillingAccount {
  accountId: string;
  /** AX10M-internal merchant this account bills for (ties to the ledger's merchantId). */
  merchantId: string;
  legalEntityName: string;
  billingAddress: PostalAddress;
  /** EIN / VAT — a tax identifier, never a card number. */
  taxId?: string;
  /** Accounts-payable inbox — auto-CC'd on every invoice so no human has to forward it. */
  apContactEmail: string;
  poRequired: boolean;
  poNumber?: string;
  payerTrack: PayerTrack;
  /** Opaque processor token for auto-pay (Stripe `pm_...`). NEVER a PAN. Absent on the invoice track. */
  paymentMethodRef?: string;
  /**
   * The processor customer the payment method is attached to (Stripe `cus_...`, on AX10M's own
   * platform account). Required alongside paymentMethodRef to charge off-session; captured by the
   * SetupIntent enrollment flow. NEVER a PAN.
   */
  customerRef?: string;
  feeSchedule: FeeSchedule;
  status: BillingAccountStatus;
  createdAt: string;
}

/** The raw opt-in submission from the portal, before it becomes a BillingAccount + acceptance. */
export interface OptInInput {
  merchantId: string;
  legalEntityName: string;
  billingAddress: PostalAddress;
  taxId?: string;
  apContactEmail: string;
  poRequired: boolean;
  poNumber?: string;
  payerTrack: PayerTrack;
  paymentMethodRef?: string;
  customerRef?: string;
  signer: AuthorizedSigner;
  /** Did the signer explicitly authorize recurring auto-charges? Required on the auto_pay track. */
  autoPayAuthorized?: boolean;
  feeSchedule?: FeeSchedule;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A run of 13–19 digits (optionally space/dash separated) — a card-number shape. Defense-in-depth:
// no free-text field on a billing account should ever carry one.
const PAN_RE = /(?:\d[ -]?){13,19}/;

function isBlank(s: string | undefined): boolean {
  return !s || s.trim().length === 0;
}

/** True if a string looks like it contains a card PAN (used to reject leaks into stored fields). */
export function looksLikePan(s: string | undefined): boolean {
  if (!s) return false;
  const m = s.match(PAN_RE);
  if (!m) return false;
  const digits = m[0].replace(/[ -]/g, '');
  return digits.length >= 13 && digits.length <= 19;
}

/**
 * Validate an opt-in submission. Returns a list of human-readable errors ([] = valid). Enforces
 * the fields we need to actually bill the company, the payer-track requirements, and the no-PAN
 * rule. Pure — no I/O.
 */
export function validateOptIn(input: OptInInput): string[] {
  const errors: string[] = [];

  if (isBlank(input.merchantId)) errors.push('merchantId is required');
  if (isBlank(input.legalEntityName)) errors.push('legalEntityName is required');

  const a = input.billingAddress;
  if (!a || isBlank(a.line1)) errors.push('billingAddress.line1 is required');
  if (!a || isBlank(a.city)) errors.push('billingAddress.city is required');
  if (!a || isBlank(a.region)) errors.push('billingAddress.region is required');
  if (!a || isBlank(a.postalCode)) errors.push('billingAddress.postalCode is required');
  if (!a || isBlank(a.country)) errors.push('billingAddress.country is required');
  else if (a.country.trim().length !== 2) errors.push('billingAddress.country must be a 2-letter ISO code');

  if (isBlank(input.apContactEmail)) errors.push('apContactEmail is required');
  else if (!EMAIL_RE.test(input.apContactEmail)) errors.push('apContactEmail is not a valid email');

  const s = input.signer;
  if (!s || isBlank(s.name)) errors.push('signer.name is required');
  if (!s || isBlank(s.title)) errors.push('signer.title is required');
  if (!s || isBlank(s.email)) errors.push('signer.email is required');
  else if (!EMAIL_RE.test(s.email)) errors.push('signer.email is not a valid email');

  if (input.poRequired && isBlank(input.poNumber)) errors.push('poNumber is required when poRequired is true');

  if (input.payerTrack === 'auto_pay') {
    if (isBlank(input.paymentMethodRef)) errors.push('paymentMethodRef is required on the auto_pay track');
    if (input.autoPayAuthorized !== true) errors.push('autoPayAuthorized must be true to enroll in auto-pay');
  } else if (input.payerTrack !== 'invoice') {
    errors.push(`unknown payerTrack: ${String(input.payerTrack)}`);
  }

  // No card number may ever land in a stored field.
  if (looksLikePan(input.paymentMethodRef)) errors.push('paymentMethodRef looks like a card number — pass an opaque processor token, never a PAN');
  if (looksLikePan(input.customerRef)) errors.push('customerRef looks like a card number — pass an opaque processor customer id, never a PAN');
  if (looksLikePan(input.taxId)) errors.push('taxId looks like a card number');
  if (looksLikePan(input.poNumber)) errors.push('poNumber looks like a card number');

  return errors;
}

/**
 * Build a BillingAccount from a validated opt-in. Caller supplies the accountId and createdAt
 * (so this stays pure/deterministic). Throws if the input is invalid — validate first.
 */
export function buildBillingAccount(input: OptInInput, accountId: string, createdAt: string): BillingAccount {
  const errors = validateOptIn(input);
  if (errors.length > 0) throw new Error(`invalid opt-in: ${errors.join('; ')}`);
  return {
    accountId,
    merchantId: input.merchantId,
    legalEntityName: input.legalEntityName,
    billingAddress: input.billingAddress,
    taxId: input.taxId,
    apContactEmail: input.apContactEmail,
    poRequired: input.poRequired,
    poNumber: input.poNumber,
    payerTrack: input.payerTrack,
    paymentMethodRef: input.payerTrack === 'auto_pay' ? input.paymentMethodRef : undefined,
    customerRef: input.payerTrack === 'auto_pay' ? input.customerRef : undefined,
    feeSchedule: input.feeSchedule ?? DEFAULT_FEE_SCHEDULE,
    status: 'active',
    createdAt,
  };
}
