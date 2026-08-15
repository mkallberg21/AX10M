/**
 * AnthropicLlmClient — a real Anthropic Messages API client implementing the LlmClient seam
 * that LlmDunningAgent depends on.
 *
 * House style (matches the poal processor clients): a hand-rolled, dependency-free transport
 * over an INJECTABLE `fetch` — no SDK, unit-testable with a fake transport, no network in
 * tests. The API key is passed IN (never read from the environment here, never hard-coded);
 * the app layer sources it from `ANTHROPIC_API_KEY`. A request timeout means a slow/hung API
 * call surfaces as a throw, which LlmDunningAgent catches → deterministic template fallback.
 *
 * This is a comms-copy client only. It is never in the charge-decision path.
 */

import type { LlmClient } from './dunning.js';

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface AnthropicClientConfig {
  /** Anthropic API key. Required — injected by the caller; never read from env in this package. */
  apiKey: string;
  /** Model id. Defaults to a fast model well-suited to short transactional copy. */
  model?: string;
  /** Default max output tokens when a call doesn't specify one. */
  maxTokens?: number;
  baseUrl?: string;
  /** Anthropic API version header. */
  anthropicVersion?: string;
  /** Injectable transport (defaults to the global fetch). */
  fetch?: FetchLike;
  /** Per-request timeout in ms (default 10s). A timeout throws → template fallback upstream. */
  timeoutMs?: number;
}

/** Shape of the Messages API response we read (`content` is a list of typed blocks). */
interface AnthropicMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { type?: string; message?: string };
}

export class AnthropicError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly raw: string,
  ) {
    super(`Anthropic API error ${httpStatus}`);
    this.name = 'AnthropicError';
  }
}

const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap; dunning copy is short, high-volume
const DEFAULT_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 400;
const DEFAULT_TIMEOUT_MS = 10_000;

export class AnthropicLlmClient implements LlmClient {
  constructor(private readonly cfg: AnthropicClientConfig) {
    if (!cfg.apiKey) throw new Error('AnthropicLlmClient: apiKey is required');
  }

  private transport(): FetchLike {
    const f = this.cfg.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('AnthropicLlmClient: no fetch implementation available');
    return f;
  }

  async complete(input: { system: string; user: string; maxTokens?: number }): Promise<string> {
    const controller = new AbortController();
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.transport()(`${this.cfg.baseUrl ?? DEFAULT_BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.cfg.apiKey,
          'anthropic-version': this.cfg.anthropicVersion ?? DEFAULT_VERSION,
        },
        body: JSON.stringify({
          model: this.cfg.model ?? DEFAULT_MODEL,
          max_tokens: input.maxTokens ?? this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: input.system,
          messages: [{ role: 'user', content: input.user }],
        }),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) throw new AnthropicError(res.status, raw);
      return extractText(raw);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Join all text blocks from a Messages API response. Returns '' if none (→ template fallback). */
export function extractText(raw: string): string {
  let parsed: AnthropicMessageResponse;
  try {
    parsed = JSON.parse(raw) as AnthropicMessageResponse;
  } catch {
    return '';
  }
  if (!Array.isArray(parsed.content)) return '';
  return parsed.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('')
    .trim();
}
