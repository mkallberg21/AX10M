import { Controller, ForbiddenException, Get, HttpCode, Post, Query } from '@nestjs/common';
import { RecoveryCaseService } from '../recovery/recovery-case.service.js';
import { computePnl, type PnlReport } from './pnl.js';
import { buildDemoLedgerEvents } from './demo-seed.js';

/**
 * Analytics API — the live P&L / revenue view over the shared ledger.
 *
 *   GET /analytics/pnl[?currency=USD&days=30]
 *     → per-processor (MoR) + cumulative recovered revenue and accrued AX10M fee, over rolling
 *       day/week/month/year windows with period-over-period deltas, plus a daily series.
 *
 * Reads the same ledger the recovery worker writes (shared Postgres when DATABASE_URL is set),
 * so it reflects real recoveries as they land. Fee is an ACCRUAL (feeRate × recovered); actual
 * billing is feeRate × proven uplift — see pnl.ts.
 */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly recovery: RecoveryCaseService) {}

  @Get('pnl')
  async pnl(@Query('currency') currency?: string, @Query('days') days?: string): Promise<PnlReport> {
    const entries = await this.recovery.ledgerEntries();
    const feeRateEnv = Number(process.env.AX10M_FEE_RATE);
    const feeRate = Number.isFinite(feeRateEnv) && feeRateEnv > 0 && feeRateEnv < 1 ? feeRateEnv : 0.12;
    const seriesDays = days ? Math.max(1, Math.min(365, Number(days) || 30)) : 30;
    return computePnl(entries, { nowIso: new Date().toISOString(), feeRate, currency: currency || undefined, seriesDays });
  }

  /**
   * Seed the ledger with DETERMINISTIC synthetic recoveries so the P&L page can be seen
   * populated before real charging exists. Gated hard: only fires when AX10M_ALLOW_DEMO_SEED
   * === 'true' (off by default → 403), because the ledger is append-only and seeded events
   * cannot be removed. Every event is marked `demo: true`.
   */
  @Post('seed-demo')
  @HttpCode(200)
  async seedDemo(@Query('days') days?: string): Promise<{ seeded: number; note: string }> {
    if (process.env.AX10M_ALLOW_DEMO_SEED !== 'true') {
      throw new ForbiddenException('Demo seeding is disabled. Set AX10M_ALLOW_DEMO_SEED=true (dev/disposable ledger only) to enable.');
    }
    const windowDays = days ? Math.max(1, Math.min(365, Number(days) || 45)) : 45;
    const events = buildDemoLedgerEvents({ nowIso: new Date().toISOString(), days: windowDays });
    const seeded = await this.recovery.appendDemoEvents(events);
    return { seeded, note: 'Synthetic demo recoveries appended (marked demo:true). Append-only — restart with a fresh ledger to clear.' };
  }
}
