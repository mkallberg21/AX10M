/**
 * Minimal Maxio Advanced Billing (Chargify) REST client.
 *
 * Chargify auth is HTTP Basic with the API key as the username and the literal `x`
 * as the password (base64(`${apiKey}:x`)). Request/response bodies are JSON.
 * Idempotency rides on the `Idempotency-Key` request header so a retry after a crash
 * or partition de-dupes rather than double-charging.
 *
 * A failed retry / charge surfaces as a 422 whose body carries an `errors` array (a
 * gateway/payment rejection) — that is a payment FAILURE (an expected outcome), not
 * an infra/auth error. Everything else (401/403/404/5xx) is a genuine error the saga
 * must retry.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live Chargify site. No dependency on the DOM `lib`: we declare the tiny slice of
 * the fetch contract we use.
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

export interface MaxioErrorBody {
  /** Chargify returns validation / payment errors as a flat string array. */
  errors?: string[];
  error?: string;
}

/** A structured Maxio/Chargify API error. A 422 with `errors` is a payment failure. */
export class MaxioError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: MaxioErrorBody,
    readonly raw: string,
  ) {
    super(body.errors?.[0] ?? body.error ?? `Maxio error ${httpStatus}`);
    this.name = 'MaxioError';
  }

  /** True when Chargify rejected the charge at the payment layer (a decline), not an infra/auth error. */
  isPaymentFailure(): boolean {
    return this.httpStatus === 422 && ((this.body.errors?.length ?? 0) > 0 || Boolean(this.body.error));
  }

  /** The first error string, fed to the decline mapper. */
  declineReason(): string | undefined {
    return this.body.errors?.[0] ?? this.body.error;
  }
}

export interface MaxioClientConfig {
  /** Chargify API key (Basic-auth username, password `x`). Injected, never hardcoded. */
  apiKey: string;
  /** Chargify subdomain: <subdomain>.chargify.com. */
  subdomain: string;
  /** Injectable transport (defaults to global fetch). */
  fetch?: FetchLike;
  /** Override base URL (tests / regions). Defaults to https://{subdomain}.chargify.com. */
  baseUrl?: string;
}

export interface PostResult {
  body: Record<string, unknown>;
  status: number;
  /** True when Chargify returned a prior result for the same Idempotency-Key. */
  idempotentReplay: boolean;
}

type Query = Record<string, string | number | undefined>;

export class MaxioClient {
  constructor(private readonly cfg: MaxioClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? `https://${this.cfg.subdomain}.chargify.com`;
  }

  private authHeader(): string {
    // API key is the Basic-auth username; the password is the literal `x`.
    return `Basic ${Buffer.from(`${this.cfg.apiKey}:x`).toString('base64')}`;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('MaxioClient: no fetch implementation available');
    return f;
  }

  async get(path: string, query: Query = {}): Promise<Record<string, unknown>> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const res = await this.transport()(`${this.base()}${path}${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: { Authorization: this.authHeader(), Accept: 'application/json' },
    });
    return this.parse(res);
  }

  async post(path: string, body: unknown, idempotencyKey?: string): Promise<PostResult> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await this.transport()(`${this.base()}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
    const idempotentReplay = res.headers.get('idempotent-replayed') === 'true';
    return { body: await this.parse(res), status: res.status, idempotentReplay };
  }

  private async parse(res: FetchResponseLike): Promise<Record<string, unknown>> {
    const raw = await res.text();
    if (!res.ok) {
      let parsed: MaxioErrorBody = {};
      try {
        parsed = raw ? (JSON.parse(raw) as MaxioErrorBody) : {};
      } catch {
        parsed = { error: raw };
      }
      throw new MaxioError(res.status, parsed, raw);
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
}
