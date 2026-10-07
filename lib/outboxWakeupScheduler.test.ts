import {
  OutboxWakeupScheduler,
  planOutboxWakeup,
  type OutboxWakeupClock,
  type TimerHandle,
} from './outboxWakeupScheduler';

type FakeClock = OutboxWakeupClock & {
  advance(ms: number): void;
  pendingDelays(): number[];
};

function createFakeClock(start = 1_000_000): FakeClock {
  let now = start;
  let nextId = 1;
  const entries: { id: number; at: number; delay: number; cb: () => void }[] = [];
  const clock: FakeClock = {
    now: () => now,
    setTimeout(callback, delayMs) {
      if (delayMs < 0) throw new Error(`negative delay ${delayMs}`);
      const id = nextId++;
      entries.push({ id, at: now + delayMs, delay: delayMs, cb: callback });
      return id as unknown as TimerHandle;
    },
    clearTimeout(handle) {
      const id = handle as unknown as number;
      const index = entries.findIndex((entry) => entry.id === id);
      if (index >= 0) entries.splice(index, 1);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = entries
          .filter((entry) => entry.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id);
        const next = due[0];
        if (!next) break;
        now = next.at;
        const index = entries.findIndex((entry) => entry.id === next.id);
        if (index >= 0) entries.splice(index, 1);
        next.cb();
      }
      now = target;
    },
    pendingDelays() {
      return entries.map((entry) => entry.delay);
    },
  };
  return clock;
}

describe('planOutboxWakeup', () => {
  const base = {
    nowMs: 1_000,
    earliestRetryAt: 1_000,
    earliestToken: 'row',
    foreground: true,
    eligible: true,
    workerRunning: false,
    armedDeadline: null as number | null,
    suppressedToken: null as string | null,
  };

  it('arms an immediate wakeup for an overdue retry without a negative delay', () => {
    const plan = planOutboxWakeup({ ...base, earliestRetryAt: 900 });
    expect(plan).toEqual({ action: 'arm', deadline: 900, delayMs: 0 });
  });

  it('arms one timer for a future deadline', () => {
    const plan = planOutboxWakeup({ ...base, earliestRetryAt: base.nowMs + 30_000 });
    expect(plan).toEqual({
      action: 'arm',
      deadline: base.nowMs + 30_000,
      delayMs: 30_000,
    });
  });

  it('cancels when nothing is pending', () => {
    expect(planOutboxWakeup({ ...base, earliestRetryAt: null, earliestToken: null })).toEqual({
      action: 'cancel',
    });
  });

  it('defers while a worker is already running', () => {
    expect(planOutboxWakeup({ ...base, workerRunning: true })).toEqual({ action: 'defer' });
  });

  it('keeps an existing timer for the same deadline', () => {
    expect(
      planOutboxWakeup({
        ...base,
        earliestRetryAt: base.nowMs + 60_000,
        armedDeadline: base.nowMs + 60_000,
      })
    ).toEqual({ action: 'keep' });
  });

  it('suppresses an unchanged overdue token', () => {
    expect(
      planOutboxWakeup({
        ...base,
        earliestRetryAt: 900,
        earliestToken: 'same',
        suppressedToken: 'same',
      })
    ).toEqual({ action: 'suppress' });
  });

  it('cancels outside the foreground', () => {
    expect(planOutboxWakeup({ ...base, foreground: false })).toEqual({ action: 'cancel' });
  });
});

