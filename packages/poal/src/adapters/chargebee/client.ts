/**
 * Minimal Chargebee REST v2 client.
 *
 * Chargebee auth is HTTP Basic (API key as the username, empty password). Request
 * bodies are form-encoded; responses are JSON. Idempotency is via the
 * `chargebee-idempotency-key` request header; on a replay Chargebee echoes
 * `chargebee-idempotency-replayed: true`, which is how we detect an idempotent
 * replay for exactly-once charging.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live Chargebee site. No dependency on the DOM `lib`: we declare the tiny slice
 * of the fetch contract we use.
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

/** A structured Chargebee API error. `payment`-type errors mean the charge itself failed. */
export class ChargebeeError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: ChargebeeErrorBody,
    readonly raw: string,
  ) {
    super(body.message ?? `Chargebee error ${httpStatus}`);
    this.name = 'ChargebeeError';
  }

  /** True when Chargebee rejected the charge at the payment layer (a decline), not an infra/auth error. */
  isPaymentFailure(): boolean {
    return (
      this.body.type === 'payment' ||
      this.body.api_error_code === 'payment_processing_failed' ||
      this.body.api_error_code === 'payment_method_not_present'
    );
  }
}

export interface ChargebeeErrorBody {
  message?: string;
  type?: string; // 'payment' | 'invalid_request' | 'operation_failed' | 'io_error' | ...
  api_error_code?: string;
  error_code?: string; // gateway decline code
  error_msg?: string;
  param?: string;
  http_status_code?: number;
}

export interface ChargebeeClientConfig {
  site: string;
  apiKey: string;
  /** Injectable transport (defaults to global fetch). */
  fetch?: FetchLike;
  /** Override base URL (tests / regional endpoints). Defaults to https://{site}.chargebee.com/api/v2. */
  baseUrl?: string;
}

export interface PostResult {
  body: Record<string, unknown>;
  /** True when Chargebee returned a prior result for the same idempotency key. */
  idempotentReplay: boolean;
}

type Params = Record<string, string | number | undefined>;

export class ChargebeeClient {
  constructor(private readonly cfg: ChargebeeClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? `https://${this.cfg.site}.chargebee.com/api/v2`;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.apiKey}:`).toString('base64')}`;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('ChargebeeClient: no fetch implementation available');
    return f;
  }

  private static encode(params: Params): string {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
  }

  async get(path: string, query: Params = {}): Promise<Record<string, unknown>> {
    const qs = ChargebeeClient.encode(query);
    const url = `${this.base()}${path}${qs ? `?${qs}` : ''}`;
    const res = await this.transport()(url, {
      method: 'GET',
      headers: { Authorization: this.authHeader() },
    });
    return this.parse(res);
  }

  async post(path: string, params: Params = {}, idempotencyKey?: string): Promise<PostResult> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (idempotencyKey) headers['chargebee-idempotency-key'] = idempotencyKey;
    const res = await this.transport()(`${this.base()}${path}`, {
      method: 'POST',
      headers,
      body: ChargebeeClient.encode(params),
    });
    const idempotentReplay = res.headers.get('chargebee-idempotency-replayed') === 'true';
    const body = await this.parse(res);
    return { body, idempotentReplay };
  }

  private async parse(res: FetchResponseLike): Promise<Record<string, unknown>> {
    const raw = await res.text();
    if (!res.ok) {
      let parsed: ChargebeeErrorBody = {};
      try {
        parsed = raw ? (JSON.parse(raw) as ChargebeeErrorBody) : {};
      } catch {
        parsed = { message: raw };
      }
      throw new ChargebeeError(res.status, parsed, raw);
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
}
