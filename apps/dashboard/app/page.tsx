import {
  formatMoney,
  formatPct,
  getProjectedStatement,
  getReconciliation,
} from './mock-data.js';

/**
 * Shadow-mode dashboard (ARCHITECTURE.md §6, §12 Phase 0).
 *
 * Server component. Shows the merchant, before activating, what Lift's engine
 * would have produced: projected monthly uplift (the mSPRT lower bound) and the
 * 12% fee we would have charged — computed by the REAL @lift/attribution billing
 * engine (CUPED + cluster-robust + always-valid confidence sequence) over mocked
 * cohorts. The cohort table breaks it down per stratum so a skeptical CFO can see
 * exactly where the lift comes from.
 */
export default function Page() {
  const statement = getProjectedStatement();
  const r = statement.result;
  const currency = statement.currency;
  const { export: recon, recon: tie } = getReconciliation();

  return (
    <main className="container">
      <span className="badge">Shadow mode · measuring your true baseline</span>
      <h1>Projected monthly uplift</h1>
      <p className="subtitle">
        We ran a live randomized holdout alongside your existing Stripe Smart
        Retries for <strong>{statement.period}</strong>. Below is the incremental
        recovery Lift&apos;s engine produced beyond your baseline — billed on the
        <strong> always-valid lower bound</strong>, so the number is one your
        auditor can reconcile.
      </p>

      <section className="kpis">
        <div className="kpi">
          <div className="label">Projected incremental uplift (lower bound)</div>
          <div className="value accent">
            {formatMoney(r.lowerDollarsCum.amount, currency)}
          </div>
          <div className="hint">
            Point estimate {formatMoney(Math.round(r.deltaPer * r.treatedInvoices), currency)} · we bill only the proven floor
          </div>
        </div>
        <div className="kpi">
          <div className="label">Fee we&apos;d have charged (12%)</div>
          <div className="value">{formatMoney(r.fee.amount, currency)}</div>
          <div className="hint">
            {r.billable ? 'On truly-incremental dollars' : 'Not yet billable — lift unproven'}
          </div>
        </div>
        <div className="kpi">
          <div className="label">Statistical confidence</div>
          <div className="value">
            {r.billable ? 'Proven' : 'Accruing'}
            <span style={{ color: 'var(--muted)', fontSize: 18 }}> · 95% CS</span>
          </div>
          <div className="hint">
            SRM χ²={r.srm.chiSquare.toFixed(1)} {r.srm.breached ? '✗ paused' : '✓ balanced'} · CUPED −
            {formatPct(r.cupedVarianceReduction)} variance
          </div>
        </div>
      </section>

      <div className="method-strip">
        <span><strong>{formatMoney(Math.round(r.deltaPer), currency)}</strong>/invoice point estimate</span>
        <span><strong>{formatMoney(Math.round(r.halfWidth), currency)}</strong> mSPRT half-width</span>
        <span><strong>{formatMoney(Math.round(r.lowerPer), currency)}</strong>/invoice proven floor</span>
        <span><strong>{formatMoney(Math.round(r.se), currency)}</strong> cluster-robust SE</span>
        <span><strong>{Math.round(r.effectiveN).toLocaleString()}</strong> effective N</span>
      </div>

      <div className="section-title">Cohort breakdown (by MRR tier · decline family · issuer region)</div>
      <table>
        <thead>
          <tr>
            <th>Cohort</th>
            <th className="num">Control recovery</th>
            <th className="num">Treatment recovery</th>
            <th className="num">Point uplift $/inv</th>
            <th className="num">Treated invoices</th>
            <th className="num">Weight</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {r.perStratum.map((line) => (
            <tr key={line.stratumKey}>
              <td>{line.stratumKey === '__pooled__' ? 'pooled (sub-floor)' : line.stratumKey}</td>
              <td className="num">{formatPct(line.controlRate)}</td>
              <td className="num">{formatPct(line.treatmentRate)}</td>
              <td className="num">{formatMoney(Math.round(line.deltaPerStratum), currency)}</td>
              <td className="num">{line.treatmentInvoices.toLocaleString()}</td>
              <td className="num">{formatPct(line.weight)}</td>
              <td>
                {line.pooled ? (
                  <span className="pill holdout">Pooled</span>
                ) : (
                  <span className="pill billable">In sample</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="subtitle" style={{ fontSize: 13, marginTop: 12 }}>
        The lower bound and fee are computed on the <strong>post-stratified aggregate</strong> (a
        treated-volume-weighted average of within-cohort effects), then billed once — so a cohort
        mix shift can never flip the sign of the reported lift.
      </p>

      <div className="section-title">CFO reconciliation — tie every dollar to your processor</div>
      <div className="method-strip">
        <span>Signed statement <strong>{recon.statementHash.slice(0, 16)}…</strong></span>
        <span>Signing key <strong>{recon.signingKeyId}</strong></span>
        <span>Ledger <strong>{recon.ledgerVerified ? 'verified ✓' : 'FAILED ✗'}</strong></span>
        <span>Epoch salt <strong>disclosed</strong></span>
      </div>
      <div className="recon-grid">
        <div className={`recon-card${tie.tiesOut ? ' ok' : ''}`}>
          <div className="label">Reconciles against processor payout</div>
          <div className="big">{tie.tiesOut ? 'Ties out ✓' : 'Discrepancy ✗'}</div>
          <div className="hint">
            {tie.matched.toLocaleString()} recovered txns · {formatMoney(tie.oursTotal, currency)} ={' '}
            {formatMoney(tie.theirsTotal, currency)} settled
          </div>
        </div>
        <div className="recon-card">
          <div className="label">Recovered value (treatment)</div>
          <div className="big">{formatMoney(recon.summary.treatment.recoveredAmount, currency)}</div>
          <div className="hint">
            Control {formatMoney(recon.summary.control.recoveredAmount, currency)} · net of{' '}
            {formatMoney(recon.summary.treatment.reversedAmount, currency)} reversed
          </div>
        </div>
        <div className="recon-card">
          <div className="label">Fee = 12% × proven increment</div>
          <div className="big">{formatMoney(recon.fee.fee, currency)}</div>
          <div className="hint">
            on {formatMoney(recon.fee.billableIncrement, currency)} newly proven · recomputable by hand
          </div>
        </div>
      </div>
      <p className="subtitle" style={{ fontSize: 13, marginTop: 12 }}>
        Every recovered charge carries its processor transaction id. Filter your Stripe payout
        export to those ids — the settled amounts sum to our recovered total, penny for penny. We
        disclose the epoch salt so you can recompute every control/treatment assignment yourself.
        Nothing here requires trusting Lift&apos;s dashboard.
      </p>

      <p className="ledger-note">
        Uplift Statement notarized against hash-chained ledger head:{' '}
        {statement.ledgerHead.slice(0, 24)}… · ledger integrity:{' '}
        {statement.ledgerVerified ? 'verified ✓' : 'FAILED ✗'} · statement signed{' '}
        {recon.signingKeyId}
      </p>
    </main>
  );
}
