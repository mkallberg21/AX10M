/**
 * DunningSender — the send seam for composed card-update prompts.
 *
 * SAFETY MODEL (this is an outward-facing action, so it is fenced hard):
 *   1. Sending is DECOUPLED from composing. The engine's charge decision never depends on it.
 *   2. Consent + quiet-hours + global opt-out are enforced by @ax10m/guardrail BEFORE a sender
 *      is ever called (the service does this) — a sender is the transport, not the gate.
 *   3. `assertSendable` re-validates at the transport boundary (defense in depth): no PAN in
 *      the payload, the recipient address matches the channel, the body is non-empty.
 *   4. `DryRunDunningSender` is the DEFAULT and the safe fallback — it sends NOTHING. Real
 *      providers move traffic only when an operator explicitly wires them AND enables live
 *      comms (mirrors the liveCharging gate on the money path).
 *   5. `send()` never throws — a provider/transport failure is returned as a `failed` result
 *      so a delivery problem can never break a recovery.
 *
 * Providers are hand-rolled over an injectable fetch (house style — no SDK, unit-tested with a
 * fake transport, no network in tests). Credentials are injected, never read from env here.
 */

import type { FetchLike } from './anthropic.js';
import { containsPanLike } from './dunning.js';
import type { DunningChannel, DunningMessage } from './types.js';

export interface DunningRecipient {
  channel: DunningChannel;
  /** Destination address for the channel. email → email; sms → phone (E.164). Never a PAN. */
  email?: string;
  phone?: string;
}

export type SendStatus = 'sent' | 'dry_run' | 'failed';

export interface SendResult {
  status: SendStatus;
  channel: DunningChannel;
  /** Which provider handled it ('dry-run' | 'postmark' | 'twilio' | 'composite'). */
  provider: string;
  /** Provider's message id, when sent. */
  providerMessageId?: string;
  /** Failure reason, when status === 'failed'. */
  error?: string;
}

export interface DunningSender {
  send(message: DunningMessage, recipient: DunningRecipient): Promise<SendResult>;
}

/** Thrown by assertSendable; providers convert it to a `failed` result (never sent). */
export class SendRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SendRefused';
  }
}

/** Transport-boundary re-validation. Throws SendRefused on anything unsafe to send. */
export function assertSendable(message: DunningMessage, recipient: DunningRecipient): void {
  if (recipient.channel !== message.channel) throw new SendRefused(`recipient channel ${recipient.channel} != message channel ${message.channel}`);
  if (!message.body.trim()) throw new SendRefused('empty body');
  if (containsPanLike(`${message.subject ?? ''}\n${message.body}`)) throw new SendRefused('PAN-like sequence in payload');
  if (message.channel === 'email' && !recipient.email) throw new SendRefused('email channel requires recipient.email');
  if (message.channel === 'sms' && !recipient.phone) throw new SendRefused('sms channel requires recipient.phone');
}

/** Turn any thrown error into a `failed` result so send() never rejects. */
function failed(channel: DunningChannel, provider: string, err: unknown): SendResult {
  return { status: 'failed', channel, provider, error: err instanceof Error ? err.message : String(err) };
}

// ── DryRun (default, safe) ────────────────────────────────────────────────────

/**
 * The safe default: validates, sends NOTHING, returns `dry_run`. An optional sink receives the
 * message for local inspection/logging. Use everywhere until an operator opts into live comms.
 */
export class DryRunDunningSender implements DunningSender {
  constructor(private readonly sink?: (message: DunningMessage, recipient: DunningRecipient) => void) {}
  async send(message: DunningMessage, recipient: DunningRecipient): Promise<SendResult> {
    try {
      assertSendable(message, recipient);
    } catch (err) {
      return failed(message.channel, 'dry-run', err);
    }
    this.sink?.(message, recipient);
    return { status: 'dry_run', channel: message.channel, provider: 'dry-run' };
  }
}

// ── Real providers (injectable transport; move traffic only when explicitly wired) ────────────

const DEFAULT_TIMEOUT_MS = 10_000;

