/**
 * Demo-data loader. Reads `demo-data.json`, which is generated from the Phase-1 world
 * model + policies + the REAL @ax10m/attribution estimator (see
 * `scripts/gen-demo.mjs` and `@ax10m/backtest` `buildDemoData`). Because it comes from
 * the same generator as the backtest, the dashboard can never show a result the
 * backtest contradicts — in particular the engine does NOT beat Smart Retries, so the
 * statement honestly bills $0. Regenerate with `pnpm --filter @ax10m/dashboard gen-demo`.
 */

import type { BillableStatement, ReconResult } from '@ax10m/attribution';
import type { OnboardingState, Readiness, ShadowProgress, ShadowProjection } from '@ax10m/onboarding';
import demoJson from './demo-data.json';

export interface OnboardingView {
  state: OnboardingState;
  progress: ShadowProgress;
  projection: ShadowProjection;
  readiness: Readiness;
}

export interface ReconSummary {
  merchantId: string;
  period: string;
  currency: string;
  statementHash: string;
  signature?: string;
  signingKeyId?: string;
  ledgerHead: string;
  ledgerVerified: boolean;
  recoveredCount: number;
  summary: {
    control: { invoices: number; recovered: number; recoveredAmount: number; reversedAmount: number };
    treatment: { invoices: number; recovered: number; recoveredAmount: number; reversedAmount: number };
  };
  fee: { feeRate: number; fee: number; billableIncrement: number; billable: boolean; gateReasons: string[]; lowerPer: number; deltaPer: number };
}

interface DemoShape {
  onboarding: OnboardingView;
  statement: BillableStatement;
  reconSummary: ReconSummary;
  reconResult: ReconResult;
  meta: { generatedAt: string; nCustomers: number; seed: number; backtestVerdict: string; note: string };
}

const demo = demoJson as unknown as DemoShape;

export const getOnboarding = (): OnboardingView => demo.onboarding;
export const getProjectedStatement = (): BillableStatement => demo.statement;
export const getReconciliation = (): { export: ReconSummary; recon: ReconResult } => ({ export: demo.reconSummary, recon: demo.reconResult });
export const getMeta = () => demo.meta;

export function formatMoney(minorUnits: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minorUnits / 100);
}

export function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
