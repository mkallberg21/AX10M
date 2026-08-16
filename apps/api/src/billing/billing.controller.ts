import { Body, Controller, Get, Headers, HttpCode, Ip, Param, Post, Query } from '@nestjs/common';
import type { Invoice, OptInInput } from '@ax10m/billing';
import { BillingPortalService, type AccountView, type ForwardToApComposition, type OptInResult } from './billing-portal.service.js';

/**
 * Billing portal API — the merchant-facing opt-in + invoice surface for AX10M's 12% fee.
 *
 *   GET  /billing/terms                       current terms (version, hash, fee schedule, body) to show pre-accept
 *   POST /billing/opt-in                      accept terms + enroll (auto-pay or invoice); signs a clickwrap record
 *   GET  /billing/account/:merchantId         the merchant's billing account (payment token never echoed)
 *   GET  /billing/invoices/:merchantId        issued invoices (finance charge computed as-of now)
 *   GET  /billing/invoice/:invoiceNumber      one invoice (finance charge as-of now)
 *   POST /billing/invoice/:invoiceNumber/forward-ap   compose a forward to accounts payable (composition only)
 *
 * Opting in signs an Ed25519 acceptance record and persists the account; no money moves. Actual
 * collection is the flag-gated monthly billing job (AX10M_LIVE_BILLING).
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly portal: BillingPortalService) {}

  @Get('terms')
  terms(): ReturnType<BillingPortalService['terms']> {
    return this.portal.terms();
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
}