function transportOf(fetchImpl?: FetchLike): FetchLike {
  const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!f) throw new Error('DunningSender: no fetch implementation available');
  return f;
}

export interface PostmarkConfig {
  serverToken: string;
  fromEmail: string;
  messageStream?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Email via Postmark. Endpoint/fields modeled on Postmark's transactional email API
 * (POST /email, `X-Postmark-Server-Token`, JSON From/To/Subject/TextBody) — CONFIRM against
 * current docs before production. Token injected, never read from env here.
 */
export class PostmarkEmailSender implements DunningSender {
  constructor(private readonly cfg: PostmarkConfig) {
    if (!cfg.serverToken) throw new Error('PostmarkEmailSender: serverToken is required');
    if (!cfg.fromEmail) throw new Error('PostmarkEmailSender: fromEmail is required');
  }
  async send(message: DunningMessage, recipient: DunningRecipient): Promise<SendResult> {
    try {
      assertSendable(message, recipient);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const res = await transportOf(this.cfg.fetch)(`${this.cfg.baseUrl ?? 'https://api.postmarkapp.com'}/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-postmark-server-token': this.cfg.serverToken },
          body: JSON.stringify({
            From: this.cfg.fromEmail,
            To: recipient.email,
            Subject: message.subject ?? '',
            TextBody: message.body,
            MessageStream: this.cfg.messageStream ?? 'outbound',
          }),
          signal: controller.signal,
        });
        const raw = await res.text();
        if (!res.ok) return { status: 'failed', channel: 'email', provider: 'postmark', error: `HTTP ${res.status}: ${raw.slice(0, 200)}` };
        const id = parseJsonField(raw, 'MessageID');
        return { status: 'sent', channel: 'email', provider: 'postmark', providerMessageId: id };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return failed('email', 'postmark', err);
    }
  }
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * SMS via Twilio. Endpoint/fields modeled on Twilio's Messages API (POST
 * /2010-04-01/Accounts/{Sid}/Messages.json, Basic auth, form To/From/Body) — CONFIRM against
 * current docs before production. Credentials injected, never read from env here.
 */
export class TwilioSmsSender implements DunningSender {
  constructor(private readonly cfg: TwilioConfig) {
    if (!cfg.accountSid || !cfg.authToken) throw new Error('TwilioSmsSender: accountSid + authToken are required');
    if (!cfg.fromNumber) throw new Error('TwilioSmsSender: fromNumber is required');
  }
  async send(message: DunningMessage, recipient: DunningRecipient): Promise<SendResult> {
    try {
      assertSendable(message, recipient);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
        const body = new URLSearchParams({ To: recipient.phone!, From: this.cfg.fromNumber, Body: message.body }).toString();
        const res = await transportOf(this.cfg.fetch)(`${this.cfg.baseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${auth}` },
          body,
          signal: controller.signal,
        });
        const raw = await res.text();
        if (!res.ok) return { status: 'failed', channel: 'sms', provider: 'twilio', error: `HTTP ${res.status}: ${raw.slice(0, 200)}` };
        const id = parseJsonField(raw, 'sid');
        return { status: 'sent', channel: 'sms', provider: 'twilio', providerMessageId: id };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return failed('sms', 'twilio', err);
    }
  }
}

// ── Composite (route by channel) ──────────────────────────────────────────────

/** Routes each message to the sender configured for its channel. */
export class CompositeDunningSender implements DunningSender {
  constructor(private readonly byChannel: { email?: DunningSender; sms?: DunningSender }) {}
  async send(message: DunningMessage, recipient: DunningRecipient): Promise<SendResult> {
    const target = message.channel === 'email' ? this.byChannel.email : this.byChannel.sms;
    if (!target) return { status: 'failed', channel: message.channel, provider: 'composite', error: `no sender configured for channel ${message.channel}` };
    return target.send(message, recipient);
  }
}

/** Best-effort extraction of a top-level string/number field from a JSON body. */
function parseJsonField(raw: string, field: string): string | undefined {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const v = obj[field];
    return v == null ? undefined : String(v);
  } catch {
    return undefined;
  }
}
