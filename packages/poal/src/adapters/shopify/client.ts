/**
 * Minimal Shopify Admin GraphQL API client.
 *
 * NOTE (co-drive): AX10M does NOT hold the card. This client only TRIGGERS a
 * subscription billing attempt via the Admin GraphQL API; Shopify's own billing
 * pipeline (and its configured gateway, e.g. Shopify Payments) performs the actual
 * charge. Endpoint path and field names are modeled on the documented Admin API
 * version (default 2024-07) and MUST be confirmed against the pinned version — the
 * MECHANISM (idempotency-key pass-through, pending-vs-failed, token-only) is the
 * deliverable.
 *
 * Auth is the `X-Shopify-Access-Token` header (an offline app access token, never a
 * PAN). We POST { query, variables } and return the `data` object, throwing on a
 * top-level GraphQL `errors` array (infra/auth/validation — NOT a decline).
 *
 * The transport (`fetch`) is injectable so the adapter is unit-testable without a
 * live Shopify shop. No dependency on the DOM `lib`: we declare the tiny slice of
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

/** A single GraphQL error entry (top-level `errors`), used for infra/auth/validation failures. */
export interface ShopifyGraphQLError {
  message?: string;
  extensions?: { code?: string };
}

/** A structured Shopify API error — an HTTP failure or a top-level GraphQL `errors` array. */
export class ShopifyError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly errors: ShopifyGraphQLError[],
    readonly raw: string,
  ) {
    super(errors[0]?.message ?? `Shopify error ${httpStatus}`);
    this.name = 'ShopifyError';
  }
}

export interface ShopifyClientConfig {
  /** Shop subdomain: <shop>.myshopify.com. */
  shop: string;
  /** Admin API access token (X-Shopify-Access-Token). Injected, never hardcoded. */
  accessToken: string;
  /** Admin API version. Defaults to '2024-07'. */
  apiVersion?: string;
  /** Injectable transport (defaults to global fetch). */
  fetch?: FetchLike;
  /** Override base URL (tests / regions). Defaults to https://{shop}.myshopify.com/admin/api/{version}/graphql.json. */
  baseUrl?: string;
}

export class ShopifyClient {
  constructor(private readonly cfg: ShopifyClientConfig) {}

  private base(): string {
    const version = this.cfg.apiVersion ?? '2024-07';
    return this.cfg.baseUrl ?? `https://${this.cfg.shop}.myshopify.com/admin/api/${version}/graphql.json`;
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('ShopifyClient: no fetch implementation available');
    return f;
  }

  /**
   * Execute a GraphQL operation and return its `data` object. Throws a
   * `ShopifyError` on a non-2xx HTTP status or a top-level `errors` array — both
   * are infra/auth/validation failures the saga should surface, NOT card declines
   * (a decline is a `userErrors`/`errorCode` inside a 200 `data` payload).
   */
  async graphql(query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await this.transport()(this.base(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.cfg.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    const raw = await res.text();
    if (!res.ok) {
      const errors = ShopifyClient.parseErrors(raw);
      throw new ShopifyError(res.status, errors, raw);
    }
    const parsed = raw ? (JSON.parse(raw) as { data?: Record<string, unknown>; errors?: ShopifyGraphQLError[] }) : {};
    if (parsed.errors && parsed.errors.length > 0) {
      throw new ShopifyError(res.status, parsed.errors, raw);
    }
    return parsed.data ?? {};
  }

  private static parseErrors(raw: string): ShopifyGraphQLError[] {
    try {
      const parsed = raw ? (JSON.parse(raw) as { errors?: ShopifyGraphQLError[] }) : {};
      return Array.isArray(parsed.errors) && parsed.errors.length > 0 ? parsed.errors : [{ message: raw }];
    } catch {
      return [{ message: raw }];
    }
  }
}
