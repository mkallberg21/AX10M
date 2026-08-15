/**
 * Build a minimal `Customer` from a normalized `Invoice`, for backup-method discovery
 * (`alternate_rail`) during dead-credential recovery. Adapters attach this to the
 * `invoice.failed` payload so the recovery engine can list a customer's stored methods
 * and charge a working one when the primary credential is dead.
 *
 * The processor's customer ref is recovered by stripping the canonical `ax10m_cus_`
 * prefix that every adapter adds to `invoice.customerId` — `listPaymentMethods` queries
 * the processor by `customer.processorRef`. Adapters with richer webhook data (email,
 * phone for the SMS dunning channel, a distinct customer ref, issuer region, consent) can
 * pass overrides.
 */

import type { Customer, Invoice } from '@ax10m/canonical';

const CUSTOMER_PREFIX = 'ax10m_cus_';

/**
 * Build customer overrides from webhook contact fields, dropping empties so a blank string
 * never shadows an absent value. Feeds the dunning channels (email / SMS destinations).
 * Contact info only — never a PAN.
 */
export function contactOverrides(email: string | undefined, phone: string | undefined): { email?: string; phone?: string } {
  const o: { email?: string; phone?: string } = {};
  if (email) o.email = email;
  if (phone) o.phone = phone;
  return o;
}

export function customerFromInvoice(invoice: Invoice, overrides: Partial<Customer> = {}): Customer {
  const processorRef = invoice.customerId.startsWith(CUSTOMER_PREFIX)
    ? invoice.customerId.slice(CUSTOMER_PREFIX.length)
    : invoice.customerId;
  return {
    id: invoice.customerId,
    merchantId: invoice.merchantId,
    processorRef,
    issuerRegion: 'unknown',
    createdAt: invoice.createdAt,
    // A payment-failed webhook carries no comms consent; default to none (charging a
    // backup method does not require comms consent — the guardrail only gates comms).
    consent: { email: false, sms: false, whatsapp: false, push: false, globallyOptedOut: false },
    ...overrides,
  };
}
