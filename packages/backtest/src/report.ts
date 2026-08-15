/**
 * Render the three outputs: results.json (raw), report.md (verdict-first), lift.svg
 * (cumulative recovered revenue per invoice, by arm, over time, with a lower-bound band).
 * No result is massaged — the verdict is computed mechanically from the estimate.
 */

import type { BillableUpliftResult } from '@ax10m/attribution';
import type { InvoiceOutcome } from './sim/simulate.js';
import type { AaResult, BaselineReachPoint, PowerPoint, SensitivityPoint } from './checks.js';

export interface CodeBreak {
  code: string;
  share: number;
  controlRate: number;
  treatmentRate: number;
  controlN: number;
  treatmentN: number;
}

/** Per-decline-code recovery rates by arm — substantiates WHERE the difference comes from. */
export function computeByCode(control: readonly InvoiceOutcome[], treatment: readonly InvoiceOutcome[]): CodeBreak[] {
  const total = control.length + treatment.length || 1;
  const codes = new Set<string>();
  for (const o of control) codes.add(o.invoice.declineCode);
  for (const o of treatment) codes.add(o.invoice.declineCode);
  const rate = (list: readonly InvoiceOutcome[], code: string): { rate: number; n: number } => {
    const arm = list.filter((o) => o.invoice.declineCode === code);
    return { rate: arm.length > 0 ? arm.filter((o) => o.recovered).length / arm.length : 0, n: arm.length };
  };
  return [...codes]
    .map((code) => {
      const c = rate(control, code);
      const t = rate(treatment, code);
      return { code, share: (c.n + t.n) / total, controlRate: c.rate, treatmentRate: t.rate, controlN: c.n, treatmentN: t.n };
    })
    .sort((a, b) => b.share - a.share);
}

export interface RunInputs {
  nCustomers: number;
  streamSeed: number;
  controlSeed: number;
  treatmentSeed: number;
  controlPolicy: string;
  treatmentPolicy: string;
}

