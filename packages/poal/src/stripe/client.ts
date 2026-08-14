/**
 * Minimal Stripe REST client.
 *
 * Auth is a Bearer secret key; request bodies are form-encoded (Stripe's bracket
 * notation for nested params). Idempotency is via the `Idempotency-Key` header —
 * Stripe dedupes server-side so a retried charge never double-charges. A card
 * DECLINE comes back as HTTP 402 with `error.type: 'card_error'` (an expected
 * outcome, not an infra error); the adapter branches on that. The transport
 * (`fetch`) is injectable for unit testing.
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

export interface StripeErrorBody {
  error?: {
    type?: string; // card_error | invalid_request_error | api_error | authentication_error | ...
    code?: string;
    decline_code?: string;
    message?: string;
    param?: string;
  };
}

export class StripeError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: StripeErrorBody,
    readonly raw: string,
  ) {
    super(body.error?.message ?? `Stripe error ${httpStatus}`);
    this.name = 'StripeError';
  }

  /** True when Stripe declined the card (an expected outcome, not an infra error). */
  isCardError(): boolean {
    return this.body.error?.type === 'card_error';
  }
}

export interface StripeClientConfig {
  secretKey: string;
  apiVersion?: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface PostResult {
  body: Record<string, unknown>;
  idempotentReplay: boolean;
}

const DEFAULT_BASE = 'https://api.stripe.com/v1';

type FormValue = string | number | boolean | undefined;

export class StripeClient {
  constructor(private readonly cfg: StripeClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? DEFAULT_BASE;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.cfg.secretKey}`, ...extra };
    if (this.cfg.apiVersion) h['Stripe-Version'] = this.cfg.apiVersion;
    return h;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('StripeClient: no fetch implementation available');
    return f;
  }

  private static encode(params: Record<string, FormValue>): string {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
  }

  async get(path: string, query: Record<string, FormValue> = {}): Promise<Record<string, unknown>> {
    const qs = StripeClient.encode(query);
    const res = await this.transport()(`${this.base()}${path}${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: this.headers(),
    });
    return this.parse(res);
  }

  async post(path: string, params: Record<string, FormValue> = {}, idempotencyKey?: string): Promise<PostResult> {
    const headers = this.headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await this.transport()(`${this.base()}${path}`, {
      method: 'POST',
      headers,
      body: StripeClient.encode(params),
    });
    const idempotentReplay = res.headers.get('idempotent-replayed') === 'true';
    return { body: await this.parse(res), idempotentReplay };
  }

  private async parse(res: FetchResponseLike): Promise<Record<string, unknown>> {
    const raw = await res.text();
    if (!res.ok) {
      let parsed: StripeErrorBody = {};
      try {
        parsed = raw ? (JSON.parse(raw) as StripeErrorBody) : {};
      } catch {
        parsed = { error: { message: raw } };
      }
      throw new StripeError(res.status, parsed, raw);
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
}
