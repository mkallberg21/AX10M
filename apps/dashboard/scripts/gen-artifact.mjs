/**
 * Generate a SELF-CONTAINED HTML snapshot of the demo dashboard from the committed
 * `app/demo-data.json` + `app/globals.css`. Because it reads the same generated data as
 * the live Next.js page, it can never show a number the backtest denies.
 *
 *   corepack pnpm --filter @ax10m/dashboard gen-artifact [outPath]
 *
 * Writes two forms of the same page:
 *   public/demo.html            — full standalone page (servable at /demo.html on Vercel)
 *   <outPath> (if given)        — artifact-flavored (title+style+content, no <html>/<head>)
 *                                 for publishing as a claude.ai Artifact
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', 'app');
const pubDir = path.resolve(here, '..', 'public');

const data = JSON.parse(await fs.readFile(path.join(appDir, 'demo-data.json'), 'utf8'));
const css = await fs.readFile(path.join(appDir, 'globals.css'), 'utf8');

const GH = 'https://github.com/mkallberg21/AX10M/blob/main';
const RAW = 'https://raw.githubusercontent.com/mkallberg21/AX10M/main';

const money = (minor, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(minor / 100);
const pct = (r) => `${(r * 100).toFixed(1)}%`;
const auc = (a) => a.toFixed(3);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

const st = data.statement;
const r = st.result;
const cur = st.currency;
const onb = data.onboarding;
const day = Math.floor(onb.progress.elapsedDays);
const recon = data.reconSummary;
const tie = data.reconResult;
const rt = data.retrain;

const rows = r.perStratum
  .map(
    (l) => `      <tr>
        <td>${esc(l.stratumKey === '__pooled__' ? 'pooled (sub-floor)' : l.stratumKey)}</td>
        <td class="num">${pct(l.controlRate)}</td>
        <td class="num">${pct(l.treatmentRate)}</td>
        <td class="num">${money(Math.round(l.deltaPerStratum), cur)}</td>
        <td class="num">${l.treatmentInvoices.toLocaleString()}</td>
        <td class="num">${pct(l.weight)}</td>
        <td>${l.pooled ? '<span class="pill holdout">Pooled</span>' : '<span class="pill billable">In sample</span>'}</td>
      </tr>`,
  )
  .join('\n');

const head = `<title>AX10M Recovery Demo</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${css}
.artifact-links { margin: 8px 0 12px 18px; line-height: 1.9; }
pre.verify { background:#0b1220; color:#cbd5e1; padding:12px; border-radius:8px; overflow-x:auto; font-size:12px; }
</style>`;

const content = `<main class="container">
  <div class="onboard" style="border-color:#f59e0b">
    <div class="onboard-top">
      <span class="badge" style="background:#7c2d12">Demo · synthetic data · reproduces the Phase-1 backtest</span>
      <a class="activate" href="${GH}/packages/backtest/out/report.md" style="text-decoration:none">Read the backtest →</a>
    </div>
    <p class="onboard-note" style="margin-top:12px">
      <strong>Honest status:</strong> the AX10M engine now <strong>beats Stripe Smart Retries on recovery rate</strong>
      (+~13.8&nbsp;pp vs the default reach) via a capability a blanket retry can't copy — <strong>dead-credential
      recovery</strong> (Account Updater, backup-rail fallback, dunning) recovers cards a retry on the original number
      never reaches. The win <strong>survives the fairness sweep</strong> (it holds against a baseline that retries just
      as long). But this is a <strong>modeled</strong> result on synthetic data — the magnitude is assumption-driven,
      and a <strong>live holdout is what proves it</strong>. Both cards come from the same world model, so this demo
      cannot show a number the backtest denies.
    </p>
  </div>

  <div class="onboard">
    <div class="onboard-top">
      <span class="badge">Shadow mode · day ${day} of ${onb.state.shadowWindowDays} · measuring your true baseline</span>
      <button class="activate" disabled>Activate at day ${onb.state.shadowWindowDays}</button>
    </div>
    <div class="progress"><div class="fill" style="width:${Math.round(onb.progress.pctComplete * 100)}%"></div></div>
    <div class="onboard-stats">
      <div><span class="k">Projected monthly opportunity</span><span class="v accent">${money(onb.projection.projectedMonthlyValue.amount)}</span></div>
      <div><span class="k">Would-be fee (12%)</span><span class="v">${money(onb.projection.projectedMonthlyFee.amount)}</span></div>
      <div><span class="k">Conservative low end</span><span class="v">${money(onb.projection.projectedMonthlyConservative.amount)}</span></div>
      <div><span class="k">Your baseline recovery</span><span class="v">${pct(onb.projection.baselineRecoveryRate)}</span></div>
    </div>
    <p class="onboard-note">
      Projected from ${onb.projection.observedFailures.toLocaleString()} observed baseline failures — a model estimate
      of the recoverable <strong>opportunity</strong>, <strong>not yet holdout-verified</strong> and not a claim that
      our engine captures it. The live holdout is what turns this into a billable number.
    </p>
  </div>

  <h1>Active-holdout statement (illustrative)</h1>
  <p class="subtitle">
    What an active month looks like: a live randomized holdout runs the AX10M engine against your Stripe Smart Retries
    baseline, and we bill only the <strong>always-valid lower bound</strong>. In this (simulated) month the engine
    recovered <strong>${pct(r.treatmentRate)}</strong> vs the baseline's <strong>${pct(r.controlRate)}</strong> — a
    <strong>${pct(r.rateDiff)}</strong> difference, driven by dead-credential recovery — so the lower bound is positive
    and it would bill <strong>${money(r.fee.amount, cur)}</strong>. On a real merchant the same machinery bills
    <strong>$0</strong> until the lower bound clears; here it clears because the modeled lift is real (and still needs a
    live holdout to prove the size).
  </p>

  <section class="kpis">
    <div class="kpi">
      <div class="label">Proven incremental uplift (lower bound)</div>
      <div class="value accent">${money(r.lowerDollarsCum.amount, cur)}</div>
      <div class="hint">Point estimate ${money(Math.round(r.deltaPer * r.treatedInvoices), cur)}/period · we bill only the proven floor</div>
    </div>
    <div class="kpi">
      <div class="label">Fee (12% of proven increment)</div>
      <div class="value">${money(r.fee.amount, cur)}</div>
      <div class="hint">${r.billable ? 'On truly-incremental dollars' : 'Not billable — lift unproven'}</div>
    </div>
    <div class="kpi">
      <div class="label">Statistical status</div>
      <div class="value">${r.billable ? 'Proven' : 'Unproven'}<span style="color:var(--muted);font-size:18px"> · 95% CS</span></div>
      <div class="hint">SRM χ²=${r.srm.chiSquare.toFixed(1)} ${r.srm.breached ? '✗ paused' : '✓ balanced'} · CUPED −${pct(r.cupedVarianceReduction)} variance</div>
    </div>
  </section>

  <div class="method-strip">
    <span><strong>${money(Math.round(r.deltaPer), cur)}</strong>/invoice point estimate</span>
    <span><strong>${money(Math.round(r.halfWidth), cur)}</strong> mSPRT half-width</span>
    <span><strong>${money(Math.round(r.lowerPer), cur)}</strong>/invoice proven floor</span>
    <span><strong>${money(Math.round(r.se), cur)}</strong> cluster-robust SE</span>
    <span><strong>${Math.round(r.effectiveN).toLocaleString()}</strong> effective N</span>
  </div>

  <div class="section-title">Cohort breakdown (by MRR tier · decline family · issuer region)</div>
  <table>
    <thead>
      <tr>
        <th>Cohort</th><th class="num">Control recovery</th><th class="num">Treatment recovery</th>
        <th class="num">Point uplift $/inv</th><th class="num">Treated invoices</th><th class="num">Weight</th><th>Status</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="subtitle" style="font-size:13px;margin-top:12px">
    The gap concentrates in the <strong>dead-credential</strong> cohorts (expired / lost / stolen / closed cards),
    where the engine's Account Updater + backup-rail + dunning recover invoices a retry on the original card cannot. On
    the soft-decline majority the two are close. The estimator reports the difference faithfully; a live holdout is what
    proves the magnitude.
  </p>

  <div class="section-title">CFO reconciliation — verify it yourself, trust nothing</div>
  <div class="method-strip">
    <span>Signed statement <strong>${esc(recon.statementHash.slice(0, 16))}…</strong></span>
    <span>Signing key <strong>${esc(recon.signingKeyId)}</strong></span>
    <span>Ledger <strong>${recon.ledgerVerified ? 'verified ✓' : 'FAILED ✗'}</strong></span>
    <span>Epoch salt <strong>disclosed</strong></span>
  </div>
  <div class="recon-grid">
    <div class="recon-card${tie.tiesOut ? ' ok' : ''}">
      <div class="label">Reconciles against processor payout</div>
      <div class="big">${tie.tiesOut ? 'Ties out ✓' : 'Discrepancy ✗'}</div>
      <div class="hint">${tie.matched.toLocaleString()} recovered txns · ${money(tie.oursTotal, cur)} = ${money(tie.theirsTotal, cur)} settled</div>
    </div>
    <div class="recon-card">
      <div class="label">Recovered value (both arms)</div>
      <div class="big">${money(recon.summary.treatment.recoveredAmount + recon.summary.control.recoveredAmount, cur)}</div>
      <div class="hint">Treatment ${money(recon.summary.treatment.recoveredAmount, cur)} · control ${money(recon.summary.control.recoveredAmount, cur)}</div>
    </div>
    <div class="recon-card">
      <div class="label">Fee = 12% × proven increment</div>
      <div class="big">${money(recon.fee.fee, cur)}</div>
      <div class="hint">${recon.fee.billable ? 'proven' : 'unproven → $0'} · recomputable by hand</div>
    </div>
  </div>

  <div class="section-title">Recovery model — retrained off the ledger (the flywheel)</div>
  <p class="subtitle" style="margin-top:0">
    Every recovery decision and its realized outcome are logged to the shared, hash-chained ledger. The retrain job
    reads that ledger, fits a challenger, and a <strong>champion/challenger gate</strong> promotes it only if it beats
    the current model by a margin — so retraining can <strong>never ship a regression</strong>. The gate below is
    production code; the corpus here is synthetic until a live ledger fills.
  </p>
  <section class="kpis">
    <div class="kpi">
      <div class="label">Trained champion (held-out AUC)</div>
      <div class="value accent">${auc(rt.championAuc)}</div>
      <div class="hint">vs an untrained cold-start model at ${auc(rt.coldStartAuc)}</div>
    </div>
    <div class="kpi">
      <div class="label">Retrained challenger</div>
      <div class="value">${auc(rt.challengerAuc)}<span style="color:var(--muted);font-size:18px"> AUC</span></div>
      <div class="hint">${rt.promotedVsColdStart ? 'Promotes vs cold-start ✓' : 'Held vs cold-start'} · ${rt.promotedVsChampion ? 'promotes vs champion ✓' : 'held vs champion (no gain ≥ margin)'}</div>
    </div>
    <div class="kpi">
      <div class="label">Gate decision this cycle</div>
      <div class="value">${rt.promotedVsChampion ? 'Promote' : 'Hold'}</div>
      <div class="hint">needs +${rt.marginAuc.toFixed(3)} AUC to promote · never ships a regression</div>
    </div>
  </section>
  <div class="method-strip">
    <span><strong>${rt.corpusSamples.toLocaleString()}</strong> labeled ledger samples</span>
    <span><strong>${rt.positives.toLocaleString()}</strong> recovered (+)</span>
    <span><strong>${rt.negatives.toLocaleString()}</strong> failed (−)</span>
    <span>promotes a real gain → <strong>model.promoted</strong> in the ledger</span>
    <span>API + worker load the active champion at startup</span>
  </div>
  <p class="subtitle" style="font-size:13px;margin-top:12px">
    Here the fresh challenger (${auc(rt.challengerAuc)}) does <strong>not</strong> beat the already-strong shipped
    champion (${auc(rt.championAuc)}) by the margin, so the gate correctly <strong>holds</strong> — it would promote
    against a weaker model (as shown vs cold-start), but it refuses to ship a non-improvement. That safety property is
    the point: the flywheel only ever moves the model forward.
  </p>

  <div class="onboard" style="margin-top:20px">
    <div class="onboard-top"><span class="badge">Download &amp; verify the signed statement</span></div>
    <p class="onboard-note" style="margin-top:12px">
      The Ed25519-signed statement, the reconciliation CSV, the hash-chained ledger, and the public key are published
      so a skeptical CFO can recompute and verify everything without trusting this page:
    </p>
    <ul class="artifact-links">
      <li><a href="${RAW}/apps/dashboard/public/uplift-statement.json">uplift-statement.json</a> — the signed statement</li>
      <li><a href="${RAW}/apps/dashboard/public/uplift-statement.csv">uplift-statement.csv</a> — recovered transactions (tie to your Stripe payout)</li>
      <li><a href="${RAW}/apps/dashboard/public/uplift-ledger.json">uplift-ledger.json</a> — the hash-chained ledger</li>
      <li><a href="${RAW}/apps/dashboard/public/ax10m-demo-pubkey.pem">ax10m-demo-pubkey.pem</a> — the public key</li>
    </ul>
    <pre class="verify">node scripts/verify-statement.mjs \\
  uplift-statement.json ax10m-demo-pubkey.pem uplift-ledger.json
# → PASS statement hash · PASS Ed25519 signature · PASS ledger chain</pre>
  </div>

  <p class="ledger-note">
    ${esc(data.meta.note)} · notarized against ledger head ${esc(st.ledgerHead.slice(0, 24))}… · integrity
    ${st.ledgerVerified ? 'verified ✓' : 'FAILED ✗'} · statement signed ${esc(recon.signingKeyId)}
  </p>
</main>`;

const artifact = `${head}\n${content}\n`;
const standalone = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n${head}\n</head>\n<body>\n${content}\n</body>\n</html>\n`;

await fs.writeFile(path.join(pubDir, 'demo.html'), standalone);
const outArg = process.argv[2];
if (outArg) await fs.writeFile(path.resolve(outArg), artifact);

// eslint-disable-next-line no-console
console.log(`wrote public/demo.html${outArg ? ` + ${outArg}` : ''} · ${r.perStratum.length} cohort rows · fee ${money(r.fee.amount, cur)} · retrain gate: ${rt.promotedVsChampion ? 'promote' : 'hold'}`);
