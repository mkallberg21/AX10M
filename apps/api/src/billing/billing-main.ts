/**
 * Monthly billing entrypoint. Computes + records each merchant's Uplift Statement for the previous
 * month, and collects the 12% fee only when AX10M_LIVE_BILLING=true. Schedule monthly (cron /
 * Temporal schedule) in production.
 *
 *   corepack pnpm --filter @ax10m/api run bill
 *
 * Requires DATABASE_URL (reads the shared persisted ledger). Prints the per-merchant summary.
 */

import { runBillingJob } from './billing-job.js';

runBillingJob()
  .then((summary) => {
    if (!summary) {
      // eslint-disable-next-line no-console
      console.error('[bill] no DATABASE_URL — nothing to bill.');
      process.exitCode = 1;
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[bill] period=${summary.period} live=${summary.live} merchants=${summary.merchants.length} totalFee=${summary.totalFeeMinor} collected=${summary.totalChargedMinor}`);
    for (const m of summary.merchants) {
      // eslint-disable-next-line no-console
      console.log(`  ${m.merchantId}: fee=${m.feeMinor} ${m.currency} billable=${m.billable}${m.billable ? '' : ` (${m.gateReasons.join('; ')})`}${m.charge ? ` charge=${m.charge.status}` : ''}`);
    }
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[bill] fatal:', err);
    process.exitCode = 1;
  });
