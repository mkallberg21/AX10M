/**
 * Minimal Recurly v3 REST client.
 *
 * Recurly auth is HTTP Basic with the API key as the username and an EMPTY password
 * (base64(`${apiKey}:`)). The API is versioned via an `Accept` header
 * (`application/vnd.recurly.v2021-02-25`). Request/response bodies are JSON.
 * Idempotency rides on the `Idempotency-Key` request header so a retry after a crash
 * or partition de-dupes into a replay rather than a second collection.
 *
 * A failed collection surfaces as a 422 whose body carries a `transaction_error`
 * (an issuer decline) — that is a payment FAILURE (an expected outcome), not an
 * infra/auth error. Everything else (401/403/404/5xx) is a genuine error the saga
 * must retry.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live Recurly site. No dependency on the DOM `lib`: we declare the tiny slice of
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

/** The nested transaction error Recurly returns on a declined collection. */
export interface RecurlyTransactionError {
  object?: string;
  transaction_id?: string;
  category?: string; // 'soft' | 'hard' | 'fraud' | ...
  code?: string; // canonical-ish decline code, e.g. 'insufficient_funds'
  decline_code?: string; // raw gateway decline code
  message?: string;
  merchant_advice?: string;
}

/** The `error` envelope Recurly returns on a 4xx/5xx. */
export interface RecurlyErrorBody {
  type?: string; // 'transaction' | 'validation' | 'not_found' | 'unauthorized' | ...
  message?: string;
  params?: Array<Record<string, unknown>>;
  transaction_error?: RecurlyTransactionError;
}

/** A structured Recurly API error. A 422 with a `transaction_error` is a decline. */
export class RecurlyError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: RecurlyErrorBody,
    readonly raw: string,
  ) {
    super(body.message ?? `Recurly error ${httpStatus}`);
    this.name = 'RecurlyError';
  }

  /** True when Recurly rejected the charge at the payment layer (a decline), not an infra/auth error. */
  isPaymentFailure(): boolean {
    return this.httpStatus === 422 && (this.body.type === 'transaction' || Boolean(this.body.transaction_error));
  }

  /** The gateway decline code, fed to the decline mapper. */
  declineReason(): string | undefined {
    return this.body.transaction_error?.code ?? this.body.transaction_error?.decline_code;
  }
}

export interface RecurlyClientConfig {
  /** API key — Basic-auth username, empty password. Injected, never hardcoded. */
  apiKey: string;
  /** Injectable transport (defaults to global fetch). */
  fetch?: FetchLike;
  /** Override base URL (tests / regional endpoints). Defaults to https://v3.recurly.com. */
  baseUrl?: string;
  /** API version pinned via the Accept header. */
  apiVersion?: string;
}

export interface WriteResult {
  body: Record<string, unknown>;
  /** True when Recurly returned a prior result for the same Idempotency-Key. */
  idempotentReplay: boolean;
}

type Params = Record<string, string | number | undefined>;

const DEFAULT_BASE = 'https://v3.recurly.com';
const DEFAULT_API_VERSION = 'application/vnd.recurly.v2021-02-25';

export class RecurlyClient {
  constructor(private readonly cfg: RecurlyClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? DEFAULT_BASE;
  }

  private authHeader(): string {
    // API key is the Basic-auth username; the password is empty.
    return `Basic ${Buffer.from(`${this.cfg.apiKey}:`).toString('base64')}`;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('RecurlyClient: no fetch implementation available');
    return f;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: this.authHeader(),
      Accept: this.cfg.apiVersion ?? DEFAULT_API_VERSION,
      ...extra,
    };
  }

  private static encode(params: Params): string {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
  }

  async get(path: string, query: Params = {}): Promise<Record<string, unknown>> {
    const qs = RecurlyClient.encode(query);
    const url = `${this.base()}${path}${qs ? `?${qs}` : ''}`;
    const res = await this.transport()(url, { method: 'GET', headers: this.headers() });
    return this.parse(res);
  }

  async put(path: string, body: unknown, idempotencyKey?: string): Promise<WriteResult> {
    return this.write('PUT', path, body, idempotencyKey);
  }

  async post(path: string, body: unknown, idempotencyKey?: string): Promise<WriteResult> {
    return this.write('POST', path, body, idempotencyKey);
  }

  private async write(method: string, path: string, body: unknown, idempotencyKey?: string): Promise<WriteResult> {
    const extra: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey) extra['Idempotency-Key'] = idempotencyKey;
    const res = await this.transport()(`${this.base()}${path}`, {
      method,
      headers: this.headers(extra),
      body: JSON.stringify(body ?? {}),
    });
    // Recurly does not document a canonical "replayed" header; we check a plausible one
    // (best-effort). Server-side idempotency prevents a double charge regardless.
    const idempotentReplay = res.headers.get('recurly-idempotent-replayed') === 'true';
    return { body: await this.parse(res), idempotentReplay };
  }

  private async parse(res: FetchResponseLike): Promise<Record<string, unknown>> {
    const raw = await res.text();
    if (!res.ok) {
      let parsed: RecurlyErrorBody = {};
      try {
        // Recurly wraps errors as `{ "error": { ... } }`.
        const json = raw ? (JSON.parse(raw) as { error?: RecurlyErrorBody }) : {};
        parsed = json.error ?? (json as RecurlyErrorBody);
      } catch {
        parsed = { message: raw };
      }
      throw new RecurlyError(res.status, parsed, raw);
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
}
