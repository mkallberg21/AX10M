import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Ip, Param, Post } from '@nestjs/common';
import type { Invoice, OptInInput } from '@ax10m/billing';
import { BillingPortalService, type AccountView, type ForwardToApComposition, type OptInResult } from './billing-portal.service.js';
import { InvoiceDeliveryService, type InvoiceDeliveryResult, type InvoiceDunningSummary } from './invoice-delivery.service.js';
import { StripeEnrollmentService, type SetupIntentRequest, type SetupIntentResult } from './stripe-enrollment.service.js';

/**
 * Billing portal API — the merchant-facing opt-in + invoice surface for AX10M's 12% fee.
 *
 *   GET  /billing/terms                       current terms (version, hash, fee schedule, body) to show pre-accept
 *   POST /billing/setup-intent                start auto-pay enrollment: create a Stripe customer + SetupIntent (SAQ-A)
 *   POST /billing/opt-in                      accept terms + enroll (auto-pay or invoice); signs a clickwrap record
 *   GET  /billing/account/:merchantId         the merchant's billing account (payment token never echoed)
 *   GET  /billing/invoices/:merchantId        issued invoices (finance charge computed as-of now)
 *   GET  /billing/invoice/:invoiceNumber      one invoice (finance charge as-of now)
 *   POST /billing/invoice/:invoiceNumber/forward-ap   compose a forward to accounts payable (composition only)
 *   POST /billing/invoice/:invoiceNumber/send         deliver the invoice's current due reminder to AP (dry-run unless live)
 *   POST /billing/dunning/run                          sweep all invoices, delivering each one's due reminder
 *
 * Opting in signs an Ed25519 acceptance record and persists the account; no money moves. Actual
 * collection is the flag-gated monthly billing job (AX10M_LIVE_BILLING). Invoice sends are dry-run
 * unless AX10M_LIVE_BILLING=true and a comms provider is wired.
 */
@Controller('billing')
export class BillingController {
  constructor(
    private readonly portal: BillingPortalService,
    private readonly delivery: InvoiceDeliveryService,
    private readonly enrollment: StripeEnrollmentService,
  ) {}

  @Get('terms')
  terms(): ReturnType<BillingPortalService['terms']> {
    return this.portal.terms();
  }

  /**
   * Start auto-pay enrollment: create a Stripe customer + SetupIntent so the browser can collect a
   * card via Stripe Elements (the PAN never touches AX10M). Returns the customer id + client
   * secret; after the browser confirms, submit customerRef + paymentMethodRef to /billing/opt-in.
   */
  @Post('setup-intent')
  @HttpCode(200)
  async setupIntent(@Body() body: SetupIntentRequest): Promise<SetupIntentResult> {
    if (!body?.merchantId?.trim() || !body?.email?.trim()) throw new BadRequestException('merchantId and email are required');
    return this.enrollment.createSetupIntent({ merchantId: body.merchantId.trim(), email: body.email.trim(), legalEntityName: body.legalEntityName?.trim() });
  }

  @Post('opt-in')
  @HttpCode(200)
  async optIn(@Body() body: OptInInput, @Ip() ip: string, @Headers('user-agent') userAgent?: string): Promise<OptInResult> {
    return this.portal.optIn(body, { ip, userAgent });
  }

  @Get('account/:merchantId')
  async account(@Param('merchantId') merchantId: string): Promise<AccountView> {
    return this.portal.accountFor(merchantId);
  }

  @Get('invoices/:merchantId')
  async invoices(@Param('merchantId') merchantId: string): Promise<Invoice[]> {
    return this.portal.invoicesFor(merchantId);
  }

  @Get('invoice/:invoiceNumber')
  async invoice(@Param('invoiceNumber') invoiceNumber: string): Promise<Invoice> {
    return this.portal.invoice(invoiceNumber);
  }

  @Post('invoice/:invoiceNumber/forward-ap')
  @HttpCode(200)
  async forwardToAp(@Param('invoiceNumber') invoiceNumber: string): Promise<ForwardToApComposition> {
    return this.portal.forwardToAp(invoiceNumber);
  }

  /** Deliver this invoice's current due reminder to the AP inbox now (dry-run unless live). */
  @Post('invoice/:invoiceNumber/send')
  @HttpCode(200)
  async send(@Param('invoiceNumber') invoiceNumber: string): Promise<InvoiceDeliveryResult> {
    const invoice = await this.portal.invoice(invoiceNumber);
    return this.delivery.deliverDue(invoice, new Date().toISOString());
  }

  /** Sweep every invoice, delivering each one's current due reminder (the dunning run). */
  @Post('dunning/run')
  @HttpCode(200)
  async runDunning(): Promise<InvoiceDunningSummary> {
    const invoices = await this.portal.allInvoices();
    return this.delivery.runSweep(invoices, new Date().toISOString());
  }
}
