import {
  createHomeRefreshCoordinator,
  type HomeRefreshCoordinatorEvent,
  type HomeRefreshRunContext,
} from './homeRefreshCoordinator';

function makeDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('Home refresh coordinator — epoch-aware coalescing', () => {
  it('focus + pathname same transition => heavy refresh once', async () => {
    let runs = 0;
    const deferred = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      coalesceDelayMs: 0,
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async () => {
        runs += 1;
        await deferred.promise;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    coordinator.requestVisibleRefresh('pathname');
    expect(runs).toBe(0);
    flushHolder.flush?.();
    expect(runs).toBe(1);
    deferred.resolve();
    await flushMicrotasks();
    expect(runs).toBe(1);
    const started = coordinator
      .getEventsForTests()
      .filter((e) => e.type === 'started');
    expect(started).toHaveLength(1);
    expect(
      (started[0] as Extract<HomeRefreshCoordinatorEvent, { type: 'started' }>)
        .triggers
    ).toEqual(expect.arrayContaining(['focus', 'pathname']));
  });

  it('pathname then focus same transition => exactly once', () => {
    let runs = 0;
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: () => {
        runs += 1;
      },
    });
    coordinator.requestVisibleRefresh('pathname');
    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    expect(runs).toBe(1);
  });

  it('cold mount dual trigger => exactly once', () => {
    let runs = 0;
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: () => {
        runs += 1;
      },
    });
    coordinator.requestVisibleRefresh('cold');
    coordinator.requestVisibleRefresh('pathname');
    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    expect(runs).toBe(1);
    expect(
      coordinator.getEventsForTests().filter((e) => e.type === 'coalesced')
    ).toHaveLength(2);
  });

  it('same-epoch delayed pathname AFTER run started => no trailing', async () => {
    let runs = 0;
    const a = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async () => {
        runs += 1;
        await a.promise;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    expect(runs).toBe(1);

    coordinator.requestVisibleRefresh('pathname');
    expect(coordinator.hasPendingTrailing()).toBe(false);
    expect(coordinator.hasPendingNewerVisibility()).toBe(false);
    expect(
      coordinator.getEventsForTests().filter((e) => e.type === 'queued_trailing')
    ).toHaveLength(0);
    expect(
      coordinator.getEventsForTests().filter(
        (e) => e.type === 'coalesced' && e.into.phase === 'active_run'
      )
    ).toHaveLength(1);

    a.resolve();
    await flushMicrotasks();
    expect(runs).toBe(1);
  });

  it('truth refresh while A running => one bounded trailing', async () => {
    let runs = 0;
    const a = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async () => {
        runs += 1;
        if (runs === 1) await a.promise;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    expect(runs).toBe(1);

    coordinator.requestTruthRefresh('data');
    coordinator.requestTruthRefresh('data');
    expect(coordinator.hasPendingTrailing()).toBe(true);
    expect(runs).toBe(1);

    a.resolve();
    await flushMicrotasks();
    expect(runs).toBe(2);
  });

  it('three duplicate visibility triggers same transition => one full refresh', () => {
    let runs = 0;
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: () => {
        runs += 1;
      },
    });
    coordinator.requestVisibleRefresh('focus');
    coordinator.requestVisibleRefresh('pathname');
    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    expect(runs).toBe(1);
  });

  it('hidden before scheduled start => no heavy run; re-show => one fresh run', () => {
    let runs = 0;
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: () => {
        runs += 1;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    expect(runs).toBe(0);
    coordinator.markHomeHidden();
    flushHolder.flush?.();
    expect(runs).toBe(0);

    coordinator.requestVisibleRefresh('pathname');
    flushHolder.flush?.();
    expect(runs).toBe(1);
  });

  it('hidden during run => cannot apply; re-show while A running starts B after A', async () => {
    let runs = 0;
    let lastCtx: HomeRefreshRunContext | null = null;
    const a = makeDeferred();
    const b = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async (ctx) => {
        runs += 1;
        lastCtx = ctx;
        if (runs === 1) await a.promise;
        else await b.promise;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    expect(runs).toBe(1);
    const epochA = lastCtx!.visibilityEpoch;

    coordinator.markHomeHidden();
    coordinator.requestVisibleRefresh('focus');
    expect(runs).toBe(1);
    expect(coordinator.hasPendingNewerVisibility()).toBe(true);

    a.resolve();
    await flushMicrotasks();
    expect(runs).toBe(2);
    expect(lastCtx!.visibilityEpoch).not.toBe(epochA);
    expect(lastCtx!.canApply()).toBe(true);
    b.resolve();
    await flushMicrotasks();
  });

  it('dispose cancels scheduled work and blocks later starts/trailing', async () => {
    let runs = 0;
    const a = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async () => {
        runs += 1;
        await a.promise;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    coordinator.dispose();
    flushHolder.flush?.();
    expect(runs).toBe(0);
    expect(coordinator.isDisposed()).toBe(true);

    coordinator.requestVisibleRefresh('pathname');
    coordinator.requestTruthRefresh('data');
    expect(runs).toBe(0);
  });

  it('dispose during active run => completion cannot apply', async () => {
    let runs = 0;
    let ctx: HomeRefreshRunContext | null = null;
    const a = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async (runCtx) => {
        runs += 1;
        ctx = runCtx;
        await a.promise;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    coordinator.dispose();
    a.resolve();
    await flushMicrotasks();
    expect(runs).toBe(1);
    expect(ctx!.canApply()).toBe(false);
    expect(coordinator.hasPendingTrailing()).toBe(false);
    expect(coordinator.hasPendingNewerVisibility()).toBe(false);
  });
});

describe('Home refresh coordinator — pending newer visibility epoch', () => {
  it('Codex blocker: A running → hide → show B → A finishes → exactly one B', async () => {
    let runs = 0;
    const epochs: number[] = [];
    const a = makeDeferred();
    const b = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async (ctx) => {
        runs += 1;
        epochs.push(ctx.visibilityEpoch);
        if (runs === 1) await a.promise;
        else await b.promise;
      },
    });

    // 1–3: show A, start heavy run A
    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    expect(runs).toBe(1);
    const epochA = epochs[0]!;

    // 4–6: hide, show B, request while A unresolved
    coordinator.markHomeHidden();
    coordinator.requestVisibleRefresh('pathname');
    coordinator.requestVisibleRefresh('focus');
    expect(runs).toBe(1);
    expect(coordinator.hasPendingNewerVisibility()).toBe(true);
    expect(
      coordinator
        .getEventsForTests()
        .filter((e) => e.type === 'pending_newer_visibility')
    ).toHaveLength(1);

    // 8–9: resolve A → exactly one B
    a.resolve();
    await flushMicrotasks();
    expect(runs).toBe(2);
    expect(epochs[1]).not.toBe(epochA);
    expect(coordinator.isEpochActive(epochs[1]!)).toBe(true);

    // 10–11: B applicable
    expect(
      coordinator.getEventsForTests().filter((e) => e.type === 'started')
    ).toHaveLength(2);
    b.resolve();
    await flushMicrotasks();
    const completed = coordinator
      .getEventsForTests()
      .filter((e) => e.type === 'completed') as Extract<
      HomeRefreshCoordinatorEvent,
      { type: 'completed' }
    >[];
    expect(completed[0]?.applied).toBe(false);
    expect(completed[1]?.applied).toBe(true);
  });

  it('A: same-epoch delayed duplicate while running => still 1 run total', async () => {
    let runs = 0;
    const a = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async () => {
        runs += 1;
        await a.promise;
      },
    });
    coordinator.requestVisibleRefresh('cold');
    flushHolder.flush?.();
    coordinator.requestVisibleRefresh('pathname');
    coordinator.requestVisibleRefresh('focus');
    expect(coordinator.hasPendingNewerVisibility()).toBe(false);
    a.resolve();
    await flushMicrotasks();
    expect(runs).toBe(1);
  });

  it('B: A running → B pending → B hidden => B never starts', async () => {
    let runs = 0;
    const a = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async () => {
        runs += 1;
        await a.promise;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    coordinator.markHomeHidden();
    coordinator.requestVisibleRefresh('focus');
    expect(coordinator.hasPendingNewerVisibility()).toBe(true);

    coordinator.markHomeHidden();
    expect(coordinator.hasPendingNewerVisibility()).toBe(false);

    a.resolve();
    await flushMicrotasks();
    expect(runs).toBe(1);
    expect(coordinator.isBusy()).toBe(false);
  });

  it('C: A running → B pending → C replaces B => only C after A', async () => {
    let runs = 0;
    const epochs: number[] = [];
    const a = makeDeferred();
    const c = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async (ctx) => {
        runs += 1;
        epochs.push(ctx.visibilityEpoch);
        if (runs === 1) await a.promise;
        else await c.promise;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    const epochA = epochs[0]!;

    coordinator.markHomeHidden();
    coordinator.requestVisibleRefresh('focus'); // B pending
    const epochB = coordinator.getActiveVisibilityEpoch();
    expect(epochB).not.toBe(epochA);
    expect(coordinator.hasPendingNewerVisibility()).toBe(true);

    coordinator.markHomeHidden();
    coordinator.requestVisibleRefresh('pathname'); // C pending
    const epochC = coordinator.getActiveVisibilityEpoch();
    expect(epochC).not.toBe(epochB);
    expect(coordinator.hasPendingNewerVisibility()).toBe(true);

    a.resolve();
    await flushMicrotasks();
    expect(runs).toBe(2);
    expect(epochs).toEqual([epochA, epochC]);
    expect(epochs).not.toContain(epochB);
    c.resolve();
    await flushMicrotasks();
  });

  it('D: dispose with pending newer epoch => nothing starts afterward', async () => {
    let runs = 0;
    const a = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async () => {
        runs += 1;
        await a.promise;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    coordinator.markHomeHidden();
    coordinator.requestVisibleRefresh('focus');
    expect(coordinator.hasPendingNewerVisibility()).toBe(true);

    coordinator.dispose();
    expect(coordinator.hasPendingNewerVisibility()).toBe(false);

    a.resolve();
    await flushMicrotasks();
    expect(runs).toBe(1);

    coordinator.requestVisibleRefresh('pathname');
    expect(runs).toBe(1);
  });

  it('E: multiple focus/pathname for pending B => still exactly one B refresh', async () => {
    let runs = 0;
    const a = makeDeferred();
    const b = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async () => {
        runs += 1;
        if (runs === 1) await a.promise;
        else await b.promise;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    coordinator.markHomeHidden();
    coordinator.requestVisibleRefresh('focus');
    coordinator.requestVisibleRefresh('pathname');
    coordinator.requestVisibleRefresh('cold');
    expect(coordinator.hasPendingNewerVisibility()).toBe(true);
    expect(
      coordinator
        .getEventsForTests()
        .filter((e) => e.type === 'pending_newer_visibility')
    ).toHaveLength(1);
    expect(
      coordinator
        .getEventsForTests()
        .filter(
          (e) =>
            e.type === 'coalesced' &&
            e.into.phase === 'pending_newer_visibility'
        )
    ).toHaveLength(2);

    a.resolve();
    await flushMicrotasks();
    expect(runs).toBe(2);
    b.resolve();
    await flushMicrotasks();
    expect(runs).toBe(2);
  });

  it('newer visibility pending discards stale same-epoch truth trailing', async () => {
    let runs = 0;
    const epochs: number[] = [];
    const a = makeDeferred();
    const next = makeDeferred();
    const flushHolder: { flush: (() => void) | null } = { flush: null };
    const coordinator = createHomeRefreshCoordinator({
      schedule: (cb) => {
        flushHolder.flush = cb;
        return { cancel: () => undefined };
      },
      runRefresh: async (ctx) => {
        runs += 1;
        epochs.push(ctx.visibilityEpoch);
        if (runs === 1) await a.promise;
        else await next.promise;
      },
    });

    coordinator.requestVisibleRefresh('focus');
    flushHolder.flush?.();
    const epochA = epochs[0]!;
    coordinator.requestTruthRefresh('data');
    expect(coordinator.hasPendingTrailing()).toBe(true);

    coordinator.markHomeHidden();
    expect(coordinator.hasPendingTrailing()).toBe(false);
    coordinator.requestVisibleRefresh('focus');
    expect(coordinator.hasPendingNewerVisibility()).toBe(true);
    expect(coordinator.hasPendingTrailing()).toBe(false);

    a.resolve();
    await flushMicrotasks();
    expect(runs).toBe(2);
    expect(epochs[1]).not.toBe(epochA);
    next.resolve();
    await flushMicrotasks();
  });
});
