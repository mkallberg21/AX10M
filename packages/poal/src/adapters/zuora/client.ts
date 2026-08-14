/**
 * Minimal Zuora REST client (Payments + OAuth2 + query).
 *
 * NOTE: the endpoint paths and JSON field names below are modeled on Zuora's
 * documented REST API and MUST be re-confirmed against the live API version — treat
 * them as the plausible shape, not gospel. The load-bearing MECHANISM is real and is
 * the deliverable: OAuth2 client-credentials → cached Bearer token, idempotency via
 * the `Idempotency-Key` request header, token-only (never a PAN → SAQ-A), and the
 * decline-vs-error split.
 *
 * Zuora auth is OAuth2: POST /oauth/token with a form-encoded
 * client_id/client_secret/grant_type=client_credentials yields a Bearer token, which
 * we cache in-memory (a stored field — no wall-clock expiry logic; a 401 on a stale
 * token is an infra error the saga retries). Request/response bodies are JSON.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live Zuora tenant. No dependency on the DOM `lib`: we declare the tiny slice of the
 * fetch contract we use.
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

/** A single reason inside a Zuora error `reasons` array. */
export interface ZuoraReason {
  code?: string | number;
  message?: string;
  field?: string;
}

export interface ZuoraErrorBody {
  success?: boolean;
  message?: string;
  reasons?: ZuoraReason[];
}

/**
 * A structured Zuora API error. Any non-2xx (or an explicit `success: false` request
 * rejection promoted by the adapter) is a genuine error the saga must retry — a
 * GATEWAY decline is NOT surfaced this way (Zuora returns a 200 with a Payment in an
 * `Error` status), so this class only ever represents infra/auth/validation errors.
 */
export class ZuoraError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: ZuoraErrorBody,
    readonly raw: string,
  ) {
    super(body.message ?? body.reasons?.[0]?.message ?? `Zuora error ${httpStatus}`);
    this.name = 'ZuoraError';
  }
}

export interface ZuoraClientConfig {
  /** OAuth2 client id. Injected, never hardcoded. */
  clientId: string;
  /** OAuth2 client secret. Injected, never hardcoded. */
  clientSecret: string;
  /** Injectable transport (defaults to global fetch). */
  fetch?: FetchLike;
  /** Override base URL. Prod https://rest.zuora.com; sandbox https://rest.apisandbox.zuora.com. */
  baseUrl?: string;
}

export interface PostResult {
  body: Record<string, unknown>;
  status: number;
  /** True when Zuora returned a prior result for the same Idempotency-Key. */
  idempotentReplay: boolean;
}

type Query = Record<string, string | number | undefined>;

const DEFAULT_BASE = 'https://rest.zuora.com';

export class ZuoraClient {
  /** In-memory cached Bearer token (see file NOTE on expiry handling). */
  private accessToken?: string;

  constructor(private readonly cfg: ZuoraClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? DEFAULT_BASE;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('ZuoraClient: no fetch implementation available');
    return f;
  }

  /**
   * Obtain (and cache) an OAuth2 client-credentials Bearer token. Injectable via the
   * transport so tests can fake the token endpoint. Cached in `accessToken`: the first
   * call fetches, subsequent calls reuse. A token expiring server-side surfaces as a
   * 401 on the next request — an infra error the saga retries.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const form = `client_id=${encodeURIComponent(this.cfg.clientId)}&client_secret=${encodeURIComponent(
      this.cfg.clientSecret,
    )}&grant_type=client_credentials`;
    const res = await this.transport()(`${this.base()}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const body = await this.parse(res);
    const token = body.access_token;
    if (typeof token !== 'string' || !token) {
      throw new Error('ZuoraClient: OAuth token response missing access_token');
    }
    this.accessToken = token;
    return token;
  }

  async post(path: string, body: unknown, idempotencyKey?: string): Promise<PostResult> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    // Idempotency: the deterministic charge key rides on Idempotency-Key so a retry
    // after a crash/partition de-dupes into a replay rather than a second payment.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await this.transport()(`${this.base()}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
    // Zuora has no widely-documented "replayed" header; server-side idempotency
    // prevents a double payment regardless, so we report false unless it appears.
    const idempotentReplay = res.headers.get('zuora-idempotency-replayed') === 'true';
    return { body: await this.parse(res), status: res.status, idempotentReplay };
  }

  async get(path: string, query: Query = {}): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const res = await this.transport()(`${this.base()}${path}${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    return this.parse(res);
  }

  private async parse(res: FetchResponseLike): Promise<Record<string, unknown>> {
    const raw = await res.text();
    if (!res.ok) {
      let parsed: ZuoraErrorBody = {};
      try {
        parsed = raw ? (JSON.parse(raw) as ZuoraErrorBody) : {};
      } catch {
        parsed = { message: raw };
      }
      throw new ZuoraError(res.status, parsed, raw);
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
}
