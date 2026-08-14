/**
 * Minimal Checkout.com Payments API client.
 *
 * Checkout.com auth is a Bearer secret key (`Authorization: Bearer sk_...`);
 * request/response bodies are JSON. Idempotency is via the `Cko-Idempotency-Key`
 * request header — Checkout dedupes server-side, so a retried charge with the same
 * key never double-charges.
 *
 * IMPORTANT: a *declined* payment can come back two ways: an HTTP 201 with
 * `status: "Declined"` (a normal outcome), OR a 4xx whose body carries a decline
 * `response_code`. Only genuine auth/validation/infra errors (a 4xx/5xx WITHOUT a
 * decline body) should throw. `CheckoutError.isPaymentFailure()` draws that line.
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live Checkout account. No dependency on the DOM `lib`: we declare the tiny slice
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

/** Shape of a Checkout.com error body (only the fields we read). */
export interface CheckoutErrorBody {
  request_id?: string;
  error_type?: string;
  error_codes?: string[];
  message?: string;
  /** Present when a 4xx is actually a payment decline (rare — most declines are 201). */
  status?: string;
  response_code?: string;
  response_summary?: string;
}

/** A structured Checkout.com API error. A `payment` failure means the charge itself was declined. */
export class CheckoutError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: CheckoutErrorBody,
    readonly raw: string,
  ) {
    super(body.message ?? `Checkout error ${httpStatus}`);
    this.name = 'CheckoutError';
  }

  /** True when Checkout rejected the charge at the payment layer (a decline), not an infra/auth error. */
  isPaymentFailure(): boolean {
    return (
      this.body.status === 'Declined' ||
      typeof this.body.response_code === 'string' ||
      this.body.error_type === 'payment_declined'
    );
  }
}

export interface CheckoutClientConfig {
  /** Secret key used as the Bearer credential (sk_...). Injected, never hardcoded. */
  secretKey: string;
  /** Override base URL. Defaults to https://api.checkout.com (sandbox: https://api.sandbox.checkout.com). */
  baseUrl?: string;
  /** Injectable transport (defaults to global fetch). */
  fetch?: FetchLike;
}

export interface PostResult {
  body: Record<string, unknown>;
  /** True when Checkout returned a prior result for the same idempotency key. */
  idempotentReplay: boolean;
}

const DEFAULT_BASE = 'https://api.checkout.com';

export class CheckoutClient {
  constructor(private readonly cfg: CheckoutClientConfig) {}

  private base(): string {
    return this.cfg.baseUrl ?? DEFAULT_BASE;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('CheckoutClient: no fetch implementation available');
    return f;
  }

  async post(path: string, body: unknown, idempotencyKey?: string): Promise<PostResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.secretKey}`,
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) headers['Cko-Idempotency-Key'] = idempotencyKey;
    const res = await this.transport()(`${this.base()}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    // Checkout echoes `Cko-Idempotency-Replayed: true` when it returns a prior result.
    const idempotentReplay = res.headers.get('cko-idempotency-replayed') === 'true';
    return { body: await this.parse(res), idempotentReplay };
  }

  async get(path: string, query: Record<string, string | number | undefined> = {}): Promise<Record<string, unknown>> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const res = await this.transport()(`${this.base()}${path}${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.cfg.secretKey}` },
    });
    return this.parse(res);
  }

  private async parse(res: FetchResponseLike): Promise<Record<string, unknown>> {
    const raw = await res.text();
    if (!res.ok) {
      let parsed: CheckoutErrorBody = {};
      try {
        parsed = raw ? (JSON.parse(raw) as CheckoutErrorBody) : {};
      } catch {
        parsed = { message: raw };
      }
      throw new CheckoutError(res.status, parsed, raw);
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
}
