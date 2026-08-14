/**
 * The durable-runtime seam.
 *
 * `runRecoverySaga` (driver.ts) needs exactly two capabilities from its host: the
 * current time, and the ability to sleep until a future instant. In production the
 * Temporal workflow provides these via workflow time + `sleep` (both durable and
 * replay-safe). In tests, `InMemoryRuntime` provides them with a virtual clock that
 * advances instantly — so a saga that "waits three days between retries" runs in
 * microseconds and asserts on the exact timeline.
 */

export interface SchedulerRuntime {
  /** Current instant as an ISO string. Durable + deterministic under the host. */
  now(): string;
  /** Sleep until the given ISO instant (no-op if already past). Durable under Temporal. */
  sleepUntil(iso: string): Promise<void>;
}

/**
 * A virtual-clock runtime for tests and simulation. `sleepUntil` advances the clock
 * instead of blocking, and records each sleep so tests can assert the schedule.
 */
export class InMemoryRuntime implements SchedulerRuntime {
  private clock: number;
  readonly sleeps: Array<{ from: string; to: string }> = [];

  constructor(startIso: string) {
    this.clock = Date.parse(startIso);
  }

  now(): string {
    return new Date(this.clock).toISOString();
  }

  async sleepUntil(iso: string): Promise<void> {
    const target = Date.parse(iso);
    if (Number.isFinite(target) && target > this.clock) {
      this.sleeps.push({ from: new Date(this.clock).toISOString(), to: new Date(target).toISOString() });
      this.clock = target;
    }
  }
}
