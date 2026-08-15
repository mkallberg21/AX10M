import { describe, it, expect } from 'vitest';
import {
  DryRunDunningSender,
  PostmarkEmailSender,
  TwilioSmsSender,
  CompositeDunningSender,
  assertSendable,
  SendRefused,
  type DunningRecipient,
  type FetchLike,
} from './index.js';
import type { DunningMessage } from './index.js';

const email: DunningMessage = { channel: 'email', subject: 'Update your card', body: 'Please update: https://pay.test/u/1 — Unsubscribe: https://pay.test/unsub', generatedBy: 'template' };
const sms: DunningMessage = { channel: 'sms', body: 'Update your card: https://pay.test/u/1 Reply STOP to opt out', generatedBy: 'template' };
const emailTo: DunningRecipient = { channel: 'email', email: 'dana@example.test' };
const smsTo: DunningRecipient = { channel: 'sms', phone: '+15555550123' };

/** Fake transport: captures the request and returns a scripted response; asserts if called when it shouldn't be. */
function fakeFetch(res: { ok?: boolean; status?: number; body: string }, capture?: (r: { url: string; headers: Record<string, string>; body: string }) => void): FetchLike {
  return async (url, init) => {
    capture?.({ url, headers: init.headers, body: init.body });
    return { ok: res.ok ?? true, status: res.status ?? 200, async text() { return res.body; } };
  };
}

describe('assertSendable', () => {
  it('rejects a channel mismatch, empty body, missing address, and PAN', () => {
    expect(() => assertSendable(email, { channel: 'sms', phone: '+1' })).toThrow(SendRefused);
    expect(() => assertSendable({ ...email, body: '  ' }, emailTo)).toThrow(/empty body/);
    expect(() => assertSendable(email, { channel: 'email' })).toThrow(/requires recipient.email/);
    expect(() => assertSendable({ ...email, body: 'card 4242424242424242' }, emailTo)).toThrow(/PAN/);
  });
  it('passes a well-formed message + recipient', () => {
    expect(() => assertSendable(email, emailTo)).not.toThrow();
    expect(() => assertSendable(sms, smsTo)).not.toThrow();
  });
});

describe('DryRunDunningSender', () => {
  it('sends nothing, returns dry_run, and forwards to the sink', async () => {
    let sunk: DunningMessage | undefined;
    const sender = new DryRunDunningSender((m) => { sunk = m; });
    const r = await sender.send(email, emailTo);
    expect(r).toMatchObject({ status: 'dry_run', channel: 'email', provider: 'dry-run' });
    expect(sunk).toBe(email);
  });
  it('returns failed (not thrown) on an unsafe message', async () => {
    const r = await new DryRunDunningSender().send(email, { channel: 'email' }); // no address
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/recipient.email/);
  });
});

describe('PostmarkEmailSender', () => {
  it('requires token + from', () => {
    expect(() => new PostmarkEmailSender({ serverToken: '', fromEmail: 'x@y.z' })).toThrow();
    expect(() => new PostmarkEmailSender({ serverToken: 't', fromEmail: '' })).toThrow();
  });
  it('POSTs the token header + From/To/Subject/TextBody and parses MessageID', async () => {
    let req: { url: string; headers: Record<string, string>; body: string } | undefined;
    const sender = new PostmarkEmailSender({ serverToken: 'tok-not-real', fromEmail: 'billing@merchant.test', fetch: fakeFetch({ body: '{"MessageID":"abc-123","ErrorCode":0}' }, (r) => { req = r; }) });
    const r = await sender.send(email, emailTo);
    expect(r).toMatchObject({ status: 'sent', provider: 'postmark', providerMessageId: 'abc-123' });
    expect(req!.url).toBe('https://api.postmarkapp.com/email');
    expect(req!.headers['x-postmark-server-token']).toBe('tok-not-real');
    const sent = JSON.parse(req!.body) as { From: string; To: string; Subject: string; TextBody: string };
    expect(sent).toMatchObject({ From: 'billing@merchant.test', To: 'dana@example.test', Subject: 'Update your card' });
    expect(sent.TextBody).toContain('https://pay.test/u/1');
  });
  it('returns failed on a non-2xx response without throwing', async () => {
    const sender = new PostmarkEmailSender({ serverToken: 't', fromEmail: 'x@y.z', fetch: fakeFetch({ ok: false, status: 422, body: '{"ErrorCode":300,"Message":"Invalid email"}' }) });
    const r = await sender.send(email, emailTo);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('422');
  });
});

describe('TwilioSmsSender', () => {
  it('POSTs Basic auth + form To/From/Body and parses sid', async () => {
    let req: { url: string; headers: Record<string, string>; body: string } | undefined;
    const sender = new TwilioSmsSender({ accountSid: 'ACxxx', authToken: 'tok-not-real', fromNumber: '+15555550100', fetch: fakeFetch({ body: '{"sid":"SM123","status":"queued"}' }, (r) => { req = r; }) });
    const r = await sender.send(sms, smsTo);
    expect(r).toMatchObject({ status: 'sent', provider: 'twilio', providerMessageId: 'SM123' });
    expect(req!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json');
    expect(req!.headers['authorization']).toBe(`Basic ${Buffer.from('ACxxx:tok-not-real').toString('base64')}`);
    const form = new URLSearchParams(req!.body);
    expect(form.get('To')).toBe('+15555550123');
    expect(form.get('From')).toBe('+15555550100');
    expect(form.get('Body')).toContain('Update your card');
  });
  it('returns failed on transport error without throwing', async () => {
    const sender = new TwilioSmsSender({ accountSid: 'AC', authToken: 't', fromNumber: '+1', fetch: async () => { throw new Error('network down'); } });
    const r = await sender.send(sms, smsTo);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/network down/);
  });
});

describe('CompositeDunningSender', () => {
  it('routes by channel and reports when a channel has no sender', async () => {
    const emailSender = new DryRunDunningSender();
    const composite = new CompositeDunningSender({ email: emailSender }); // no sms configured
    expect((await composite.send(email, emailTo)).status).toBe('dry_run');
    const r = await composite.send(sms, smsTo);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/no sender configured for channel sms/);
  });
});