describe('OutboxWakeupScheduler', () => {
  it('fires an overdue wakeup once and does not spin when the token is unchanged', () => {
    const clock = createFakeClock();
    const fires: number[] = [];
    const scheduler = new OutboxWakeupScheduler(clock, (deadline) => {
      fires.push(deadline ?? -1);
    });
    const now = clock.now();
    const token = 'receipt\0intent\0' + (now - 5);

    expect(
      scheduler.reevaluate({
        nowMs: now,
        earliestRetryAt: now - 5,
        earliestToken: token,
        foreground: true,
        eligible: true,
        workerRunning: false,
      })
    ).toMatchObject({ action: 'arm', delayMs: 0 });
    expect(clock.pendingDelays()).toEqual([0]);

    clock.advance(0);
    expect(fires).toEqual([now - 5]);

    scheduler.queueSuppressIfUnchanged(token);
    expect(
      scheduler.reevaluate({
        nowMs: clock.now(),
        earliestRetryAt: now - 5,
        earliestToken: token,
        foreground: true,
        eligible: true,
        workerRunning: false,
      }).action
    ).toBe('suppress');
    expect(scheduler.hasTimer()).toBe(false);

    scheduler.reevaluate({
      nowMs: clock.now(),
      earliestRetryAt: now - 5,
      earliestToken: token,
      foreground: true,
      eligible: true,
      workerRunning: false,
    });
    expect(scheduler.hasTimer()).toBe(false);
    clock.advance(10_000);
    expect(fires).toHaveLength(1);
  });

  it('waits for a +30s deadline, fires once, then clears the timer', () => {
    const clock = createFakeClock();
    const fires: number[] = [];
    const scheduler = new OutboxWakeupScheduler(clock, (deadline) => {
      fires.push(deadline ?? -1);
    });
    const now = clock.now();
    scheduler.reevaluate({
      nowMs: now,
      earliestRetryAt: now + 30_000,
      earliestToken: 'future',
      foreground: true,
      eligible: true,
      workerRunning: false,
    });
    clock.advance(29_000);
    expect(fires).toEqual([]);
    expect(scheduler.hasTimer()).toBe(true);
    clock.advance(1_000);
    expect(fires).toEqual([now + 30_000]);
    expect(scheduler.hasTimer()).toBe(false);

    scheduler.reevaluate({
      nowMs: clock.now(),
      earliestRetryAt: null,
      earliestToken: null,
      foreground: true,
      eligible: true,
      workerRunning: false,
    });
    expect(scheduler.hasTimer()).toBe(false);
  });

  it('replaces a +60s timer with +10s, then restores the later deadline', () => {
    const clock = createFakeClock();
    const scheduler = new OutboxWakeupScheduler(clock, () => {});
    const now = clock.now();
    scheduler.reevaluate({
      nowMs: now,
      earliestRetryAt: now + 60_000,
      earliestToken: 'A',
      foreground: true,
      eligible: true,
      workerRunning: false,
    });
    expect(clock.pendingDelays()).toEqual([60_000]);

    scheduler.reevaluate({
      nowMs: now,
      earliestRetryAt: now + 10_000,
      earliestToken: 'B',
      foreground: true,
      eligible: true,
      workerRunning: false,
    });
    expect(clock.pendingDelays()).toEqual([10_000]);
    expect(scheduler.pendingDeadline()).toBe(now + 10_000);

    scheduler.reevaluate({
      nowMs: now,
      earliestRetryAt: now + 60_000,
      earliestToken: 'A',
      foreground: true,
      eligible: true,
      workerRunning: false,
    });
    expect(clock.pendingDelays()).toEqual([60_000]);
  });

  it('schedules the future backoff after a failed overdue attempt advances the token', () => {
    const clock = createFakeClock();
    let runs = 0;
    const scheduler = new OutboxWakeupScheduler(clock, () => {
      runs += 1;
    });
    const now = clock.now();
    const overdueToken = 'row\0intent\0' + (now - 1);
    scheduler.reevaluate({
      nowMs: now,
      earliestRetryAt: now - 1,
      earliestToken: overdueToken,
      foreground: true,
      eligible: true,
      workerRunning: false,
    });
    clock.advance(0);
    expect(runs).toBe(1);

    const futureToken = 'row\0intent\0' + (now + 30_000);
    scheduler.queueSuppressIfUnchanged(overdueToken);
    const plan = scheduler.reevaluate({
      nowMs: now,
      earliestRetryAt: now + 30_000,
      earliestToken: futureToken,
      foreground: true,
      eligible: true,
      workerRunning: false,
    });
    expect(plan).toMatchObject({ action: 'arm', delayMs: 30_000 });
    expect(clock.pendingDelays()).toEqual([30_000]);
    clock.advance(1);
    expect(runs).toBe(1);
  });

  it('cancels the timer outside the foreground and does not keep a second timer', () => {
    const clock = createFakeClock();
    const scheduler = new OutboxWakeupScheduler(clock, () => {});
    const now = clock.now();
    scheduler.reevaluate({
      nowMs: now,
      earliestRetryAt: now + 30_000,
      earliestToken: 'A',
      foreground: true,
      eligible: true,
      workerRunning: false,
    });
    expect(
      scheduler.reevaluate({
        nowMs: now,
        earliestRetryAt: now + 30_000,
        earliestToken: 'A',
        foreground: false,
        eligible: true,
        workerRunning: false,
      }).action
    ).toBe('cancel');
    expect(scheduler.hasTimer()).toBe(false);
    expect(clock.pendingDelays()).toEqual([]);
  });

  it('does not arm a second timer while the worker is running', () => {
    const clock = createFakeClock();
    const scheduler = new OutboxWakeupScheduler(clock, () => {});
    const now = clock.now();
    scheduler.reevaluate({
      nowMs: now,
      earliestRetryAt: now + 30_000,
      earliestToken: 'A',
      foreground: true,
      eligible: true,
      workerRunning: false,
    });
    expect(
      scheduler.reevaluate({
        nowMs: now,
        earliestRetryAt: now - 1,
        earliestToken: 'B',
        foreground: true,
        eligible: true,
        workerRunning: true,
      }).action
    ).toBe('defer');
    expect(clock.pendingDelays()).toEqual([30_000]);
  });

  it('repeated schedule calls for the same deadline stay idempotent', () => {
    const clock = createFakeClock();
    const scheduler = new OutboxWakeupScheduler(clock, () => {});
    const now = clock.now();
    const input = {
      nowMs: now,
      earliestRetryAt: now + 30_000,
      earliestToken: 'A',
      foreground: true,
      eligible: true,
      workerRunning: false,
    };
    expect(scheduler.reevaluate(input).action).toBe('arm');
    expect(scheduler.reevaluate(input).action).toBe('keep');
    expect(clock.pendingDelays()).toEqual([30_000]);
  });
});
