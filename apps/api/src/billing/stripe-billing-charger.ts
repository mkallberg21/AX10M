/**
 * StripeBillingCharger — collects AX10M's monthly fee from an auto-pay merchant by charging the
 * payment method they authorized at opt-in, on AX10M's OWN platform Stripe account (distinct from
 * the merchant-side Connect keys the recovery adapters use).
 *
 * SAFETY / HONESTY:
 *   - Only ever constructed + used when AX10M_LIVE_BILLING=true and a key is configured; the
 *     default remains NoopBillingCharger (records the invoice, moves no money). runBilling also
 *     gates the call on billable && fee>0.
 *   - Off-session charge: PaymentIntent(confirm=true, off_session=true) against the stored
 *     customer + payment method. If the card needs authentication, Stripe returns a card_error →
 *     reported as `failed` (the merchant is dunned / falls back to the invoice track), never a crash.
 *   - EXACTLY-ONCE: a deterministic Idempotency-Key from (merchant, period, statementHash) — a
 *     re-run of the monthly job never double-charges (Stripe dedupes server-side).
 *   - SKIPS honestly (never guesses): invoice-track merchants, or auto-pay merchants without a
 *     customer + payment method on file (SetupIntent not completed), are `skipped` with a reason.
 *   - No PAN ever touches this: it charges opaque `cus_`/`pm_` tokens.
 */

import { Logger } from '@nestjs/common';
import { stripe } from '@ax10m/poal';
import type { BillingAccount } from '@ax10m/billing';
import { NoopBillingCharger, type BillingCharger, type BillingChargeReceipt, type BillingChargeRequest } from './charger.js';

const logger = new Logger('StripeBillingCharger');

/** Resolves the billing account for a merchant (the payment method + customer live here). */
export type BillingAccountLookup = (merchantId: string) => Promise<BillingAccount | undefined>;

export interface StripeBillingChargerConfig {
  secretKey: string;
  apiVersion?: string;
  baseUrl?: string;
  fetch?: stripe.StripeFetchLike;
}

export class StripeBillingCharger implements BillingCharger {
  private readonly client: stripe.StripeClient;

  constructor(cfg: StripeBillingChargerConfig, private readonly accountFor: BillingAccountLookup) {
    this.client = new stripe.StripeClient({ secretKey: cfg.secretKey, apiVersion: cfg.apiVersion, baseUrl: cfg.baseUrl, fetch: cfg.fetch });
  }

  async charge(req: BillingChargeRequest): Promise<BillingChargeReceipt> {
    const account = await this.accountFor(req.merchantId);
    if (!account) return { status: 'skipped', provider: 'stripe', reason: `no billing account for merchant ${req.merchantId}` };
    if (account.payerTrack !== 'auto_pay') return { status: 'skipped', provider: 'stripe', reason: 'merchant is on the invoice track (not auto-pay) — invoice it instead' };
    if (!account.paymentMethodRef || !account.customerRef) {
      return { status: 'skipped', provider: 'stripe', reason: 'no Stripe customer + payment method on file (SetupIntent not completed)' };
    }

    // Deterministic idempotency: a re-run of the monthly job for the same period + statement
    // reuses the same PaymentIntent instead of charging twice.
    const idempotencyKey = `ax10m-bill-${req.merchantId}-${req.period}-${req.statementHash.slice(0, 24)}`;
    try {
      const { body, idempotentReplay } = await this.client.post(
        '/payment_intents',
        {
          amount: req.amountMinor,
          currency: req.currency.toLowerCase(),
          customer: account.customerRef,
          payment_method: account.paymentMethodRef,
          off_session: true,
          confirm: true,
          description: `AX10M recovery uplift fee — ${req.period}`,
          'metadata[merchantId]': req.merchantId,
          'metadata[period]': req.period,
          'metadata[statementHash]': req.statementHash,
        },
        idempotencyKey,
      );
      const status = String(body.status ?? '');
      const id = body.id ? String(body.id) : undefined;
      if (status === 'succeeded') {
        return { status: 'charged', provider: 'stripe', reference: id, reason: idempotentReplay ? 'idempotent replay' : undefined };
      }
      // requires_action / requires_payment_method / processing → not collected this run.
      return { status: 'failed', provider: 'stripe', reference: id, reason: `payment intent not succeeded (status=${status || 'unknown'})` };
    } catch (err) {
      if (err instanceof stripe.StripeError) {
        const reason = err.isCardError()
          ? `card declined: ${err.body.error?.decline_code ?? err.body.error?.code ?? err.message}`
          : `stripe ${err.body.error?.type ?? 'error'}: ${err.message}`;
        return { status: 'failed', provider: 'stripe', reason };
      }
      return { status: 'failed', provider: 'stripe', reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Build the billing charger from env. Returns a real StripeBillingCharger only when
 * AX10M_BILLING_STRIPE_SECRET_KEY is set (AX10M's own platform account key); otherwise the safe
 * NoopBillingCharger. The caller supplies the account lookup (from the billing repo).
 */
export function buildBillingCharger(env: NodeJS.ProcessEnv, accountFor: BillingAccountLookup): BillingCharger {
  const secretKey = env.AX10M_BILLING_STRIPE_SECRET_KEY;
  if (!secretKey) return new NoopBillingCharger();
  logger.log('Stripe billing charger wired (AX10M platform account) — collects the fee off-session on auto-pay when AX10M_LIVE_BILLING=true.');
  return new StripeBillingCharger({ secretKey, apiVersion: env.STRIPE_API_VERSION || undefined }, accountFor);
}
