/**
 * Minimal Elavon Converge client.
 *
 * Converge is a single-endpoint, FORM-ENCODED gateway: every request POSTs
 * `application/x-www-form-urlencoded` fields to `.../process.do`. There is NO
 * Authorization header — the credentials travel IN the body as
 * `ssl_merchant_id` / `ssl_user_id` / `ssl_pin`. When `ssl_result_format=JSON`
 * is sent, Converge returns a JSON object; otherwise it returns pipe/XML text.
 * We always request JSON.
 *
 * Converge signals a card DECLINE in-band via `ssl_result` (a non-zero numeric)
 * in an otherwise-200 body — NOT via an error field. A present
 * `errorCode` / `errorMessage` is always an infra/validation error (bad
 * credentials, malformed request), which this client throws.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live Converge account. No dependency on the DOM `lib`: we declare the tiny slice
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

/** The JSON body Converge returns for a `process.do` call (only fields we read). */
export interface ConvergeResponse {
  /** '0' = approved; any other numeric string = declined by the issuer. */
  ssl_result?: string;
  ssl_result_message?: string;
  ssl_txn_id?: string;
  ssl_approval_code?: string;
  /** Present only on infra/validation failures (never on a plain card decline). */
  errorCode?: string;
  errorMessage?: string;
  errorName?: string;
  [k: string]: unknown;
}

/** A structured Converge API error. For Converge these are ALWAYS infra/validation, never a card decline. */
export class ElavonError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: ConvergeResponse,
    readonly raw: string,
  ) {
    super(body.errorMessage ?? body.errorName ?? `Elavon error ${httpStatus}`);
    this.name = 'ElavonError';
  }

  /**
   * Converge routes card declines IN-BAND via `ssl_result`, not through an error
   * field. An `errorCode`/`errorMessage` (what this error wraps) is therefore
   * always an infra/validation problem, never a payment decline — so this is
   * always false. Kept to mirror the shared adapter idiom (distinguish a decline
   * from a hard error via the client Error type).
   */
  isPaymentFailure(): boolean {
    return false;
  }
}

export interface ElavonClientConfig {
  /** Converge `ssl_merchant_id` (the processor account id — NOT the AX10M merchant id). */
  sslMerchantId: string;
  /** Converge `ssl_user_id`. */
  sslUserId: string;
  /** Converge `ssl_pin` (a long API secret; injected, never hardcoded). */
  sslPin: string;
  /** Injectable transport (defaults to global fetch). */
  fetch?: FetchLike;
  /**
   * Full endpoint URL. Defaults to production. For sandbox use
   * https://api.demo.convergepay.com/VirtualMerchantDemo/process.do.
   */
  baseUrl?: string;
}

type Params = Record<string, string | number | undefined>;

const DEFAULT_ENDPOINT = 'https://api.convergepay.com/VirtualMerchant/process.do';

export class ElavonClient {
  constructor(private readonly cfg: ElavonClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? DEFAULT_ENDPOINT;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('ElavonClient: no fetch implementation available');
    return f;
  }

  private static encode(params: Params): string {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
  }

  /**
   * POST a Converge transaction. Credentials + `ssl_result_format=JSON` are merged
   * into the body. Returns the parsed JSON (including a possible in-band
   * `ssl_result` decline); throws `ElavonError` on an HTTP error or a present
   * `errorCode`/`errorMessage`.
   */
  async post(params: Params): Promise<ConvergeResponse> {
    const merged: Params = {
      ssl_merchant_id: this.cfg.sslMerchantId,
      ssl_user_id: this.cfg.sslUserId,
      ssl_pin: this.cfg.sslPin,
      ssl_result_format: 'JSON',
      ...params,
    };
    const res = await this.transport()(this.base(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: ElavonClient.encode(merged),
    });
    return this.parse(res);
  }

  private async parse(res: FetchResponseLike): Promise<ConvergeResponse> {
    const raw = await res.text();
    let parsed: ConvergeResponse = {};
    try {
      parsed = raw ? (JSON.parse(raw) as ConvergeResponse) : {};
    } catch {
      parsed = { errorMessage: raw };
    }
    if (!res.ok) {
      throw new ElavonError(res.status, parsed, raw);
    }
    // A present errorCode/errorMessage is an infra/validation failure — THROW.
    if (parsed.errorCode !== undefined || parsed.errorMessage !== undefined) {
      throw new ElavonError(res.status, parsed, raw);
    }
    return parsed;
  }
}