export interface RunResults {
  inputs: RunInputs;
  controlSummary: { n: number; rate: number; recoveredMinor: number };
  treatmentSummary: { n: number; rate: number; recoveredMinor: number };
  estimate: BillableUpliftResult;
  aa: AaResult;
  power: PowerPoint[];
  sensitivity: SensitivityPoint[];
  baselineReach: BaselineReachPoint[];
  byCode: CodeBreak[];
  verdict: string;
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
const pp = (x: number): string => `${(x * 100).toFixed(2)} pp`;
const usd = (minor: number): string => `$${(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** The mechanical verdict (§1.5). One of three, no preamble. */
export function computeVerdict(est: BillableUpliftResult): string {
  const diff = est.rateDiff;
  if (diff <= 0) {
    return `VERDICT: the AX10M engine does NOT beat the Stripe Smart Retries baseline in this simulated world (Δrecovery = ${pp(diff)}; the baseline is at least as good).`;
  }
  if (est.billable && est.lowerPer > 0) {
    return `VERDICT: under these assumptions the AX10M engine beats the baseline by ${pp(diff)} (recovery-rate), with a positive holdout-verified lower bound — it would bill ${usd(est.fee.amount)}.`;
  }
  return `VERDICT: inconclusive at this sample size — the point estimate favors the AX10M engine by ${pp(diff)}, but the mSPRT lower bound is not positive (${est.gateReasons.join('; ') || 'not yet significant'}), so it would bill $0.`;
}

/** Cumulative mean recovered dollars per invoice, by day, for one arm. */
export function cumulativePerInvoice(outcomes: readonly InvoiceOutcome[], maxDay: number): number[] {
  const n = outcomes.length || 1;
  const series: number[] = [];
  for (let day = 0; day <= maxDay; day++) {
    let sum = 0;
    for (const o of outcomes) if (o.recovered && o.recoveryDay !== null && o.recoveryDay <= day) sum += o.recoveredMinor;
    series.push(sum / n / 100); // dollars per invoice
  }
  return series;
}

export function renderReportMd(r: RunResults): string {
  const e = r.estimate;
  const lines: string[] = [];
  lines.push(r.verdict);
  lines.push('');
  lines.push('# AX10M Backtest — does the recovery engine beat Stripe Smart Retries?');
  lines.push('');
  lines.push(`_Synthetic backtest. Treatment = \`${r.inputs.treatmentPolicy}\`, Control = \`${r.inputs.controlPolicy}\`. ` +
    `${r.controlSummary.n.toLocaleString()} control invoices, ${r.treatmentSummary.n.toLocaleString()} treatment invoices, stream seed ${r.inputs.streamSeed}._`);
  lines.push('');
  lines.push('## Headline');
  lines.push('');
  lines.push('| Metric | Control (Smart Retries) | Treatment (AX10M engine) |');
  lines.push('|---|---|---|');
  lines.push(`| Recovery rate | ${pct(r.controlSummary.rate)} | ${pct(r.treatmentSummary.rate)} |`);
  lines.push(`| Recovered $ | ${usd(r.controlSummary.recoveredMinor)} | ${usd(r.treatmentSummary.recoveredMinor)} |`);
  lines.push('');
  lines.push(`- **Absolute recovery-rate lift:** ${pp(e.rateDiff)}`);
  lines.push(`- **Relative lift:** ${r.controlSummary.rate > 0 ? `${((e.rateDiff / r.controlSummary.rate) * 100).toFixed(1)}%` : 'n/a'}`);
  lines.push(`- **CUPED-adjusted incremental $/treated invoice (point):** ${usd(Math.round(e.deltaPer))} (SE ${usd(Math.round(e.se))})`);
  lines.push(`- **mSPRT lower bound $/treated invoice:** ${usd(Math.round(e.lowerPer))}`);
  lines.push(`- **Proven lower-bound dollars (cum):** ${usd(e.lowerDollarsCum.amount)}`);
  lines.push(`- **Would it bill?** ${e.billable ? `yes — fee ${usd(e.fee.amount)}` : `no (${e.gateReasons.join('; ')})`}`);
  lines.push(`- CUPED variance reduction: ${pct(e.cupedVarianceReduction)} · SRM χ²=${e.srm.chiSquare.toFixed(2)}${e.srm.breached ? ' (BREACHED)' : ''}`);
  lines.push('');
  lines.push('## Fairness — is any engine gain just a longer retry window?');
  lines.push('');
  lines.push('The headline compares the engine to Stripe Smart Retries\' **default** reach (~day 18). But a ' +
    'baseline can simply retry longer. This sweep runs the engine against baselines that reach further:');
  lines.push('');
  lines.push('| Baseline reaches | Control recovery | Engine recovery | Δ (engine − baseline) |');
  lines.push('|---|---|---|---|');
  for (const p of r.baselineReach) {
    lines.push(`| day ${p.lastDay} | ${pct(p.controlRate)} | ${pct(p.treatmentRate)} | ${pp(p.rateDiff)} |`);
  }
  lines.push('');
  const first = r.baselineReach[0];
  const last = r.baselineReach[r.baselineReach.length - 1];
  const flips = first && last && first.rateDiff > 0 && last.rateDiff < 0;
  lines.push(`**Reading it honestly.** ${flips
    ? 'The engine only edges ahead of the *default* (short-reaching) baseline; against a baseline that retries as ' +
      'far as the engine does, the engine **loses**. So the apparent gain is a **window-length effect any baseline ' +
      'can copy**, not decline-specific intelligence. On recovery rate alone, in a world with no attempt cost, ' +
      '"retry everything for longer" beats the engine.'
    : 'See the table for how the comparison moves as the baseline reaches further.'}`);
  lines.push('');
  lines.push('The engine\'s real case therefore cannot rest on raw recovery rate. It rests on what this backtest does ' +
    'NOT price: **per-attempt cost and card-network retry-cap fines** (a maximally-persistent baseline would breach ' +
    'network caps — which the guardrail prevents but recovery-rate ignores), and the **cross-merchant issuer ' +
    'flywheel** (the engine runs on cold features here). Proving that edge needs a cost/compliance-aware objective ' +
    'and a live holdout — not this metric.');
  lines.push('');
  lines.push('## Where the difference comes from (by decline code)');
  lines.push('');
  lines.push('| Decline code | Volume share | Control recovery | Treatment recovery | Δ |');
  lines.push('|---|---|---|---|---|');
  for (const c of r.byCode) {
    if (c.share < 0.005) continue;
    lines.push(`| ${c.code} | ${pct(c.share)} | ${pct(c.controlRate)} | ${pct(c.treatmentRate)} | ${pp(c.treatmentRate - c.controlRate)} |`);
  }
  lines.push('');
  lines.push('**Mechanism (why the engine underperforms *here*).** The deficit spans every recoverable ' +
    'decline code and has a single cause: the engine acts too **early** and stops too **soon**. Its ARSE ' +
    'schedule is front-loaded with no attempt after ~day 11 (insufficient-funds ~day 11, do-not-honor ~day 7.5, ' +
    'transient issuer errors clustered in the first hours), while this world\'s recovery onsets extend to 2–4 ' +
    'weeks — monthly paydays, ~3-week card reissue, diffuse do-not-honor — and even "transient" issuer errors ' +
    'clear over ~a day. The baseline\'s four blanket retries reach day 18, covering the back half of every window ' +
    'the engine never revisits: it wins on insufficient-funds (later paydays), do-not-honor, the immediate-onset ' +
    'issuer codes (its day-1 attempt lands *after* onset; the engine\'s sub-hour cluster often fires *before* it), ' +
    'and even expired cards (a day-18 retry with Account Updater recovers ~15% of them; the engine\'s day-0 ' +
    'card-update comm lands weeks before the reissue and recovers ~0). Only lost/stolen/closed cards are a true ' +
    'wash. In a recovery-rate-only world with no attempt cost, reaching later beats acting early-and-selectively.');
  lines.push('');
  lines.push('## Validity checks');
  lines.push('');
  lines.push(`**A/A test (engine vs itself):** ${r.aa.passed ? 'PASS' : 'FAIL — estimator suspect'} — Δrate ${pp(r.aa.rateDiff)}, lower bound ${usd(Math.round(r.aa.lowerPer))}, billable ${r.aa.billable}. ` +
    `${r.aa.passed ? 'The estimator does not manufacture lift where there is none.' : 'The estimator reported lift on identical policies — DO NOT TRUST any positive result above.'}`);
  lines.push('');
  lines.push('**Power curve** — minimum invoices to detect a given true lift (α=0.05, world amount variance + clustering):');
  lines.push('');
  lines.push('| True lift | Min invoices to a positive lower bound | Control customers at detection |');
  lines.push('|---|---|---|');
  for (const p of r.power) lines.push(`| ${p.liftPp} pp | ${p.minInvoices === null ? '> 200k (not reached)' : p.minInvoices.toLocaleString()} | ${p.controlClustersAtDetect ?? '—'} |`);
  lines.push('');
  lines.push('This is the **minimum viable merchant size** for billing: a merchant whose monthly failed-payment volume is below the row for the lift we actually deliver can never be billed under "unproven months bill $0."');
  lines.push('');
  lines.push('**Sensitivity sweep (±30% on each world parameter):**');
  lines.push('');
  lines.push('| Parameter | ×0.7 Δrate | ×0.7 lower$ | ×1.3 Δrate | ×1.3 lower$ |');
  lines.push('|---|---|---|---|---|');
  const byParam = new Map<string, SensitivityPoint[]>();
  for (const s of r.sensitivity) { const a = byParam.get(s.param) ?? []; a.push(s); byParam.set(s.param, a); }
  for (const [param, pts] of byParam) {
    const lo = pts.find((p) => p.factor === 0.7)!;
    const hi = pts.find((p) => p.factor === 1.3)!;
    lines.push(`| ${param} | ${pp(lo.rateDiff)} | ${usd(Math.round(lo.lowerPer))} | ${pp(hi.rateDiff)} | ${usd(Math.round(hi.lowerPer))} |`);
  }
  const signs = r.sensitivity.map((s) => Math.sign(s.rateDiff));
  const signStable = signs.every((s) => s === signs[0]);
  lines.push('');
  lines.push(`Sign of the lift is ${signStable ? '**stable**' : '**NOT stable**'} across the sweep. ${signStable ? '' : 'A result whose sign flips under a ±30% parameter change is fragile — treat the headline as indicative only.'}`);
  lines.push('');
  lines.push('## Assumptions & Limitations (read before trusting any number)');
  lines.push('');
  lines.push('- **Synthetic world.** Every recovery dynamic is modeled, not observed. Parameters are in `src/world/sources.ts`, each tagged `GROUNDED:` (qualitative real basis) or `ASSUMPTION:` (a plain conservative guess, no verified public figure). No precise statistic is attributed to a named company.');
  lines.push('- **Same-author caveat.** The world model and the engine were written by the same author; true blind separation is impossible here. Mitigations: the world was written before the engine policy was wired in and derived independently of the engine\'s own numbers; the A/A test guards the estimator; the sensitivity sweep guards against a world tuned to flatter the engine.');
  lines.push('- **Smart Retries is modeled, not exact.** Stripe\'s ML-selected retry times and attempt count are not public; the baseline is a strong, decline-agnostic 4-attempt schedule (days 1/4/10/18) meant to be a fair opponent, not a strawman. If the real Smart Retries times differ, the comparison shifts.');
  lines.push('- **Engine features are cold.** A backtest has no customer history, so the engine runs on neutral priors (tenure/prior-recovery/issuer). Its production edge from the cross-merchant issuer flywheel is NOT exercised here — this understates the engine.');
  lines.push('- **No cost of wasted attempts.** Recovery rate ignores per-attempt cost and network-cap fines; the engine\'s suppression advantage (not burning attempts on dead credentials) does not show up in recovery rate, only in cost — which this backtest does not price. A cost-aware objective would narrow the gap; it would not, on this evidence, reverse it (the deficit is soft/gray *timing*, not wasted attempts).');
  lines.push('- **Card-update comms modeled as instantaneous.** A `card_update` action is adjudicated at its action day, so the engine\'s day-0 comm lands weeks before the ~3-week reissue and recovers ~0 of expired cards, while the baseline\'s day-18 retry (Account Updater) recovers ~15%. Modeling the comm\'s effect at the reissue day would win the engine back some expired volume (~12% of the book) — a few points — but would NOT reverse the sign, which is driven by soft/gray timing on the ~56% insufficient-funds + do-not-honor majority.');
  lines.push('- **Independent per-attempt success draws** within the recoverable window; a policy is rewarded for placing attempts in-window, not for raw frequency (out-of-window attempts fail).');
  lines.push('- **One epoch, one merchant, card-only.** No multi-epoch dynamics, no bank debit, no MoR.');
  lines.push('');
  lines.push('## Reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push('corepack pnpm --filter @ax10m/backtest run backtest');
  lines.push('```');
  lines.push('Deterministic: the same seeds reproduce `results.json` byte-for-byte. See `results.json` for all seeds and parameters.');
  lines.push('');
  return lines.join('\n');
}

