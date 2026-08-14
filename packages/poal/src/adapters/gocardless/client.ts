/**
 * Minimal GoCardless API client (bank debit: ACH / SEPA / BACS / …).
 *
 * Auth is a Bearer access token + the `GoCardless-Version` header; bodies are JSON.
 * GoCardless supports an `Idempotency-Key` on creates; a replay surfaces as a 409
 * with an `idempotent_creation_conflict` error, which we detect for exactly-once.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live GoCardless account.
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

export interface GoCardlessErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    errors?: Array<{ reason?: string; message?: string; links?: Record<string, string> }>;
  };
}

export class GoCardlessError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: GoCardlessErrorBody,
    readonly raw: string,
  ) {
    super(body.error?.message ?? `GoCardless error ${httpStatus}`);
    this.name = 'GoCardlessError';
  }

  /**
   * True only for a genuine idempotency replay — a request with a reused
   * Idempotency-Key that hit an existing resource. We check the specific error
   * reason, NOT the bare 409 status, because GoCardless also returns 409 for
   * other conflicts (e.g. a payment no longer in a retriable state) that must be
   * surfaced, not silently swallowed as a replay.
   */
  isIdempotentConflict(): boolean {
    return (this.body.error?.errors ?? []).some((e) => e.reason === 'idempotent_creation_conflict');
  }
}

export interface GoCardlessClientConfig {
  accessToken: string;
  environment?: 'sandbox' | 'live';
  baseUrl?: string;
  fetch?: FetchLike;
}

const LIVE = 'https://api.gocardless.com';
const SANDBOX = 'https://api-sandbox.gocardless.com';

type Query = Record<string, string | number | undefined>;

export class GoCardlessClient {
  constructor(private readonly cfg: GoCardlessClientConfig) {}

  private base(): string {
    if (this.cfg.baseUrl) return this.cfg.baseUrl;
    return this.cfg.environment === 'live' ? LIVE : SANDBOX;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.accessToken}`,
      'GoCardless-Version': '2015-07-06',
      Accept: 'application/json',
    };
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('GoCardlessClient: no fetch implementation available');
    return f;
  }

  async get(path: string, query: Query = {}): Promise<Record<string, unknown>> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const res = await this.transport()(`${this.base()}${path}${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: this.headers(),
    });
    return this.parse(res);
  }

  async post(path: string, body?: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const headers = { ...this.headers() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await this.transport()(`${this.base()}${path}`, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return this.parse(res);
  }

  private async parse(res: FetchResponseLike): Promise<Record<string, unknown>> {
    const raw = await res.text();
    if (!res.ok) {
      let parsed: GoCardlessErrorBody = {};
      try {
        parsed = raw ? (JSON.parse(raw) as GoCardlessErrorBody) : {};
      } catch {
        parsed = { error: { message: raw } };
      }
      throw new GoCardlessError(res.status, parsed, raw);
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
}
