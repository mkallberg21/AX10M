import { describe, expect, it } from 'vitest';
import { computeHoldoutEconomics, DEFAULT_HOLDOUT_SCHEDULE, holdoutFractionFor } from './holdout-economics.js';

describe('holdoutFractionFor', () => {
  const onboarded = '2026-01-01T00:00:00.000Z';
  it('is the full certification fraction inside the window, the audit fraction after', () => {
    expect(holdoutFractionFor(onboarded, '2026-02-01T00:00:00.000Z')).toBe(0.1); // ~31 days in
    expect(holdoutFractionFor(onboarded, '2026-03-15T00:00:00.000Z')).toBe(0.1); // ~73 days in
    expect(holdoutFractionFor(onboarded, '2026-05-01T00:00:00.000Z')).toBe(0.02); // >90 days → tapered
  });
  it('defaults to the certification fraction when onboarding is unknown (conservative → larger credit)', () => {
    expect(holdoutFractionFor('not-a-date', '2026-05-01T00:00:00.000Z')).toBe(DEFAULT_HOLDOUT_SCHEDULE.certificationFraction);
  });
});

describe('computeHoldoutEconomics', () => {
  it('during certification (10% holdout) the credit ~ offsets the fee → net billed near zero', () => {
    // 270 treated, per-invoice lift $2.00, holdout 10% → held-out ≈ 30 invoices → cost ≈ $60.00.
    const econ = computeHoldoutEconomics({ grossFeeMinor: 5_000, perInvoiceLiftMinor: 200, treatedInvoices: 270, holdoutFraction: 0.1 });
    expect(econ.estimatedHoldoutCostMinor).toBe(6_000); // 200 * (270 * 0.1/0.9=30) = 6000
    expect(econ.holdoutCreditMinor).toBe(5_000); // capped at the fee
    expect(econ.netBilledMinor).toBe(0);
  });

  it('after taper (2% holdout) the credit is small → the merchant pays most of the fee', () => {
    // 270 treated, holdout 2% → held-out ≈ 5.5 invoices → cost ≈ $11.02 → small credit.
    const econ = computeHoldoutEconomics({ grossFeeMinor: 5_000, perInvoiceLiftMinor: 200, treatedInvoices: 270, holdoutFraction: 0.02 });
    expect(econ.estimatedHoldoutCostMinor).toBe(1_102); // 200 * (270 * 0.02/0.98 ≈ 5.51) ≈ 1102
    expect(econ.holdoutCreditMinor).toBe(1_102);
    expect(econ.netBilledMinor).toBe(3_898); // 5000 - 1102
  });

  it('never credits more than the fee, and floors net at zero', () => {
    const econ = computeHoldoutEconomics({ grossFeeMinor: 1_000, perInvoiceLiftMinor: 500, treatedInvoices: 1_000, holdoutFraction: 0.1 });
    expect(econ.holdoutCreditMinor).toBe(1_000);
    expect(econ.netBilledMinor).toBe(0);
  });
});
