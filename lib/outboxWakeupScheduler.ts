/**
 * Deadline scheduler for sync_outbox retries.
 * One timer. The worker still owns network mutation and backoff.
 */

export const OUTBOX_WAKEUP_MAX_DELAY_MS = 60 * 60 * 1000;

export type TimerHandle = ReturnType<typeof setTimeout>;

export type OutboxWakeupClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

export type OutboxWakeupPlan =
  | { action: 'cancel' }
  | { action: 'keep' }
  | { action: 'defer' }
  | { action: 'suppress' }
  | { action: 'arm'; deadline: number; delayMs: number };

export function planOutboxWakeup(input: {
  nowMs: number;
  earliestRetryAt: number | null;
  earliestToken: string | null;
  foreground: boolean;
  eligible: boolean;
  workerRunning: boolean;
  armedDeadline: number | null;
  suppressedToken: string | null;
}): OutboxWakeupPlan {
  if (!input.foreground || !input.eligible) return { action: 'cancel' };
  if (input.earliestRetryAt == null || !Number.isFinite(input.earliestRetryAt)) {
    return { action: 'cancel' };
  }
  if (input.workerRunning) return { action: 'defer' };

  if (input.earliestRetryAt <= input.nowMs) {
    if (
      input.suppressedToken != null &&
      input.earliestToken != null &&
      input.suppressedToken === input.earliestToken
    ) {
      return { action: 'suppress' };
    }
    if (input.armedDeadline === input.earliestRetryAt) return { action: 'keep' };
    return { action: 'arm', deadline: input.earliestRetryAt, delayMs: 0 };
  }

  const rawDelay = input.earliestRetryAt - input.nowMs;
  const delayMs = Math.min(Math.max(0, rawDelay), OUTBOX_WAKEUP_MAX_DELAY_MS);
  if (input.armedDeadline === input.earliestRetryAt) return { action: 'keep' };
  return { action: 'arm', deadline: input.earliestRetryAt, delayMs };
}

export class OutboxWakeupScheduler {
  private timer: TimerHandle | null = null;
  private armedDeadline: number | null = null;
  private suppressedToken: string | null = null;
  private suppressNextToken: string | null = null;

  constructor(
    private readonly clock: OutboxWakeupClock,
    private readonly onFire: (deadline: number | null) => void
  ) {}

  hasTimer(): boolean {
    return this.timer != null;
  }

  pendingDeadline(): number | null {
    return this.armedDeadline;
  }

  cancel(): void {
    if (this.timer != null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.armedDeadline = null;
  }

  clearSuppression(): void {
    this.suppressedToken = null;
    this.suppressNextToken = null;
  }

  /** After a wakeup, suppress only if this same overdue intent is still unchanged. */
  queueSuppressIfUnchanged(token: string): void {
    this.suppressNextToken = token;
  }

  reevaluate(input: {
    nowMs: number;
    earliestRetryAt: number | null;
    earliestToken: string | null;
    foreground: boolean;
    eligible: boolean;
    workerRunning: boolean;
  }): OutboxWakeupPlan {
    const oneShot = this.suppressNextToken;
    this.suppressNextToken = null;

    let suppressedToken = this.suppressedToken;
    if (oneShot) {
      const unchangedOverdue =
        input.earliestToken != null &&
        oneShot === input.earliestToken &&
        input.earliestRetryAt != null &&
        input.earliestRetryAt <= input.nowMs;
      if (unchangedOverdue) {
        this.suppressedToken = oneShot;
        suppressedToken = oneShot;
      } else {
        this.suppressedToken = null;
        suppressedToken = null;
      }
    }

    const plan = planOutboxWakeup({
      ...input,
      armedDeadline: this.armedDeadline,
      suppressedToken,
    });

    if (plan.action === 'cancel') {
      this.cancel();
      this.suppressedToken = null;
      return plan;
    }
    if (plan.action === 'suppress') {
      this.cancel();
      return plan;
    }
    if (plan.action === 'defer' || plan.action === 'keep') return plan;

    this.cancel();
    this.suppressedToken = null;
    this.armedDeadline = plan.deadline;
    const delayMs = plan.delayMs < 0 ? 0 : plan.delayMs;
    this.timer = this.clock.setTimeout(() => {
      const fired = this.armedDeadline;
      this.timer = null;
      this.armedDeadline = null;
      this.onFire(fired);
    }, delayMs);
    return { action: 'arm', deadline: plan.deadline, delayMs };
  }
}
