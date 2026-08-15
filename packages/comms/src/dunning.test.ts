import { describe, it, expect } from 'vitest';
import { DeclineCode } from '@ax10m/canonical';
import {
  TemplateDunningAgent,
  LlmDunningAgent,
  composeTemplate,
  containsPanLike,
  humanReason,
  parseLlmOutput,
  validateMessage,
  type LlmClient,
} from './index.js';
import type { DunningContext } from './index.js';

function ctx(overrides: Partial<DunningContext> = {}): DunningContext {
  return {
    channel: 'email',
    declineCode: DeclineCode.ExpiredCard,
    merchantName: 'Acme Streaming',
    amountMinor: 1299,
    currency: 'USD',
    updateCardUrl: 'https://pay.acme.test/update/abc123',
    optOutInstruction: 'Unsubscribe: https://acme.test/unsub/abc123',
    customerName: 'Dana',
    cardLast4: '4242',
    ...overrides,
  };
}

/** A fake LLM that returns whatever script it's given — no network, no key. */
class FakeLlm implements LlmClient {
  constructor(private readonly reply: string) {}
  async complete(): Promise<string> {
    return this.reply;
  }
}

describe('containsPanLike', () => {
  it('flags a 16-digit PAN (spaced or contiguous)', () => {
    expect(containsPanLike('4242424242424242')).toBe(true);
    expect(containsPanLike('4242 4242 4242 4242')).toBe(true);
    expect(containsPanLike('4242-4242-4242-4242')).toBe(true);
  });
  it('does not flag a display last4 or short numbers', () => {
    expect(containsPanLike('card ending 4242')).toBe(false);
    expect(containsPanLike('your $12.99 payment')).toBe(false);
  });
});

describe('humanReason', () => {
  it('maps decline codes to honest, non-threatening reasons', () => {
    expect(humanReason(DeclineCode.ExpiredCard)).toMatch(/expired/i);
    expect(humanReason(DeclineCode.StolenCard)).toMatch(/lost or stolen/i);
    expect(humanReason(DeclineCode.ClosedAccount)).toMatch(/closed/i);
  });
});

describe('TemplateDunningAgent', () => {
  it('composes a safe, valid email that carries the link + opt-out', async () => {
    const agent = new TemplateDunningAgent();
    const msg = await agent.compose(ctx({ channel: 'email' }));
    expect(msg.generatedBy).toBe('template');
    expect(msg.subject).toBeTruthy();
    expect(msg.body).toContain('https://pay.acme.test/update/abc123');
    expect(msg.body).toContain('Unsubscribe');
    expect(msg.body).toContain('$12.99');
    expect(validateMessage(msg, ctx({ channel: 'email' })).ok).toBe(true);
  });

  it('composes a bounded SMS with the link and opt-out', async () => {
    const c = ctx({ channel: 'sms' });
    const msg = await new TemplateDunningAgent().compose(c);
    expect(msg.channel).toBe('sms');
    expect(msg.subject).toBeUndefined();
    expect(msg.body).toContain(c.updateCardUrl);
    expect(msg.body.length).toBeLessThanOrEqual(400);
    expect(validateMessage(msg, c).ok).toBe(true);
  });

  it('is decline-aware in the body', async () => {
    const msg = await new TemplateDunningAgent().compose(ctx({ declineCode: DeclineCode.StolenCard }));
    expect(msg.body).toMatch(/lost or stolen/i);
  });

  it('never leaks a PAN even if one were somehow present in context fields', async () => {
    // last4 is display-only; the template must not assemble anything PAN-like.
    const msg = composeTemplate(ctx({ cardLast4: '4242' }));
    expect(containsPanLike(`${msg.subject}\n${msg.body}`)).toBe(false);
  });
});

describe('parseLlmOutput', () => {
  it('parses an email with a Subject: header', () => {
    const msg = parseLlmOutput('Subject: Update your card\n\nHi there, please update.', 'email');
    expect(msg?.subject).toBe('Update your card');
    expect(msg?.body).toBe('Hi there, please update.');
    expect(msg?.generatedBy).toBe('llm');
  });
  it('returns null for an email missing the subject header', () => {
    expect(parseLlmOutput('no subject here', 'email')).toBeNull();
  });
  it('treats raw text as an SMS body', () => {
    expect(parseLlmOutput('Update your card: link', 'sms')?.body).toBe('Update your card: link');
  });
});

describe('LlmDunningAgent', () => {
  it('uses a valid LLM message when it passes validation', async () => {
    const c = ctx({ channel: 'email' });
    const good = `Subject: Quick heads-up, Dana\n\nWe couldn't process your $12.99 payment to Acme Streaming because ${humanReason(c.declineCode)}. Update here: ${c.updateCardUrl}\n\n${c.optOutInstruction}`;
    const msg = await new LlmDunningAgent(new FakeLlm(good)).compose(c);
    expect(msg.generatedBy).toBe('llm');
    expect(msg.body).toContain(c.updateCardUrl);
  });

  it('falls back to the template when the LLM leaks a PAN', async () => {
    const c = ctx({ channel: 'email' });
    const leaky = `Subject: Update\n\nYour card 4242424242424242 failed. Update: ${c.updateCardUrl}\n\n${c.optOutInstruction}`;
    const msg = await new LlmDunningAgent(new FakeLlm(leaky)).compose(c);
    expect(msg.generatedBy).toBe('template');
    expect(containsPanLike(`${msg.subject}\n${msg.body}`)).toBe(false);
  });

  it('falls back to the template when the LLM drops the update link', async () => {
    const c = ctx({ channel: 'email' });
    const noLink = `Subject: Update\n\nPlease update your card soon.\n\n${c.optOutInstruction}`;
    const msg = await new LlmDunningAgent(new FakeLlm(noLink)).compose(c);
    expect(msg.generatedBy).toBe('template');
    expect(msg.body).toContain(c.updateCardUrl);
  });

  it('falls back to the template when the LLM omits the opt-out', async () => {
    const c = ctx({ channel: 'email' });
    const noOptOut = `Subject: Update\n\nUpdate your card here: ${c.updateCardUrl}`;
    const msg = await new LlmDunningAgent(new FakeLlm(noOptOut)).compose(c);
    expect(msg.generatedBy).toBe('template');
  });

  it('falls back to the template when the LLM throws', async () => {
    const throwing: LlmClient = { async complete() { throw new Error('rate limited'); } };
    const msg = await new LlmDunningAgent(throwing).compose(ctx());
    expect(msg.generatedBy).toBe('template');
    expect(validateMessage(msg, ctx()).ok).toBe(true);
  });
});
