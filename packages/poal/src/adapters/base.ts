/**
 * Base adapter — shared skeleton behavior for processor adapters (PROCESSORS.md §3).
 *
 * Concrete adapters override `capabilities()` and the methods they can actually
 * implement. The defaults here encode the safe fallbacks:
 *  - drive/co-drive adapters that haven't implemented a method throw a clear
 *    TODO(lift) so nothing silently no-ops on the billing path;
 *  - advisory adapters (Merchant-of-Record, app-store IAP) cannot drive a charge
 *    at all — `attemptCharge` / `pauseNativeDunning` throw an advisory error by
 *    design, while `ingestWebhook` (measurement) still works.
 */

import type { Customer, Invoice, PaymentMethod, Subscription, CanonicalEvent } from '@lift/canonical';
import type {
  CapabilityMatrix,
  ChargeResult,
  Cursor,
  OpenFailuresPage,
  ProcessorAdapter,
  RawWebhook,
} from '../adapter.js';

export abstract class BaseAdapter implements ProcessorAdapter {
  abstract readonly id: string;
  abstract capabilities(): CapabilityMatrix;

  protected advisory(): boolean {
    return this.capabilities().integrationMode === 'advisory';
  }

  async ingestWebhook(raw: RawWebhook): Promise<CanonicalEvent[]> {
    // TODO(lift): verify signature, then normalize to canonical events. Even
    // advisory adapters implement this — measurement is always available.
    void raw;
    return [];
  }

  async listOpenFailures(cursor: Cursor): Promise<OpenFailuresPage> {
    // TODO(lift): reconciliation poll (truth source). Advisory adapters read the
    // platform's failed-renewal notifications instead of a charge-level poll.
    void cursor;
    return { invoices: [], nextCursor: null };
  }

  async attemptCharge(
    invoice: Invoice,
    method: PaymentMethod,
    idempotencyKey: string,
  ): Promise<ChargeResult> {
    void invoice;
    void method;
    if (this.advisory()) {
      throw new Error(
        `${this.id}: advisory mode — Lift cannot drive a charge here (platform owns the token/retry). Recommend or prompt out-of-band only (PROCESSORS.md §1).`,
      );
    }
    throw new Error(`TODO(lift): ${this.id}.attemptCharge not implemented (idemKey=${idempotencyKey})`);
  }

  async fetchUpdatedCard(method: PaymentMethod): Promise<PaymentMethod | null> {
    void method;
    return null;
  }

  async listPaymentMethods(customer: Customer): Promise<PaymentMethod[]> {
    void customer;
    return [];
  }

  async pauseNativeDunning(subscription: Subscription): Promise<void> {
    void subscription;
    if (this.advisory()) {
      throw new Error(`${this.id}: advisory mode — platform-owned dunning cannot be paused by Lift.`);
    }
    throw new Error(`TODO(lift): ${this.id}.pauseNativeDunning not implemented`);
  }
}
