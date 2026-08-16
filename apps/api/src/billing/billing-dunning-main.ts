/**
 * Daily invoice-dunning entrypoint. Sweeps all issued invoices and delivers each one's current due
 * reminder. Safe-by-default: dry-run unless AX10M_LIVE_BILLING=true and a comms provider is wired.
 *
 *   corepack pnpm --filter @ax10m/api run dun
 *
 * Requires DATABASE_URL (reads the shared persisted invoices).
 */

import { runInvoiceDunningJob } from './billing-dunning-job.js';

runInvoiceDunningJob()
  .then((summary) => {
    if (!summary) {
      // eslint-disable-next-line no-console
      console.error('[dun] no DATABASE_URL — no invoices to dun.');
      process.exitCode = 1;
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[dun] live=${summary.live} considered=${summary.considered} sent=${summary.sent} dry_run=${summary.dryRun} duplicate=${summary.duplicate} skipped=${summary.skipped} failed=${summary.failed}`);
    for (const r of summary.results.filter((x) => x.status !== 'skipped' && x.status !== 'duplicate')) {
      // eslint-disable-next-line no-console
      console.log(`  ${r.invoiceNumber} [${r.stage}] → ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
    }
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[dun] fatal:', err);
    process.exitCode = 1;
  });
