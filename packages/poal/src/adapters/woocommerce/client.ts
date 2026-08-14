/**
 * Minimal WooCommerce REST API v3 client.
 *
 * NOTE (co-drive): AX10M does NOT hold the card. This client only TRIGGERS a
 * renewal / payment retry against a WooCommerce store; the store's configured
 * gateway plugin (WooCommerce Payments / Stripe / etc.) performs the ACTUAL charge.
 * Endpoint paths and field names are modeled on the documented WC REST v3 API and
 * the WooCommerce Subscriptions extension, and MUST be confirmed against the store's
 * installed versions — the MECHANISM (fail-closed HMAC verify, idempotency-key
 * pass-through, pending-vs-failed, token-only) is the deliverable.
 *
 * Auth is HTTP Basic over HTTPS: base64(consumerKey:consumerSecret). Bodies and
 * responses are JSON.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live WooCommerce store. No dependency on the DOM `lib`: we declare the tiny slice
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

export interface WooErrorBody {
  code?: string;
  message?: string;
  data?: { status?: number };
}

/** A structured WooCommerce REST error. Any non-2xx is infra/auth/validation — NOT a decline. */
export class WooError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: WooErrorBody,
    readonly raw: string,
  ) {
    super(body.message ?? `WooCommerce error ${httpStatus}`);
    this.name = 'WooError';
  }
}

export interface WooClientConfig {
  /** Store base, e.g. https://shop.example.com. */
  storeUrl: string;
  /** REST API consumer key (Basic-auth username). Injected, never hardcoded. */
  consumerKey: string;
  /** REST API consumer secret (Basic-auth password). Injected, never hardcoded. */
  consumerSecret: string;
  /** Injectable transport (defaults to global fetch). */
  fetch?: FetchLike;
  /** Override base URL (tests / regions). Defaults to {storeUrl}/wp-json/wc/v3. */
  baseUrl?: string;
}

type Query = Record<string, string | number | undefined>;

export class WooClient {
  constructor(private readonly cfg: WooClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? `${this.cfg.storeUrl.replace(/\/+$/, '')}/wp-json/wc/v3`;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString('base64')}`;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('WooClient: no fetch implementation available');
    return f;
  }

  async get(path: string, query: Query = {}): Promise<unknown> {
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

  async post(path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.transport()(`${this.base()}${path}`, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return this.parse(res);
  }

  private async parse(res: FetchResponseLike): Promise<unknown> {
    const raw = await res.text();
    if (!res.ok) {
      let parsed: WooErrorBody = {};
      try {
        parsed = raw ? (JSON.parse(raw) as WooErrorBody) : {};
      } catch {
        parsed = { message: raw };
      }
      throw new WooError(res.status, parsed, raw);
    }
    return raw ? JSON.parse(raw) : {};
  }
}
