import { describe, expect, it } from 'vitest';
import { icpQuote } from './icp-quote.js';

describe('icpQuote', () => {
  it('a high-volume merchant clears the ICP floor and proves quickly', () => {
    const q = icpQuote({ monthlyFailedPayments: 8_000, avgInvoiceAmountMinor: 5_000, baselineRecoveryRate: 0.3, upliftRatePoints: 0.05 });
    expect(q.clearsIcpFloor).toBe(true);
    expect(q.estimatedDaysToProvenLift).not.toBeNull();
    expect(q.estimatedDaysToProvenLift!).toBeLessThanOrEqual(90);
    expect(q.estimatedProvenMonthlyFeeMinor).toBeGreaterThan(0);
    expect(q.minMonthlyFailedPayments).toBeGreaterThan(0);
  });

  it('a low-volume merchant does not clear the floor within the certification window', () => {
    const q = icpQuote({ monthlyFailedPayments: 200, avgInvoiceAmountMinor: 5_000, baselineRecoveryRate: 0.3, upliftRatePoints: 0.05 });
    expect(q.clearsIcpFloor).toBe(false);
    expect(q.estimatedDaysToProvenLift!).toBeGreaterThan(90);
    // Its required floor exceeds its current volume.
    expect(q.minMonthlyFailedPayments).toBeGreaterThan(200);
  });

  it('a larger effect proves faster and lowers the required volume floor', () => {
    const small = icpQuote({ monthlyFailedPayments: 5_000, avgInvoiceAmountMinor: 5_000, baselineRecoveryRate: 0.3, upliftRatePoints: 0.02 });
    const big = icpQuote({ monthlyFailedPayments: 5_000, avgInvoiceAmountMinor: 5_000, baselineRecoveryRate: 0.3, upliftRatePoints: 0.08 });
    expect(big.estimatedDaysToProvenLift!).toBeLessThan(small.estimatedDaysToProvenLift!);
    expect(big.minMonthlyFailedPayments).toBeLessThan(small.minMonthlyFailedPayments);
  });

  it('a zero effect can never be proven', () => {
    const q = icpQuote({ monthlyFailedPayments: 10_000, avgInvoiceAmountMinor: 5_000, baselineRecoveryRate: 0.3, upliftRatePoints: 0 });
    expect(q.estimatedDaysToProvenLift).toBeNull();
    expect(q.clearsIcpFloor).toBe(false);
    expect(q.estimatedProvenMonthlyFeeMinor).toBe(0);
  });
});
