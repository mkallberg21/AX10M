/**
 * Demo ledger seed — DETERMINISTIC synthetic recovery events, so the live P&L dashboard can be
 * seen populated before real charging produces a real ledger.
 *
 * HONEST + SAFE:
 *  - Every event is marked `demo: true` and uses `demo_*` ids — it is unmistakably synthetic,
 *    never presented as real revenue.
 *  - Pure + seeded (mulberry32, no Math.random) → reproducible; no clock/IO of its own.
 *  - Append-only: the ledger is immutable, so seeded events CANNOT be removed. Only run this
 *    against a disposable/dev ledger. The endpoint that appends it is env-flag-gated (off by
 *    default) so it can never fire in production.
 */

import type { LedgerAppendInput } from '../recovery/ledger-port.js';

const DAY_MS = 86_400_000;

/** Relative recovery volume per merchant-of-record (shapes the per-MoR breakdown). */
const PROCESSORS: Array<{ id: string; weight: number }> = [
  { id: 'stripe', weight: 1.6 },
  { id: 'adyen', weight: 1.0 },
  { id: 'braintree', weight: 0.6 },
  { id: 'paypal', weight: 0.5 },
  { id: 'checkout', weight: 0.4 },
];

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoSeedOptions {
  nowIso: string;
  days?: number; // window length (default 45)
  seed?: number; // PRNG seed (default 42)
  merchantId?: string; // default 'demo_merchant'
  currency?: string; // default 'USD'
}

/**
 * Build a deterministic set of synthetic ledger events (case.recovered + charge.* + comms.sent)
 * spread across the last `days`, per processor, with a gentle upward trend so the period-over-
 * period deltas read as growth. Returns them in occurredAt order.
 */
export function buildDemoLedgerEvents(opts: DemoSeedOptions): LedgerAppendInput[] {
  const days = opts.days ?? 45;
  const currency = opts.currency ?? 'USD';
  const merchantId = opts.merchantId ?? 'demo_merchant';
  const rand = mulberry32(opts.seed ?? 42);
  const nowMs = Date.parse(opts.nowIso);
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;

  const events: LedgerAppendInput[] = [];
  let n = 0;

  for (let d = 0; d < days; d++) {
    // d = 0 is the oldest day, d = days-1 is today. Trend ramps volume toward recent days.
    const dayStart = todayStart - (days - 1 - d) * DAY_MS;
    const trend = 0.55 + 0.9 * (d / Math.max(1, days - 1)); // ~0.55 → ~1.45
    for (const proc of PROCESSORS) {
      const count = Math.round(proc.weight * trend * (1.4 + 1.6 * rand())); // recoveries this day
      for (let i = 0; i < count; i++) {
        // Event time within the day (capped at now for today so nothing is in the future).
        const at = Math.min(nowMs, dayStart + Math.floor(rand() * DAY_MS));
        const occurredAt = new Date(at).toISOString();
        const amount = 1_500 + Math.floor(rand() * 23_500); // $15–$250 in minor units
        const invoiceId = `demo_inv_${n++}`;
        const attemptNumber = 1 + Math.floor(rand() * 3);

        // A minority of recoveries had a failed attempt / dunning comm first — adds MoR activity.
        if (rand() < 0.35) {
          events.push({ merchantId, type: 'charge.failed', occurredAt, detail: { invoiceId, processor: proc.id, demo: true, outcome: 'failed' } });
        }
        if (rand() < 0.2) {
          events.push({ merchantId, type: 'comms.sent', occurredAt, detail: { invoiceId, processor: proc.id, demo: true, reason: 'card_update_comms' } });
        }
        events.push({ merchantId, type: 'charge.succeeded', occurredAt, detail: { invoiceId, processor: proc.id, demo: true, outcome: 'succeeded' } });
        events.push({ merchantId, type: 'case.recovered', occurredAt, detail: { invoiceId, processor: proc.id, demo: true, amount, currency, attemptNumber } });

        // ~5% of recovered payments later reverse (refund or chargeback) → net-recovery clawback.
        if (rand() < 0.05) {
          const reversedAt = Math.min(nowMs, at + Math.floor((1 + rand() * 5) * DAY_MS)); // days later, never future
          const full = rand() < 0.6;
          const revAmount = full ? amount : Math.max(100, Math.floor(amount * (0.3 + rand() * 0.4)));
          events.push({
            merchantId,
            type: 'case.reversed',
            occurredAt: new Date(reversedAt).toISOString(),
            detail: { invoiceId, processor: proc.id, demo: true, amount: revAmount, currency, kind: rand() < 0.5 ? 'chargeback' : 'refund' },
          });
        }
      }
    }
  }

  events.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return events;
}