export function renderLiftSvg(control: readonly number[], treatment: readonly number[], lowerPerDollars: number, verdictShort: string): string {
  const W = 760, H = 420, padL = 64, padR = 24, padT = 56, padB = 48;
  const maxDay = Math.max(control.length, treatment.length) - 1;
  const maxY = Math.max(...control, ...treatment, 0.01) * 1.1;
  const x = (day: number): number => padL + (day / maxDay) * (W - padL - padR);
  const y = (v: number): number => H - padB - (v / maxY) * (H - padT - padB);
  const path = (s: readonly number[]): string => s.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  // Lower-bound band: treatment curve minus the per-invoice lower-bound gap floor.
  const ctrlFinal = control[control.length - 1] ?? 0;
  const bandTop = ctrlFinal + lowerPerDollars;
  const gridY = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif,system-ui,sans-serif">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<text x="${padL}" y="24" font-size="15" font-weight="700" fill="#0f172a">Cumulative recovered $ per invoice, by arm</text>`,
    `<text x="${padL}" y="42" font-size="11" fill="#475569">${escapeXml(verdictShort)}</text>`,
    ...gridY.map((v) => `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="#e2e8f0"/><text x="${padL - 8}" y="${(y(v) + 3).toFixed(1)}" font-size="10" fill="#94a3b8" text-anchor="end">$${v.toFixed(2)}</text>`),
    `<text x="${(W / 2).toFixed(0)}" y="${H - 12}" font-size="11" fill="#64748b" text-anchor="middle">days since decline</text>`,
    // lower-bound band (control → control+lowerBound) at the right edge
    `<line x1="${padL}" y1="${y(ctrlFinal).toFixed(1)}" x2="${W - padR}" y2="${y(ctrlFinal).toFixed(1)}" stroke="#cbd5e1" stroke-dasharray="4 3"/>`,
    `<rect x="${(W - padR - 120).toFixed(1)}" y="${y(bandTop).toFixed(1)}" width="120" height="${Math.max(0, y(ctrlFinal) - y(bandTop)).toFixed(1)}" fill="#22c55e" opacity="0.14"/>`,
    `<path d="${path(control)}" fill="none" stroke="#64748b" stroke-width="2"/>`,
    `<path d="${path(treatment)}" fill="none" stroke="#2563eb" stroke-width="2.5"/>`,
    `<circle cx="${x(maxDay).toFixed(1)}" cy="${y(treatment[treatment.length - 1] ?? 0).toFixed(1)}" r="3.5" fill="#2563eb"/>`,
    `<circle cx="${x(maxDay).toFixed(1)}" cy="${y(ctrlFinal).toFixed(1)}" r="3.5" fill="#64748b"/>`,
    `<rect x="${padL}" y="${padT}" width="12" height="3" fill="#64748b"/><text x="${padL + 18}" y="${padT + 4}" font-size="11" fill="#334155">Control — Smart Retries</text>`,
    `<rect x="${padL + 190}" y="${padT}" width="12" height="3" fill="#2563eb"/><text x="${padL + 208}" y="${padT + 4}" font-size="11" fill="#334155">Treatment — AX10M engine</text>`,
    `<rect x="${padL + 400}" y="${padT - 4}" width="12" height="10" fill="#22c55e" opacity="0.2"/><text x="${padL + 418}" y="${padT + 4}" font-size="11" fill="#334155">holdout-verified lower bound</text>`,
    `</svg>`,
  ].join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
}
