import { describe, expect, it } from 'vitest';
import { DeclineCode, DeclineFamily } from '@ax10m/canonical';
import {
  AXP_KINDS,
  AXP_VERSION,
  isAxpEnvelope,
  isAxpKind,
  makeEnvelope,
  type AxpDeclineNormalization,
  type AxpUpliftEvent,
} from './index.js';

describe('AXP envelopes', () => {
  it('makeEnvelope stamps kind + version and carries the payload', () => {
    const payload: AxpDeclineNormalization = {
      processor: 'stripe',
      rawCode: 'insufficient_funds',
      canonicalCode: DeclineCode.InsufficientFunds,
      family: DeclineFamily.Soft,
      retriable: true,
      recommendedAction: 'retry',
    };
    const env = makeEnvelope('AXP-01', 'msg_1', '2026-08-14T12:00:00.000Z', payload);
    expect(env.axp).toBe('AXP-01');
    expect(env.version).toBe(AXP_VERSION);
    expect(env.payload.canonicalCode).toBe(DeclineCode.InsufficientFunds);
    expect(isAxpEnvelope(env)).toBe(true);
  });

  it('recognizes all six kinds and rejects others', () => {
    expect(AXP_KINDS).toHaveLength(6);
    for (const k of AXP_KINDS) expect(isAxpKind(k)).toBe(true);
    expect(isAxpKind('AXP-99')).toBe(false);
    expect(isAxpKind(42)).toBe(false);
  });

  it('validates envelope structure', () => {
    expect(isAxpEnvelope({ axp: 'AXP-03', version: '0.1.0', id: 'x', issuedAt: 't', payload: {} })).toBe(true);
    expect(isAxpEnvelope({ axp: 'AXP-03', version: '0.1.0', id: 'x' })).toBe(false); // no payload/issuedAt
    expect(isAxpEnvelope(null)).toBe(false);
  });

  it('carries a signed, holdout-verified uplift event (AXP-03)', () => {
    const uplift: AxpUpliftEvent = {
      merchantId: 'mrc_1',
      period: '2026-08',
      incrementalRecoveredMinor: 1_250_00,
      currency: 'USD',
      confidence: 0.95,
      feeMinor: Math.round(1_250_00 * 0.12),
      ledgerHead: 'abc123',
      signature: 'ed25519:deadbeef',
    };
    const env = makeEnvelope('AXP-03', 'msg_2', '2026-08-31T00:00:00.000Z', uplift);
    expect(env.payload.feeMinor).toBe(15000); // 12% of $1,250.00 = $150.00
    expect(isAxpEnvelope(env)).toBe(true);
  });
});
