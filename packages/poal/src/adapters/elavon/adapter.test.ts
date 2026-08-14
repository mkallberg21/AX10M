import { describe, expect, it } from 'vitest';
import { DeclineCode, type Invoice, type PaymentMethod } from '@ax10m/canonical';
import { ElavonAdapter } from './adapter.js';
import { mapElavonDeclineCode } from './decline-map.js';
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
  sslMerchantId: '000001',
  sslUserId: 'apiuser',
  sslPin: 'test_pin',
  merchantId: 'mrc_1',
  baseUrl: 'https://converge.test/VirtualMerchant/process.do',
};

const invoice: Invoice = {
  id: 'ax10m_inv_inv_1', customerId: 'ax10m_cus_c1', merchantId: 'mrc_1', processorRef: 'inv_1',
  amount: { amount: 14900, currency: 'USD' }, status: 'open', createdAt: '2026-08-01T00:00:00.000Z',
};
const method: PaymentMethod = { id: 'ax10m_pm_pm_1', customerId: 'ax10m_cus_c1', processorRef: 'pm_1', token: 'tok_multiuse_1' };

describe('mapElavonDeclineCode', () => {
  it('maps known issuer messages and defaults unknown to Unknown', () => {
    expect(mapElavonDeclineCode('INSUFFICIENT FUNDS')).toBe(DeclineCode.InsufficientFunds);
    expect(mapElavonDeclineCode('EXPIRED CARD')).toBe(DeclineCode.ExpiredCard);
    expect(mapElavonDeclineCode('PICK UP CARD')).toBe(DeclineCode.PickupCard);
    expect(mapElavonDeclineCode('LOST/STOLEN CARD')).toBe(DeclineCode.LostCard);
    expect(mapElavonDeclineCode('STOLEN CARD')).toBe(DeclineCode.StolenCard);
    expect(mapElavonDeclineCode('DO NOT HONOR')).toBe(DeclineCode.DoNotHonor);
    expect(mapElavonDeclineCode('INVALID CARD NUMBER')).toBe(DeclineCode.InvalidCard);
    expect(mapElavonDeclineCode('DECLINED')).toBe(DeclineCode.DoNotHonor);
    expect(mapElavonDeclineCode('')).toBe(DeclineCode.Unknown);
    // A non-zero result code with no recognizable message is a generic decline.
    expect(mapElavonDeclineCode(undefined, '1')).toBe(DeclineCode.DoNotHonor);
    expect(mapElavonDeclineCode('SOMETHING WEIRD')).toBe(DeclineCode.Unknown);
  });
});

describe('attemptCharge', () => {
  it('approves (ssl_result 0), sends only the token + major-unit amount, and echoes the idempotency key', async () => {
    const { fetch, calls } = makeFetch((url, init) => {
      expect(url).toBe('https://converge.test/VirtualMerchant/process.do');
      const body = init.body ?? '';
      // token-only (SAQ-A): the multi-use token is sent, never a PAN.
      expect(body).toContain('ssl_token=tok_multiuse_1');
      // minor units (14900) → major decimal string "149.00".
      expect(body).toContain('ssl_amount=149.00');
      expect(body).toContain('ssl_transaction_type=ccsale');
      expect(body).toContain('ssl_invoice_number=inv_1');
      // credentials travel in the body, not a header.
      expect(body).toContain('ssl_merchant_id=000001');
      expect(body).toContain('ssl_result_format=JSON');
      // deterministic key echoed for audit.
      expect(body).toContain('ssl_merchant_txn_id=ax10m_charge_abc');
      return res(200, { ssl_result: '0', ssl_result_message: 'APPROVAL', ssl_txn_id: 'txn_ok' });
    });
    const adapter = new ElavonAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('succeeded');
    expect(r.idempotentReplay).toBe(false);
    expect(r.attempt.status).toBe('succeeded');
    expect(r.attempt.id).toBe('ax10m_att_txn_ok');
    expect(calls).toHaveLength(1);
  });

  it('maps a non-zero ssl_result to a decline (expected outcome, not an error)', async () => {
    const { fetch } = makeFetch(() =>
      res(200, { ssl_result: '1', ssl_result_message: 'INSUFFICIENT FUNDS', ssl_txn_id: 'txn_dec' }),
    );
    const adapter = new ElavonAdapter({ ...baseCfg, fetch });
    const r = await adapter.attemptCharge(invoice, method, 'ax10m_charge_abc');
    expect(r.outcome).toBe('failed');
    expect(r.attempt.status).toBe('failed');
    expect(r.attempt.declineCode).toBe(DeclineCode.InsufficientFunds);
    expect(r.idempotentReplay).toBe(false);
  });

  it('rethrows an infra/validation error (errorCode present) so the saga can retry', async () => {
    const { fetch } = makeFetch(() =>
      res(200, { errorCode: '4025', errorName: 'Invalid Credentials', errorMessage: 'The credentials supplied are invalid' }),
    );
    const adapter = new ElavonAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow(/credentials/i);
  });

  it('rethrows an HTTP transport error', async () => {
    const { fetch } = makeFetch(() => res(502, 'bad gateway'));
    const adapter = new ElavonAdapter({ ...baseCfg, fetch });
    await expect(adapter.attemptCharge(invoice, method, 'ax10m_charge_abc')).rejects.toThrow();
  });
});

describe('capabilities & unsupported surfaces', () => {
  it('advertises a DRIVE, webhook-less capability matrix', () => {
    const adapter = new ElavonAdapter(baseCfg);
    const caps = adapter.capabilities();
    expect(caps.integrationMode).toBe('drive');
    expect(caps.externalRetryControl).toBe(true);
    expect(caps.webhooks).toBe(false);
    expect(caps.listPaymentMethods).toBe(false);
  });

  it('fails closed on ingestWebhook and returns empty reconciliation', async () => {
    const adapter = new ElavonAdapter(baseCfg);
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
