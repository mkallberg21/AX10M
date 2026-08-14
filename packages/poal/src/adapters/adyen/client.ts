/**
 * Minimal Adyen Checkout API client.
 *
 * Adyen auth is the `X-API-Key` header; request/response bodies are JSON.
 * Idempotency is via the `Idempotency-Key` request header — Adyen dedupes
 * server-side, so a retried charge with the same key never double-charges.
 *
 * IMPORTANT: a *declined* payment is an HTTP 200 with `resultCode: "Refused"`
 * (not an HTTP error). Only genuine 4xx/5xx (auth, validation, infra) throw.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live Adyen account.
 */

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export interface AdyenErrorBody {
  status?: number;
  errorCode?: string;
  message?: string;
  errorType?: string;
  pspReference?: string;
}

export class AdyenError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: AdyenErrorBody,
    readonly raw: string,
  ) {
    super(body.message ?? `Adyen error ${httpStatus}`);
    this.name = 'AdyenError';
  }
}

export interface AdyenClientConfig {
  apiKey: string;
  /**
   * Checkout API base URL. Test defaults to https://checkout-test.adyen.com/v71.
   * Live is a per-merchant prefix (…-checkout-live.adyenpayments.com/checkout/v71).
   */
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface PostResult {
  body: Record<string, unknown>;
  idempotentReplay: boolean;
}

const DEFAULT_BASE = 'https://checkout-test.adyen.com/v71';

export class AdyenClient {
  constructor(private readonly cfg: AdyenClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? DEFAULT_BASE;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('AdyenClient: no fetch implementation available');
    return f;
  }

  async post(path: string, body: unknown, idempotencyKey?: string): Promise<PostResult> {
    const headers: Record<string, string> = {
      'X-API-Key': this.cfg.apiKey,
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await this.transport()(`${this.base()}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    // Adyen has no explicit "replayed" header; server-side idempotency prevents a
    // double charge regardless, so we report false unless a future signal exists.
    const idempotentReplay = res.headers.get('idempotency-replayed') === 'true';
    return { body: await this.parse(res), idempotentReplay };
  }

  async get(path: string, query: Record<string, string | number | undefined> = {}): Promise<Record<string, unknown>> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const res = await this.transport()(`${this.base()}${path}${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: { 'X-API-Key': this.cfg.apiKey },
    });
    return this.parse(res);
  }

  private async parse(res: FetchResponseLike): Promise<Record<string, unknown>> {
    const raw = await res.text();
    if (!res.ok) {
      let parsed: AdyenErrorBody = {};
      try {
        parsed = raw ? (JSON.parse(raw) as AdyenErrorBody) : {};
      } catch {
        parsed = { message: raw };
      }
      throw new AdyenError(res.status, parsed, raw);
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
}
