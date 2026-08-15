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
  type DunningAgent,
  type DunningChannel,
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

/** Convenience: the agent + optional config, as consumed by RecoveryCaseService.useDunningAgent. */
export function buildDunningComms(env: NodeJS.ProcessEnv = process.env): { agent: DunningAgent; config?: DunningCommsConfig } {
  return { agent: buildDunningAgent(env), config: buildDunningConfig(env) };
}
