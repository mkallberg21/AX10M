import { describe, it, expect } from 'vitest';
import { DeclineCode } from '@ax10m/canonical';
import { AnthropicLlmClient, AnthropicError, extractText, LlmDunningAgent, type FetchLike } from './index.js';
import type { DunningContext } from './index.js';

/** A Messages API "text" response envelope. */
function apiResponse(text: string): string {
  return JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
}

/** A fake transport that captures the request and returns a scripted response. */
function fakeFetch(res: { ok?: boolean; status?: number; body: string }, capture?: (req: { url: string; headers: Record<string, string>; body: string }) => void): FetchLike {
  return async (url, init) => {
    capture?.({ url, headers: init.headers, body: init.body });
    return { ok: res.ok ?? true, status: res.status ?? 200, async text() { return res.body; } };
  };
}

describe('extractText', () => {
  it('joins text blocks and trims', () => {
    expect(extractText(apiResponse('Subject: Hi\n\nBody'))).toBe('Subject: Hi\n\nBody');
    expect(extractText(JSON.stringify({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }))).toBe('ab');
  });
  it('returns empty for tool/no-text or unparseable payloads', () => {
    expect(extractText(JSON.stringify({ content: [{ type: 'tool_use' }] }))).toBe('');
    expect(extractText('not json')).toBe('');
    expect(extractText(JSON.stringify({ error: { message: 'x' } }))).toBe('');
  });
});

describe('AnthropicLlmClient', () => {
  it('requires an api key', () => {
    expect(() => new AnthropicLlmClient({ apiKey: '' })).toThrow(/apiKey is required/);
  });

  it('sends the auth + version headers, model, system, and user message', async () => {
    let req: { url: string; headers: Record<string, string>; body: string } | undefined;
    const client = new AnthropicLlmClient({
      apiKey: 'sk-test-not-a-real-key',
      model: 'claude-sonnet-5',
      fetch: fakeFetch({ body: apiResponse('ok') }, (r) => { req = r; }),
    });
    const out = await client.complete({ system: 'SYS', user: 'USER', maxTokens: 123 });
    expect(out).toBe('ok');
    expect(req!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req!.headers['x-api-key']).toBe('sk-test-not-a-real-key');
    expect(req!.headers['anthropic-version']).toBeTruthy();
    const sent = JSON.parse(req!.body) as { model: string; max_tokens: number; system: string; messages: Array<{ role: string; content: string }> };
    expect(sent.model).toBe('claude-sonnet-5');
    expect(sent.max_tokens).toBe(123);
    expect(sent.system).toBe('SYS');
    expect(sent.messages).toEqual([{ role: 'user', content: 'USER' }]);
  });

  it('throws AnthropicError on a non-2xx response', async () => {
    const client = new AnthropicLlmClient({ apiKey: 'k', fetch: fakeFetch({ ok: false, status: 429, body: '{"error":{"message":"rate limited"}}' }) });
    await expect(client.complete({ system: 's', user: 'u' })).rejects.toBeInstanceOf(AnthropicError);
  });
});

describe('LlmDunningAgent on the real client transport', () => {
  function ctx(): DunningContext {
    return {
      channel: 'email',
      declineCode: DeclineCode.ExpiredCard,
      merchantName: 'Acme',
      amountMinor: 1299,
      currency: 'USD',
      updateCardUrl: 'https://pay.acme.test/u/1',
      optOutInstruction: 'Unsubscribe: https://acme.test/unsub',
    };
  }

  it('uses the model output when it is valid', async () => {
    const c = ctx();
    const good = `Subject: Update your card\n\nWe couldn't process your $12.99 payment. Update: ${c.updateCardUrl}\n\n${c.optOutInstruction}`;
    const client = new AnthropicLlmClient({ apiKey: 'k', fetch: fakeFetch({ body: apiResponse(good) }) });
    const msg = await new LlmDunningAgent(client).compose(c);
    expect(msg.generatedBy).toBe('llm');
    expect(msg.body).toContain(c.updateCardUrl);
  });

  it('falls back to the template when the API errors', async () => {
    const client = new AnthropicLlmClient({ apiKey: 'k', fetch: fakeFetch({ ok: false, status: 500, body: 'boom' }) });
    const msg = await new LlmDunningAgent(client).compose(ctx());
    expect(msg.generatedBy).toBe('template');
    expect(msg.body).toContain('https://pay.acme.test/u/1');
  });
});
