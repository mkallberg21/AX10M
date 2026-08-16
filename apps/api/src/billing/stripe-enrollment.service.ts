/**
 * StripeEnrollmentService — the auto-pay enrollment handshake. Creates a Stripe Customer on
 * AX10M's OWN platform account and a SetupIntent so the merchant's browser (Stripe Elements) can
 * collect + save a card WITHOUT the PAN ever touching AX10M (SAQ-A). The confirmed SetupIntent
 * yields a `pm_` attached to the `cus_`, which the merchant then submits to POST /billing/opt-in
 * as customerRef + paymentMethodRef — after which the monthly charger can bill off-session.
 *
 * Constructed with a StripeClient only when AX10M_BILLING_STRIPE_SECRET_KEY is set; otherwise it's
 * disabled and every call throws a clear "not configured" error (auto-pay simply isn't available,
 * merchants use the invoice track).
 */

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { stripe } from '@ax10m/poal';

export interface SetupIntentResult {
  /** Stripe customer id (cus_...) — submit as customerRef to /billing/opt-in. */
  customerId: string;
  /** SetupIntent client secret — the browser confirms it with Stripe Elements. */
  clientSecret: string;
  setupIntentId: string;
}

export interface SetupIntentRequest {
  merchantId: string;
  email: string;
  legalEntityName?: string;
}

export class StripeEnrollmentService {
  constructor(private readonly client?: stripe.StripeClient) {}

  get enabled(): boolean {
    return this.client !== undefined;
  }

  /**
   * Create (a customer and) a SetupIntent for off-session future charges. Returns the customer id
   * + client secret for the browser to confirm. Throws ServiceUnavailable when auto-pay isn't
   * configured, or the underlying Stripe error message on an API failure.
   */
  async createSetupIntent(req: SetupIntentRequest): Promise<SetupIntentResult> {
    if (!this.client) throw new ServiceUnavailableException('auto-pay enrollment is not configured (set AX10M_BILLING_STRIPE_SECRET_KEY); use the invoice track instead');

    const customer = await this.client.post('/customers', {
      email: req.email,
      name: req.legalEntityName,
      'metadata[merchantId]': req.merchantId,
      'metadata[source]': 'ax10m-billing-optin',
    });
    const customerId = String(customer.body.id ?? '');
    if (!customerId) throw new ServiceUnavailableException('Stripe did not return a customer id');

    const setupIntent = await this.client.post('/setup_intents', {
      customer: customerId,
      usage: 'off_session',
      'payment_method_types[]': 'card',
      'metadata[merchantId]': req.merchantId,
    });
    Logger.log(`SetupIntent created for merchant ${req.merchantId} (customer ${customerId}).`, 'StripeEnrollment');
    return { customerId, clientSecret: String(setupIntent.body.client_secret ?? ''), setupIntentId: String(setupIntent.body.id ?? '') };
  }
}

/** Build the enrollment service; enabled only when AX10M's platform Stripe key is configured. */
export function buildStripeEnrollmentService(env: NodeJS.ProcessEnv = process.env): StripeEnrollmentService {
  const secretKey = env.AX10M_BILLING_STRIPE_SECRET_KEY;
  if (!secretKey) return new StripeEnrollmentService(undefined);
  return new StripeEnrollmentService(new stripe.StripeClient({ secretKey, apiVersion: env.STRIPE_API_VERSION || undefined }));
}
