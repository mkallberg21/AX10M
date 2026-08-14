/**
 * Minimal PayPal REST client (Orders v2 + OAuth2 + webhook verification).
 *
 * NOTE: the endpoint paths and JSON field names below are modeled on PayPal's
 * documented REST API and MUST be re-confirmed against the live API version — treat
 * them as the plausible shape, not gospel. The load-bearing MECHANISM is what this
 * file actually delivers and is real: OAuth2 client-credentials → cached Bearer
 * token, idempotency via the `PayPal-Request-Id` request header, a genuine
 * fail-closed `verify-webhook-signature` API call, token-only (never a PAN → SAQ-A),
 * and the decline-vs-error split (an issuer decline is an expected OUTCOME, an
 * infra/auth failure THROWS).
 *
 * PayPal auth is OAuth2: POST /v1/oauth2/token with HTTP Basic base64(clientId:
 * clientSecret) and `grant_type=client_credentials` yields a Bearer token, which we
 * cache in-memory (a stored field — no wall-clock expiry logic; a 401 on a stale
 * token is an infra error the saga retries). Request/response bodies are JSON.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live PayPal account. No dependency on the DOM `lib`: we declare the tiny slice of
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

/** A single issue inside a PayPal error `details` array. */
export interface PayPalErrorDetail {
  issue?: string; // e.g. 'INSTRUMENT_DECLINED', 'INSUFFICIENT_FUNDS'
  description?: string;
}

export interface PayPalErrorBody {
  name?: string; // e.g. 'UNPROCESSABLE_ENTITY', 'INVALID_REQUEST', 'AUTHENTICATION_FAILURE'
  message?: string;
  details?: PayPalErrorDetail[];
  debug_id?: string;
}

/** Issue names PayPal returns when the ISSUER (not our request) declined the charge. */
const PAYMENT_DECLINE_ISSUES: ReadonlySet<string> = new Set([
  'INSTRUMENT_DECLINED',
  'PAYER_ACTION_REQUIRED',
  'TRANSACTION_REFUSED',
  'INSUFFICIENT_FUNDS',
  'CARD_CLOSED',
  'CARD_EXPIRED',
]);

/**
 * A structured PayPal API error. A `422 UNPROCESSABLE_ENTITY` whose issue is an
 * issuer decline is a payment failure (a decline); everything else — 401/403 auth,
 * 400 validation, 5xx infra — is a genuine error the saga must retry.
 */
export class PayPalError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: PayPalErrorBody,
    readonly raw: string,
  ) {
    super(body.message ?? body.name ?? `PayPal error ${httpStatus}`);
    this.name = 'PayPalError';
  }

  /** True when PayPal rejected the charge at the issuer layer (a decline), not an infra/auth error. */
  isPaymentFailure(): boolean {
    if (this.httpStatus !== 422) return false;
    const issues = (this.body.details ?? []).map((d) => (d.issue ?? '').toUpperCase());
    return issues.some(
      (i) => PAYMENT_DECLINE_ISSUES.has(i) || i.includes('DECLINED') || i.includes('REFUSED'),
    );
  }

  /** The first issuer/PayPal issue string, fed to the decline mapper. */
  declineReason(): string | undefined {
    return this.body.details?.find((d) => d.issue)?.issue ?? this.body.name;
  }
}

export interface PayPalClientConfig {
  clientId: string;
  clientSecret: string;
  /** Injectable transport (defaults to global fetch). */
  fetch?: FetchLike;
  /** Override base URL. Live https://api-m.paypal.com; sandbox https://api-m.sandbox.paypal.com. */
  baseUrl?: string;
}

export interface PostResult {
  body: Record<string, unknown>;
  status: number;
  /** True when PayPal returned a prior result for the same `PayPal-Request-Id`. */
  idempotentReplay: boolean;
}

const DEFAULT_BASE = 'https://api-m.paypal.com';

export class PayPalClient {
  /** In-memory cached Bearer token (see file NOTE on expiry handling). */
  private accessToken?: string;

  constructor(private readonly cfg: PayPalClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? DEFAULT_BASE;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('PayPalClient: no fetch implementation available');
    return f;
  }

  /**
   * Obtain (and cache) an OAuth2 client-credentials Bearer token. Injectable via the
   * transport so tests can fake the token endpoint. Cached in `accessToken`: the
   * first call fetches, subsequent calls reuse. A token expiring server-side surfaces
   * as a 401 on the next request — an infra error the saga retries.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await this.transport()(`${this.base()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await this.parse(res);
    const token = body.access_token;
    if (typeof token !== 'string' || !token) {
      throw new Error('PayPalClient: OAuth token response missing access_token');
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
    // Idempotency: the deterministic charge key rides on PayPal-Request-Id so a retry
    // after a crash/partition de-dupes into a replay rather than a second charge.
    if (idempotencyKey) headers['PayPal-Request-Id'] = idempotencyKey;
    const res = await this.transport()(`${this.base()}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
    // PayPal has no widely-documented "replayed" header; server-side idempotency
    // prevents a double charge regardless, so we report false unless a future signal
    // appears on this header.
    const idempotentReplay = res.headers.get('paypal-request-id-replayed') === 'true';
    return { body: await this.parse(res), status: res.status, idempotentReplay };
  }

  async get(path: string, query: Record<string, string | number | undefined> = {}): Promise<Record<string, unknown>> {
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
      let parsed: PayPalErrorBody = {};
      try {
        parsed = raw ? (JSON.parse(raw) as PayPalErrorBody) : {};
      } catch {
        parsed = { message: raw };
      }
      throw new PayPalError(res.status, parsed, raw);
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
}

// ── Webhook verification (fail-closed, via the injectable transport) ──────────────

export interface WebhookVerifyInput {
  /** Inbound webhook HTTP headers (PayPal transmission-* headers live here). */
  headers: Record<string, string>;
  /** The webhook id registered in the PayPal dashboard (config.webhookId). */
  webhookId: string;
  /** The RAW request body string — parsed and echoed back as `webhook_event`. */
  eventBody: string;
}

/**
 * Verify a PayPal webhook by calling the real
 * POST /v1/notifications/verify-webhook-signature API through the injectable
 * transport (so tests can fake it). PayPal signature verification is an API call,
 * not a local HMAC — we forward the transmission headers + webhook_id + event body
 * and trust the event ONLY when `verification_status === 'SUCCESS'`.
 *
 * Returns true/false; the adapter is responsible for failing closed (throwing) on
 * false and on an unconfigured webhookId.
 */
export async function verifyPaypalWebhookSignature(
  client: PayPalClient,
  input: WebhookVerifyInput,
): Promise<boolean> {
  const h = (name: string): string => headerLookup(input.headers, name) ?? '';
  const payload = {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: input.webhookId,
    webhook_event: JSON.parse(input.eventBody) as unknown,
  };
  const { body } = await client.post('/v1/notifications/verify-webhook-signature', payload);
  return body.verification_status === 'SUCCESS';
}

/** Case-insensitive header lookup (webhook header casing varies by proxy). */
export function headerLookup(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
