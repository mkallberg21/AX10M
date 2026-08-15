/**
 * Minimal Access Worldpay Payments API client.
 *
 * Access Worldpay auth is HTTP Basic (`Authorization: Basic base64(user:pass)`);
 * request/response bodies are JSON. Idempotency is via the `Idempotency-Key`
 * request header — Worldpay dedupes server-side, so a retried charge with the same
 * key never double-charges.
 *
 * IMPORTANT: a *refused* payment usually comes back as an HTTP 200 with
 * `outcome: "refused"` (a normal outcome), but MAY also surface as a 4xx whose body
 * carries `outcome: "refused"` / a `refusalCode`. Only genuine auth/validation/infra
 * errors (a non-2xx WITHOUT a refusal body) should throw. `WorldpayError.isPaymentFailure()`
 * draws that line; the HTTP-200 refusal is handled by the adapter reading `outcome`.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live Worldpay account. No dependency on the DOM `lib`: we declare the tiny slice
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

/** Shape of a Worldpay error body (only the fields we read). */
export interface WorldpayErrorBody {
  errorName?: string;
  message?: string;
  /** A refusal that arrives as a 4xx still carries the outcome / refusal fields. */
  outcome?: string;
  refusalCode?: string;
  refusalDescription?: string;
}

/** A structured Worldpay API error. A refusal body means the charge itself was refused. */
export class WorldpayError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: WorldpayErrorBody,
    readonly raw: string,
  ) {
    super(body.message ?? `Worldpay error ${httpStatus}`);
    this.name = 'WorldpayError';
  }

  /** True when Worldpay refused the charge at the payment layer (a decline), not an infra/auth error. */
  isPaymentFailure(): boolean {
    return this.body.outcome === 'refused' || typeof this.body.refusalCode === 'string';
  }
}

export interface WorldpayClientConfig {
  /** Basic-auth username. Injected, never hardcoded. */
  username: string;
  /** Basic-auth password. Injected, never hardcoded. */
  password: string;
  /** Override base URL. Defaults to https://access.worldpay.com (test: https://try.access.worldpay.com). */
  baseUrl?: string;
  /** Injectable transport (defaults to global fetch). */
  fetch?: FetchLike;
}

export interface PostResult {
  body: Record<string, unknown>;
  /** True when Worldpay returned a prior result for the same idempotency key. */
  idempotentReplay: boolean;
}

const DEFAULT_BASE = 'https://access.worldpay.com';

export class WorldpayClient {
  constructor(private readonly cfg: WorldpayClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? DEFAULT_BASE;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64')}`;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('WorldpayClient: no fetch implementation available');
    return f;
  }

  async post(path: string, body: unknown, idempotencyKey?: string): Promise<PostResult> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await this.transport()(`${this.base()}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    // Worldpay echoes a replay signal when it returns a prior result for the key.
    const idempotentReplay = res.headers.get('idempotency-replayed') === 'true';
    return { body: await this.parse(res), idempotentReplay };
  }

  /** GET a resource (e.g. a payment's details for contact enrichment). Throws on non-2xx. */
  async get(path: string): Promise<Record<string, unknown>> {
    const res = await this.transport()(`${this.base()}${path}`, {
      method: 'GET',
      headers: { Authorization: this.authHeader() },
    });
    return this.parse(res);
  }

  private async parse(res: FetchResponseLike): Promise<Record<string, unknown>> {
    const raw = await res.text();
    if (!res.ok) {
      let parsed: WorldpayErrorBody = {};
      try {
        parsed = raw ? (JSON.parse(raw) as WorldpayErrorBody) : {};
      } catch {
        parsed = { message: raw };
      }
      throw new WorldpayError(res.status, parsed, raw);
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
}
