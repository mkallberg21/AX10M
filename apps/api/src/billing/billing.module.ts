import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller.js';
import { BillingPortalService } from './billing-portal.service.js';
import { buildBillingAccountStore } from './billing-account-store.js';
import { resolveBillingSigner, resolveRemitTo } from './billing-signer.js';
import { InvoiceDeliveryService, buildInvoiceDeliveryService } from './invoice-delivery.service.js';
import { StripeEnrollmentService, buildStripeEnrollmentService } from './stripe-enrollment.service.js';

/**
 * Billing portal module. Wires the BillingPortalService with the persisted account store (shared
 * DB when configured, in-memory otherwise) and the org billing signer. No processor credentials
 * and no charging live here — this is opt-in + invoice retrieval; collection is the billing job.
 */
@Module({
  providers: [
    {
      provide: BillingPortalService,
      useFactory: async (): Promise<BillingPortalService> => {
        const store = await buildBillingAccountStore(process.env);
        return new BillingPortalService(store, resolveBillingSigner(process.env), resolveRemitTo(process.env));
      },
    },
    {
      provide: InvoiceDeliveryService,
      useFactory: (): Promise<InvoiceDeliveryService> => buildInvoiceDeliveryService(process.env),
    },
    {
      provide: StripeEnrollmentService,
      useFactory: (): StripeEnrollmentService => buildStripeEnrollmentService(process.env),
    },
  ],
  controllers: [BillingController],
  exports: [BillingPortalService, InvoiceDeliveryService, StripeEnrollmentService],
})
export class BillingModule {}
