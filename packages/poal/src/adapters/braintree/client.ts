/**
 * Minimal Braintree gateway client (classic XML API).
 *
 * Braintree auth is HTTP Basic (publicKey:privateKey); request/response bodies are
 * XML. Unlike a JSON gateway, a processor decline comes back as HTTP 422 with an
 * `<api-error-response>` that still contains the declined `<transaction>` — so this
 * client does NOT throw on HTTP status. It returns { status, ok, xml } and lets the
 * adapter decide (a 422-with-transaction is a decline; a 422-without / 401 / 5xx is
 * a real error the adapter raises). It throws only when the transport is missing.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live Braintree gateway.
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

/** A Braintree error the adapter raises for non-decline failures (auth/validation/infra). */
export class BraintreeError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'BraintreeError';
  }
}

export interface BraintreeClientConfig {
  publicKey: string;
  privateKey: string;
  environment?: 'sandbox' | 'production';
  /** Override base URL (tests). */
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface RawResponse {
  status: number;
  ok: boolean;
  xml: string;
}

const SANDBOX = 'https://api.sandbox.braintreegateway.com';
const PRODUCTION = 'https://api.braintreegateway.com';

export class BraintreeClient {
  constructor(private readonly cfg: BraintreeClientConfig) {}

  private base(): string {
    if (this.cfg.baseUrl) return this.cfg.baseUrl;
    return this.cfg.environment === 'production' ? PRODUCTION : SANDBOX;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.publicKey}:${this.cfg.privateKey}`).toString('base64')}`;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('BraintreeClient: no fetch implementation available');
    return f;
  }

  async request(method: 'GET' | 'POST' | 'PUT', path: string, xmlBody?: string): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: 'application/xml',
      'X-ApiVersion': '6',
    };
    if (xmlBody !== undefined) headers['Content-Type'] = 'application/xml';
    const res = await this.transport()(`${this.base()}${path}`, { method, headers, body: xmlBody });
    return { status: res.status, ok: res.ok, xml: await res.text() };
  }
}
