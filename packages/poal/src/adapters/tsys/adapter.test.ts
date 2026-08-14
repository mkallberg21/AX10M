import { describe, expect, it } from 'vitest';
import { DeclineCode, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { TsysAdapter } from './adapter.js';
import { mapTsysDeclineCode } from './decline-map.js';
import type { FetchLike, FetchResponseLike } from './client.js';

// ── fake transport ────────────────────────────────────────────────────────────
function res(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => lower[n.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(text) : body),
  };
}

function makeFetch(handler: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => FetchResponseLike) {
  const calls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fetch: FetchLike = async (url, init) => {
    const i = init ?? {};
    calls.push({ url, init: i });
    return handler(url, i);
  };
  return { fetch, calls };
}

const baseCfg = {
  deviceID: 'dev_1',
  transactionKey: 'txn_key',
  merchantId: 'mrc_1',
  baseUrl: 'https://tsys.test/portal',
};

const invoice: Invoice = {
  id: 'ax10m_inv_inv_1', customerId: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'inv_1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_pm_1', customerId: 'ax10m_cus_c1', processorRef: 'pm_1', token: 'tok_stored_1' };

describe('mapTsysDeclineCode', () => {
  it('maps known ISO response codes and defaults unknown to Unknown', () => {
    expect(mapTsysDeclineCode('51')).toBe(DeclineCode.InsufficientFunds);
    expect(mapTsysDeclineCode('54')).toBe(DeclineCode.ExpiredCard);
    expect(mapTsysDeclineCode('41')).toBe(DeclineCode.LostCard);
    expect(mapTsysDeclineCode('43')).toBe(DeclineCode.StolenCard);
    expect(mapTsysDeclineCode('05')).toBe(DeclineCode.DoNotHonor);
    expect(mapTsysDeclineCode('14')).toBe(DeclineCode.InvalidCard);
    expect(mapTsysDeclineCode('04')).toBe(DeclineCode.PickupCard);
    expect(mapTsysDeclineCode('65')).toBe(DeclineCode.VelocityLimitExceeded);
    expect(mapTsysDeclineCode('91')).toBe(DeclineCode.IssuerUnavailable);
    expect(mapTsysDeclineCode('99')).toBe(DeclineCode.Unknown);
    // Message-keyword fallback when the numeric code is unmapped.
    expect(mapTsysDeclineCode('99', 'DO NOT HONOR')).toBe(DeclineCode.DoNotHonor);
    expect(mapTsysDeclineCode(undefined, 'INVALID ACCOUNT')).toBe(DeclineCode.InvalidCard);
    expect(mapTsysDeclineCode(undefined, undefined)).toBe(DeclineCode.Unknown);
  });
});

describe('attemptCharge', () => {
  it('approves (status PASS), sends only the token + major-unit amount + idempotency key', async () => {
    const { fetch, calls } = makeFetch((url, init) => {
      expect(url).toBe('https://tsys.test/portal/v1/credit/sale');
      const payload = JSON.parse(init.body ?? '{}');
      // token-only (SAQ-A): the stored token is sent, never a PAN.
      expect(payload.token).toBe('tok_stored_1');
      // minor units (14900) → major decimal string "149.00".
      expect(payload.transactionAmount).toBe('149.00');
      expect(payload.currencyCode).toBe('USD');
      expect(payload.orderNumber).toBe('inv_1');
      expect(payload.cardOnFile).toBe('Y');
      // credentials in the body, not a bearer header.
      expect(payload.deviceID).toBe('dev_1');
      expect(payload.transactionKey).toBe('txn_key');
      // idempotency key: header AND echoed field.
      expect(init.headers?.['Idempotency-Key']).toBe('ax10m_charge_abc');
      expect(payload.transactionIdentifier).toBe('ax10m_charge_abc');
      return res(200, { status: 'PASS', responseCode: '00', responseMessage: 'APPROVED', transactionID: 'txn_ok' });
    });
    const adapter = new TsysAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.idempotentReplay).toBe(false);
    expect(r.attempt.status).toBe('succeeded');
    expect(r.attempt.id).toBe('ax10m_att_txn_ok');
    expect(calls).toHaveLength(1);
  });

  it('maps a DECLINED status to a decline (expected outcome, not an error)', async () => {
    const { fetch } = makeFetch(() =>
      res(200, { status: 'DECLINED', responseCode: '51', responseMessage: 'INSUFFICIENT FUNDS', transactionID: 'txn_dec' }),
    );
    const adapter = new TsysAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.status).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.InsufficientFunds);
    expect(r.attempt.id).toBe('ax10m_att_txn_dec');
    expect(r.idempotentReplay).toBe(false);
  });

  it('rethrows a gateway FAIL (validation/auth) so the saga can retry', async () => {
    const { fetch } = makeFetch(() =>
      res(200, { status: 'FAIL', responseCode: 'E01', responseMessage: 'Invalid transactionKey' }),
    );
    const adapter = new TsysAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow(/transactionKey/i);
  });

  it('rethrows an HTTP transport error', async () => {
    const { fetch } = makeFetch(() => res(500, { status: 'FAIL', responseMessage: 'gateway timeout' }));
    const adapter = new TsysAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow();
  });
});

describe('capabilities & unsupported surfaces', () => {
  it('advertises a DRIVE, webhook-less capability matrix', () => {
    const adapter = new TsysAdapter(baseCfg);
    const caps = adapter.capabilities();
    expect(caps.integrationMode).toBe('drive');
    expect(caps.externalRetryControl).toBe(true);
    expect(caps.webhooks).toBe(false);
    expect(caps.listPaymentMethods).toBe(false);
  });

  it('fails closed on ingestWebhook and returns empty reconciliation', async () => {
    const adapter = new TsysAdapter(baseCfg);
    await expect(adapter.ingestWebhook({ body: '{}', headers: {} })).rejects.toThrow(/no signed webhook/);
    const page = await adapter.listOpenFailures(null);
    expect(page).toEqual({ invoices: [], nextCursor: null });
    expect(await adapter.fetchUpdatedCard(method)).toBeNull();
    expect(await adapter.listPaymentMethods({
      id: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'c1', issuerRegion: 'unknown',
      createdAt: '2026-01-01T00:00:00.000Z', consent: { email: true, sms: false, whatsapp: false, push: false, globallyOptedOut: false },
    })).toEqual([]);
  });
});
