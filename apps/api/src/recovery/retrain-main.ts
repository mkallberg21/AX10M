/**
 * Retrain entrypoint. Runs one champion/challenger pass against the persisted ledger and
 * persists a promoted challenger. Schedule it (cron / Temporal schedule) in production.
 *
 *   corepack pnpm --filter @ax10m/api run retrain
 *
 * Requires DATABASE_URL (it reads the shared persisted ledger). Prints the decision.
 */

import { runRetrainJob } from './retrain-job.js';

runRetrainJob()
  .then((res) => {
    const r = res.report;
    // eslint-disable-next-line no-console
    console.log(
      `[retrain] champion=${res.championSource} accepted=${r.accepted}` +
        (r.accepted
          ? ` samples=${r.nSamples} (+${r.nPositives}/-${r.nNegatives}) championAUC=${r.champion?.auc?.toFixed(4)} challengerAUC=${r.challenger?.auc?.toFixed(4)} promoted=${r.promoted}` +
            (res.promotedVersion !== null ? ` → model v${res.promotedVersion} is now active` : '')
          : ` reason=${r.reason} (no model shipped)`),
    );
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[retrain] fatal:', err);
    process.exitCode = 1;
  });
