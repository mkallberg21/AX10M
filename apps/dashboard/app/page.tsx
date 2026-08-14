import {
  formatMoney,
  formatPct,
  getProjectedStatement,
} from './mock-data.js';

/**
 * Shadow-mode dashboard (ARCHITECTURE.md §6, §12 Phase 0).
 *
 * Server component. Shows the merchant, before activating, what Lift's engine
 * would have produced: projected monthly uplift (lower bound) and the 12% fee we
 * would have charged — computed by the real @lift/attribution engine over mocked
 * cohort stats. The cohort table breaks it down per stratum so a skeptical CFO
 * can see exactly where the lift comes from.
 */
export default function Page() {
  const statement = getProjectedStatement();

  const billableStrata = statement.lines.filter((l) => l.billable).length;

  return (
    <main className="container">
      <span className="badge">Shadow mode · measuring your true baseline</span>
      <h1>Projected monthly uplift</h1>
      <p className="subtitle">
        We ran a live randomized holdout alongside your existing Stripe Smart
        Retries for <strong>{statement.period}</strong>. Below is the incremental
        recovery Lift&apos;s engine produced beyond your baseline — billed on the
        lower confidence bound, so the number is one your auditor can reconcile.
      </p>

      <section className="kpis">
        <div className="kpi">
          <div className="label">Projected incremental uplift (lower bound)</div>
          <div className="value accent">
            {formatMoney(
              statement.totalIncrementalLower.amount,
              statement.totalIncrementalLower.currency,
            )}
          </div>
          <div className="hint">Verified vs. a simultaneous control group</div>
        </div>
        <div className="kpi">
          <div className="label">Fee we&apos;d have charged (12%)</div>
          <div className="value">
            {formatMoney(statement.totalFee.amount, statement.totalFee.currency)}
          </div>
          <div className="hint">Only on truly-incremental dollars</div>
        </div>
        <div className="kpi">
          <div className="label">Billable cohorts</div>
          <div className="value">
            {billableStrata}
            <span style={{ color: 'var(--muted)', fontSize: 18 }}>
              {' '}
              / {statement.lines.length}
            </span>
          </div>
          <div className="hint">Cleared min-sample + positive lower bound</div>
        </div>
      </section>

      <div className="section-title">Cohort breakdown (by MRR tier · decline family · issuer region)</div>
      <table>
        <thead>
          <tr>
            <th>Cohort</th>
            <th className="num">Control recovery</th>
            <th className="num">Treatment recovery</th>
            <th className="num">Uplift (pt)</th>
            <th className="num">Uplift (lower)</th>
            <th className="num">Incremental $ (lower)</th>
            <th className="num">Fee (12%)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {statement.lines.map((line) => (
            <tr key={line.stratumKey}>
              <td>{line.stratumKey}</td>
              <td className="num">{formatPct(line.controlRate)}</td>
              <td className="num">{formatPct(line.treatmentRate)}</td>
              <td className="num">{formatPct(line.rateDiff)}</td>
              <td className="num">{formatPct(line.rateDiffLower)}</td>
              <td className="num">
                {formatMoney(
                  line.incrementalDollarsLower.amount,
                  line.incrementalDollarsLower.currency,
                )}
              </td>
              <td className="num">{formatMoney(line.fee.amount, line.fee.currency)}</td>
              <td>
                {line.billable ? (
                  <span className="pill billable">Billable</span>
                ) : (
                  <span className="pill holdout">Not billable</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="ledger-note">
        Uplift Statement notarized against hash-chained ledger head:{' '}
        {statement.ledgerHead.slice(0, 24)}… · ledger integrity:{' '}
        {statement.ledgerVerified ? 'verified ✓' : 'FAILED ✗'}
      </p>
    </main>
  );
}
