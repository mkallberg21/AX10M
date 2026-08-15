/**
 * Dunning-comms types — the shape of a card-update prompt the agent composes.
 *
 * SCOPE: this package COMPOSES the message content (subject/body). It never SENDS (that's a
 * comms provider + an outward-facing action) and it is never in the charge-decision path —
 * comms are gated by the guardrail (consent + quiet hours) upstream. No PAN, ever.
 */

import type { DeclineCode } from '@ax10m/canonical';

export type DunningChannel = 'email' | 'sms';

/** Everything the agent may personalize on. Deliberately excludes the PAN. */
export interface DunningContext {
  channel: DunningChannel;
  /** The decline that triggered the card-update prompt (drives the human reason). */
  declineCode: DeclineCode;
  merchantName: string;
  amountMinor: number;
  currency: string;
  /** Where the customer updates their card — MUST appear verbatim in every message. */
  updateCardUrl: string;
  /** How the customer opts out (unsubscribe link for email, "Reply STOP" for SMS). Required. */
  optOutInstruction: string;
  customerName?: string;
  /** Display-only last 4 of the failing card (NEVER the PAN). */
  cardLast4?: string;
  /** BCP-47 locale (e.g. 'en-US'). The template path is English-only for now. */
  locale?: string;
  /** 1-based reminder in the sequence — later reminders may read as more time-sensitive. */
  reminderNumber?: number;
}

export interface DunningMessage {
  channel: DunningChannel;
  /** Email subject (omitted for SMS). */
  subject?: string;
  body: string;
  /** Provenance for the audit trail. */
  generatedBy: 'template' | 'llm';
}
