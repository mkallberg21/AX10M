/**
 * Minimal TSYS / Global Payments "Transaction Express" client.
 *
 * Unlike the form-encoded legacy gateways, Transaction Express is a JSON REST-ish
 * API. Auth is NOT a bearer token: the `deviceID` + `transactionKey` credential
 * pair is carried IN the request body (a credential block), so this client does
 * not set an Authorization header.
 *
 * A transaction result carries a `status` of PASS | DECLINED | FAIL:
 *  - PASS      → the sale was approved. The client returns the body.
 *  - DECLINED  → the issuer declined (an expected payment OUTCOME). The client
 *                throws a `TsysError` whose `isPaymentFailure()` is true, so the
 *                adapter converts it into a `failed` attempt (mirrors the shared
 *                adapter idiom of distinguishing a decline via the client Error type).
 *  - FAIL      → a gateway/validation error (bad credentials, malformed request).
 *                `isPaymentFailure()` is false → the adapter rethrows it as infra.
 * HTTP-level errors also throw `TsysError` (infra).
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live gateway. No dependency on the DOM `lib`: we declare the tiny slice of the
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

/** The JSON body Transaction Express returns for a sale (only fields we read). */
export interface TsysResponse {
  status?: 'PASS' | 'FAIL' | 'DECLINED' | string;
  responseCode?: string; // ISO-ish response/decline code, e.g. '00', '51', '05'
  responseMessage?: string;
  transactionID?: string;
  /** Echo of the idempotency key we sent, when the gateway returns it. */
  transactionIdentifier?: string;
  [k: string]: unknown;
}

/** ISO-ish response codes that indicate the acquirer/issuer DECLINED the sale. */
const APPROVAL_CODES = new Set(['00', '000', '10', '85']);

/** A structured Transaction Express error. A DECLINED status is a payment decline; FAIL is infra. */
export class TsysError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: TsysResponse,
    readonly raw: string,
  ) {
    super(body.responseMessage ?? `TSYS error ${httpStatus} (${body.status ?? 'unknown'})`);
    this.name = 'TsysError';
  }

  /** True when the gateway declined the card (an expected outcome), not an infra/validation failure. */
  isPaymentFailure(): boolean {
    if (this.body.status === 'DECLINED') return true;
    if (this.body.status === 'FAIL') return false;
    // Defensive: a non-approval response code with no explicit status still reads
    // as a decline rather than a hard error.
    const code = this.body.responseCode;
    return code !== undefined && code !== '' && !APPROVAL_CODES.has(code);
  }
}

export interface TsysClientConfig {
  /** Transaction Express `deviceID` (credential block, not a bearer). */
  deviceID: string;
  /** Transaction Express `transactionKey` (secret; injected, never hardcoded). */
  transactionKey: string;
  /** Optional partner/developer id some Transaction Express deployments require. */
  developerID?: string;
  /** Injectable transport (defaults to global fetch). */
  fetch?: FetchLike;
  /**
   * Base URL. Defaults to the documented Transaction Express host; the exact host
   * and API version MUST be confirmed against the live merchant boarding.
   */
  baseUrl?: string;
}

const DEFAULT_BASE = 'https://gateway.transit-pass.com/portal';

export class TsysClient {
  constructor(private readonly cfg: TsysClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? DEFAULT_BASE;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('TsysClient: no fetch implementation available');
    return f;
  }

  /**
   * POST a JSON transaction. The `deviceID`/`transactionKey` credential block is
   * merged into the body; the deterministic idempotency key is sent BOTH as an
   * `Idempotency-Key` header and echoed in the body. Returns the body on PASS;
   * throws `TsysError` on DECLINED/FAIL/HTTP error.
   */
  async post(
    path: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<TsysResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const body = JSON.stringify({
      deviceID: this.cfg.deviceID,
      transactionKey: this.cfg.transactionKey,
      developerID: this.cfg.developerID,
      // Echo the deterministic key so it is greppable in gateway reports.
      transactionIdentifier: idempotencyKey,
      ...payload,
    });
    const res = await this.transport()(`${this.base()}${path}`, { method: 'POST', headers, body });
    return this.parse(res);
  }

  private async parse(res: FetchResponseLike): Promise<TsysResponse> {
    const raw = await res.text();
    let parsed: TsysResponse = {};
    try {
      parsed = raw ? (JSON.parse(raw) as TsysResponse) : {};
    } catch {
      parsed = { responseMessage: raw, status: 'FAIL' };
    }
    if (!res.ok) {
      throw new TsysError(res.status, parsed, raw);
    }
    // In-band non-approval (DECLINED or FAIL) is surfaced as a structured error so
    // the adapter can classify it via TsysError.isPaymentFailure().
    if (parsed.status !== 'PASS') {
      throw new TsysError(res.status, parsed, raw);
    }
    return parsed;
  }
}
