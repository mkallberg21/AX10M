/**
 * Dunning-comms agent — composes card-update prompts.
 *
 * Two implementations behind one interface:
 *  - `TemplateDunningAgent` — deterministic, decline-aware, per-channel. Always available,
 *    no API key, fully testable. The safe fallback.
 *  - `LlmDunningAgent` — personalizes via an INJECTED `LlmClient` (the seam a real Anthropic
 *    wrapper implements), then VALIDATES the output (no PAN, carries the real update link +
 *    opt-out, length-bounded) and FALLS BACK to the template if anything is off.
 *
 * The LLM never decides whether/when to charge — it only writes copy for a comms action the
 * guardrail already permitted. No PAN is ever in the context or the output.
 */

import { DeclineCode } from '@ax10m/canonical';
import type { DunningChannel, DunningContext, DunningMessage } from './types.js';

export interface DunningAgent {
  compose(ctx: DunningContext): Promise<DunningMessage>;
}

/** The LLM seam — a real impl wraps Anthropic; tests/fallback use a fake or the template. */
export interface LlmClient {
  complete(input: { system: string; user: string; maxTokens?: number }): Promise<string>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function money(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}

/** A short, honest human reason for the card-update prompt. */
export function humanReason(code: DeclineCode): string {
  switch (code) {
    case DeclineCode.ExpiredCard:
      return 'your card on file has expired';
    case DeclineCode.LostCard:
    case DeclineCode.StolenCard:
      return 'your card was reported lost or stolen';
    case DeclineCode.ClosedAccount:
      return 'the account for your card is closed';
    case DeclineCode.InvalidCard:
    case DeclineCode.PickupCard:
    case DeclineCode.CardNotSupported:
      return 'your card can no longer be charged';
    default:
      return "we couldn't process your card";
  }
}

/** A run of 13–19 digits (optionally single-space/hyphen separated) — a PAN. last4 (4 digits) is safe. */
export function containsPanLike(text: string): boolean {
  return /\b\d(?:[ -]?\d){12,18}\b/.test(text);
}

/** Validate a composed message: no PAN, carries the real update link + an opt-out, bounded length. */
export function validateMessage(msg: DunningMessage, ctx: DunningContext): { ok: boolean; reason?: string } {
  const full = `${msg.subject ?? ''}\n${msg.body}`;
  if (!msg.body.trim()) return { ok: false, reason: 'empty body' };
  if (containsPanLike(full)) return { ok: false, reason: 'PAN-like sequence present' };
  if (!msg.body.includes(ctx.updateCardUrl)) return { ok: false, reason: 'missing the update-card link' };
  const hasOptOut = msg.body.includes(ctx.optOutInstruction) || (ctx.channel === 'sms' && /stop/i.test(msg.body));
  if (!hasOptOut) return { ok: false, reason: 'missing opt-out instruction' };
  const maxBody = ctx.channel === 'sms' ? 400 : 4000;
  if (msg.body.length > maxBody) return { ok: false, reason: `body too long for ${ctx.channel}` };
  if (ctx.channel === 'email' && !msg.subject?.trim()) return { ok: false, reason: 'email needs a subject' };
  return { ok: true };
}

// ── template agent (deterministic, safe fallback) ────────────────────────────

export class TemplateDunningAgent implements DunningAgent {
  async compose(ctx: DunningContext): Promise<DunningMessage> {
    return composeTemplate(ctx);
  }
}

export function composeTemplate(ctx: DunningContext): DunningMessage {
  const amount = money(ctx.amountMinor, ctx.currency);
  const reason = humanReason(ctx.declineCode);
  const who = ctx.customerName ? ctx.customerName : 'there';
  const last4 = ctx.cardLast4 ? ` (card ending ${ctx.cardLast4})` : '';
  if (ctx.channel === 'sms') {
    const body = `${ctx.merchantName}: your ${amount} payment didn't go through — ${reason}${last4}. Update your card: ${ctx.updateCardUrl} — ${ctx.optOutInstruction}`;
    return { channel: 'sms', body, generatedBy: 'template' };
  }
  const subject = `Action needed: update your payment method for ${ctx.merchantName}`;
  const body =
    `Hi ${who},\n\n` +
    `We tried to process your payment of ${amount} to ${ctx.merchantName}, but ${reason}${last4}.\n\n` +
    `To keep your subscription active, please update your card here:\n${ctx.updateCardUrl}\n\n` +
    `${ctx.optOutInstruction}\n\n` +
    `Thanks,\n${ctx.merchantName}`;
  return { channel: 'email', subject, body, generatedBy: 'template' };
}

// ── LLM agent (personalized, validated, with template fallback) ───────────────

export interface LlmDunningOptions {
  /** Brand voice / extra house-style guidance for the system prompt. */
  brandVoice?: string;
  maxTokens?: number;
}

export class LlmDunningAgent implements DunningAgent {
  constructor(
    private readonly llm: LlmClient,
    private readonly opts: LlmDunningOptions = {},
  ) {}

  async compose(ctx: DunningContext): Promise<DunningMessage> {
    try {
      const raw = await this.llm.complete({ system: this.systemPrompt(ctx.channel), user: this.userPrompt(ctx), maxTokens: this.opts.maxTokens ?? 400 });
      const msg = parseLlmOutput(raw, ctx.channel);
      if (msg && validateMessage(msg, ctx).ok) return msg;
    } catch {
      /* fall through to the deterministic template */
    }
    return composeTemplate(ctx); // unsafe / empty / errored → the guaranteed-safe template
  }

  private systemPrompt(channel: DunningChannel): string {
    return [
      'You write short, warm card-update (dunning) messages for a payments-recovery service.',
      'HARD RULES:',
      '- Never invent or include a full card number (PAN). Only the last 4 may appear, and only if given.',
      '- Include the exact update-card URL provided, verbatim. Do not shorten or alter it.',
      '- Include the exact opt-out instruction provided.',
      '- Be honest and non-threatening: no fake urgency, no legal threats, no guilt.',
      channel === 'sms'
        ? '- SMS: one message, under ~300 characters, no subject line. Output ONLY the message text.'
        : '- Email: output "Subject: <line>" on the first line, then a blank line, then the body.',
      this.opts.brandVoice ? `BRAND VOICE: ${this.opts.brandVoice}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private userPrompt(ctx: DunningContext): string {
    return JSON.stringify({
      merchant: ctx.merchantName,
      reason: humanReason(ctx.declineCode),
      amount: money(ctx.amountMinor, ctx.currency),
      customerName: ctx.customerName ?? null,
      cardLast4: ctx.cardLast4 ?? null,
      updateCardUrl: ctx.updateCardUrl,
      optOutInstruction: ctx.optOutInstruction,
      reminderNumber: ctx.reminderNumber ?? 1,
      locale: ctx.locale ?? 'en-US',
    });
  }
}

/** Parse the LLM output into a DunningMessage (email: "Subject: …\n\nbody"; sms: raw body). */
export function parseLlmOutput(raw: string, channel: DunningChannel): DunningMessage | null {
  const text = raw.trim();
  if (!text) return null;
  if (channel === 'sms') return { channel: 'sms', body: text, generatedBy: 'llm' };
  const m = /^subject:\s*(.+?)\r?\n\r?\n([\s\S]+)$/i.exec(text);
  if (!m) return null;
  return { channel: 'email', subject: m[1]!.trim(), body: m[2]!.trim(), generatedBy: 'llm' };
}
