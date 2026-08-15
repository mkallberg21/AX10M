/**
 * Build the dunning-comms wiring from the environment.
 *
 *   - The AGENT is an LlmDunningAgent backed by a real AnthropicLlmClient when
 *     `ANTHROPIC_API_KEY` is set (validated output, deterministic template fallback);
 *     otherwise the deterministic TemplateDunningAgent (no key, no network).
 *   - The CONFIG (where the card-update page lives + the opt-out) is OPERATOR-OWNED and
 *     opt-in: composition only turns on when `AX10M_CARD_UPDATE_URL` + `AX10M_COMMS_OPT_OUT`
 *     are set. Without them the agent is wired but nothing is composed (unchanged behavior).
 *
 * The API key is read here (app layer) and injected into the pure client — it is never read
 * inside @ax10m/comms and never committed. SENDING remains out of scope (needs a provider).
 */

import { Logger } from '@nestjs/common';
import {
  AnthropicLlmClient,
  LlmDunningAgent,
  TemplateDunningAgent,
  PostmarkEmailSender,
  TwilioSmsSender,
  CompositeDunningSender,
  RetryingDunningSender,
  type DunningAgent,
  type DunningChannel,
  type DunningSender,
} from '@ax10m/comms';
import type { DunningCommsConfig } from './recovery-case.service.js';

const logger = new Logger('DunningCommsBuilder');

export function buildDunningAgent(env: NodeJS.ProcessEnv = process.env): DunningAgent {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return new TemplateDunningAgent();
  const client = new AnthropicLlmClient({ apiKey, model: env.ANTHROPIC_MODEL || undefined });
  logger.log(`Dunning comms: LLM personalization enabled (model=${env.ANTHROPIC_MODEL || 'default'}, template fallback on any invalid/failed output).`);
  return new LlmDunningAgent(client, { brandVoice: env.AX10M_COMMS_BRAND_VOICE || undefined });
}

/**
 * Build the operator's comms config from env. `AX10M_CARD_UPDATE_URL` is a template that may
 * contain `{invoiceId}` / `{customerId}` placeholders. Returns undefined (composition off)
 * unless both the URL template and the opt-out instruction are provided.
 */
export function buildDunningConfig(env: NodeJS.ProcessEnv = process.env): DunningCommsConfig | undefined {
  const urlTemplate = env.AX10M_CARD_UPDATE_URL;
  const optOut = env.AX10M_COMMS_OPT_OUT;
  if (!urlTemplate || !optOut) return undefined;
  const channel = (env.AX10M_COMMS_CHANNEL === 'sms' ? 'sms' : 'email') as DunningChannel;
  const merchantName = env.AX10M_MERCHANT_NAME;
  logger.log(`Dunning comms: composition enabled (channel=${channel}) — composed messages recorded in the comms.sent ledger detail (not sent here).`);
  return {
    updateCardUrl: ({ invoice, customerId }) =>
      urlTemplate.replaceAll('{invoiceId}', encodeURIComponent(invoice.id)).replaceAll('{customerId}', encodeURIComponent(customerId)),
    optOutInstruction: optOut,
    channel,
    merchantName: merchantName ? () => merchantName : undefined,
  };
}

/**
 * Build a send transport from env, per channel. Email → Postmark (`POSTMARK_SERVER_TOKEN` +
 * `AX10M_COMMS_FROM_EMAIL`); SMS → Twilio (`TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` +
 * `AX10M_COMMS_FROM_SMS`). Credentials are read here (app layer) and injected. Returns the
 * sender (undefined if no provider configured) + the `live` flag: SENDING is off unless
 * `AX10M_LIVE_COMMS=true` — otherwise every send is a dry-run, even with a provider wired.
 */
export function buildDunningSender(env: NodeJS.ProcessEnv = process.env): { sender?: DunningSender; live: boolean } {
  const live = env.AX10M_LIVE_COMMS === 'true';
  let email: DunningSender | undefined;
  let sms: DunningSender | undefined;
  if (env.POSTMARK_SERVER_TOKEN && env.AX10M_COMMS_FROM_EMAIL) {
    email = new PostmarkEmailSender({ serverToken: env.POSTMARK_SERVER_TOKEN, fromEmail: env.AX10M_COMMS_FROM_EMAIL, messageStream: env.POSTMARK_MESSAGE_STREAM || undefined });
  }
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.AX10M_COMMS_FROM_SMS) {
    sms = new TwilioSmsSender({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, fromNumber: env.AX10M_COMMS_FROM_SMS });
  }
  if (!email && !sms) return { sender: undefined, live };
  logger.log(`Dunning send transport configured (email=${!!email}, sms=${!!sms}, live=${live}${live ? '' : ' → dry-run only'}).`);
  // Wrap in the retrying transport so transient provider blips (5xx/429/network) retry with
  // backoff; permanent failures (bad payload / 4xx) do not. Exactly-once across re-invocations
  // is the service's dedupe store, not this layer.
  return { sender: new RetryingDunningSender(new CompositeDunningSender({ email, sms })), live };
}

/** Convenience: the agent + optional config + optional send transport, as consumed by the service. */
export function buildDunningComms(env: NodeJS.ProcessEnv = process.env): {
  agent: DunningAgent;
  config?: DunningCommsConfig;
  sender?: DunningSender;
  live: boolean;
} {
  const { sender, live } = buildDunningSender(env);
  return { agent: buildDunningAgent(env), config: buildDunningConfig(env), sender, live };
}
