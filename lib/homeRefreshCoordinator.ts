/**
 * Home visibility refresh coordinator (P1A final race fix).
 *
 * Visibility epoch = one continuous Home-visible lifetime.
 * Within an epoch, focus/pathname/cold coalesce and never spawn a trailing run
 * merely because a callback arrived after the heavy run started.
 *
 * If a NEWER visibility epoch requests refresh while an OLDER epoch run is still
 * active, retain exactly ONE pending newer-visibility refresh and start it after
 * the old run finishes (serialized — never parallel).
 *
 * Same-epoch requestTruthRefresh may queue ONE bounded trailing truth refresh,
 * which is discarded if a newer visibility epoch becomes authoritative.
 */

export type HomeVisibilityTrigger = 'focus' | 'pathname' | 'cold';

/** Explicit newer-truth refresh while Home remains visible. */
export type HomeTruthRefreshTrigger = 'data' | 'manual';

export type HomeRefreshTrigger =
  | HomeVisibilityTrigger
  | HomeTruthRefreshTrigger
  | 'trailing';

export type HomeRefreshRunContext = {
  runId: number;
  visibilityEpoch: number;
  /** False when epoch is hidden/inactive, superseded, or coordinator disposed. */
  canApply: () => boolean;
};

export type HomeRefreshCoordinatorEvent =
  | {
      type: 'requested';
      requestId: number;
      trigger: HomeRefreshTrigger;
      kind: 'visibility' | 'truth';
      visibilityEpoch: number;
    }
  | {
      type: 'coalesced';
      requestId: number;
      trigger: HomeRefreshTrigger;
      visibilityEpoch: number;
      into:
        | { phase: 'scheduled'; visibilityEpoch: number }
        | { phase: 'active_run'; runId: number; visibilityEpoch: number }
        | { phase: 'pending_newer_visibility'; visibilityEpoch: number };
    }
  | {
      type: 'queued_trailing';
      requestId: number;
      trigger: HomeRefreshTrigger;
      visibilityEpoch: number;
      activeRunId: number;
    }
  | {
      type: 'pending_newer_visibility';
      requestId: number;
      trigger: HomeRefreshTrigger;
      visibilityEpoch: number;
      blockedByRunId: number;
      blockedByEpoch: number;
    }
  | {
      type: 'started';
      runId: number;
      visibilityEpoch: number;
      triggers: readonly HomeRefreshTrigger[];
    }
  | {
      type: 'completed';
      runId: number;
      visibilityEpoch: number;
      applied: boolean;
    }
  | {
      type: 'cancelled_scheduled';
      visibilityEpoch: number;
      reason: 'hidden' | 'dispose';
    }
  | {
      type: 'hidden';
      visibilityEpoch: number;
    }
  | {
      type: 'disposed';
    };

export type HomeRefreshCoordinator = {
  /** Visibility trigger: focus / pathname / cold — same-epoch coalesced. */
  requestVisibleRefresh: (trigger: HomeVisibilityTrigger) => void;
  /**
   * Explicit truth-changed refresh while Home is (or becomes) visible.
   * Same-epoch duplicates collapse to one bounded trailing run if busy.
   */
  requestTruthRefresh: (trigger?: HomeTruthRefreshTrigger) => void;
  /**
   * Mark Home no longer visible. Cancels scheduled work; in-flight work may
   * finish but must not apply UI or schedule same-epoch trailing / newer pending.
   */
  markHomeHidden: () => void;
  /** Unmount / lifetime end. */
  dispose: () => void;
  getActiveVisibilityEpoch: () => number;
  isEpochActive: (epoch: number) => boolean;
  isDisposed: () => boolean;
  hasPendingTrailing: () => boolean;
  hasPendingNewerVisibility: () => boolean;
  isBusy: () => boolean;
  flushForTests: () => void;
  getEventsForTests: () => readonly HomeRefreshCoordinatorEvent[];
  resetDiagnosticsForTests: () => void;
};

export type CreateHomeRefreshCoordinatorOptions = {
  runRefresh: (ctx: HomeRefreshRunContext) => void | Promise<void>;
  coalesceDelayMs?: number;
  onEvent?: (event: HomeRefreshCoordinatorEvent) => void;
  schedule?: (cb: () => void, ms: number) => { cancel: () => void };
};

function defaultSchedule(cb: () => void, ms: number): { cancel: () => void } {
  const id = setTimeout(cb, ms);
  return { cancel: () => clearTimeout(id) };
}

export function createHomeRefreshCoordinator(
  options: CreateHomeRefreshCoordinatorOptions
): HomeRefreshCoordinator {
  const coalesceDelayMs = options.coalesceDelayMs ?? 0;
  const schedule = options.schedule ?? defaultSchedule;

  let requestSeq = 0;
  let visibilityEpoch = 0;
  let epochActive = false;
  let disposed = false;
  let runId = 0;
  let running = false;
  let activeRunId = 0;
  let activeRunEpoch = 0;
  /** Same-epoch truth trailing only. */
  let pendingTrailing = false;
  let pendingTriggers: HomeRefreshTrigger[] = [];
  /**
   * At most one pending refresh for a newer visibility epoch blocked by an
   * older in-flight run. Newest/current active epoch wins.
   */
  let pendingNewerVisibility: {
    epoch: number;
    triggers: HomeVisibilityTrigger[];
  } | null = null;
  let scheduled: { cancel: () => void; visibilityEpoch: number } | null = null;
  let events: HomeRefreshCoordinatorEvent[] = [];

  const record = (event: HomeRefreshCoordinatorEvent) => {
    events.push(event);
    options.onEvent?.(event);
  };

  const canApplyEpoch = (epoch: number) =>
    !disposed && epochActive && visibilityEpoch === epoch;

  const clearPendingNewerVisibility = () => {
    pendingNewerVisibility = null;
  };

  const cancelScheduled = (reason: 'hidden' | 'dispose') => {
    if (!scheduled) return;
    const epoch = scheduled.visibilityEpoch;
    scheduled.cancel();
    scheduled = null;
    pendingTriggers = [];
    record({ type: 'cancelled_scheduled', visibilityEpoch: epoch, reason });
  };

  const ensureVisibleEpoch = () => {
    if (disposed) return false;
    if (!epochActive) {
      visibilityEpoch += 1;
      epochActive = true;
    }
    return true;
  };

  const startRun = () => {
    if (disposed || !epochActive) {
      pendingTriggers = [];
      pendingTrailing = false;
      return;
    }
    if (running) {
      return;
    }
    const triggers =
      pendingTriggers.length > 0
        ? [...pendingTriggers]
        : (['manual'] as HomeRefreshTrigger[]);
    pendingTriggers = [];
    pendingTrailing = false;
    // Consuming a run for this epoch clears any pending tagged for it.
    if (
      pendingNewerVisibility &&
      pendingNewerVisibility.epoch === visibilityEpoch
    ) {
      clearPendingNewerVisibility();
    }
    running = true;
    activeRunId = ++runId;
    activeRunEpoch = visibilityEpoch;
    const startedEpoch = activeRunEpoch;
    const startedRunId = activeRunId;

    record({
      type: 'started',
      runId: startedRunId,
      visibilityEpoch: startedEpoch,
      triggers,
    });

    const ctx: HomeRefreshRunContext = {
      runId: startedRunId,
      visibilityEpoch: startedEpoch,
      canApply: () => canApplyEpoch(startedEpoch),
    };

    void (async () => {
      try {
        await Promise.resolve(options.runRefresh(ctx));
      } finally {
        running = false;
        const applied = canApplyEpoch(startedEpoch);
        record({
          type: 'completed',
          runId: startedRunId,
          visibilityEpoch: startedEpoch,
          applied,
        });

        if (disposed) {
          pendingTrailing = false;
          pendingTriggers = [];
          clearPendingNewerVisibility();
          return;
        }

        // Prefer newest active visibility epoch over any old-epoch truth trailing.
        if (pendingNewerVisibility) {
          const pending = pendingNewerVisibility;
          if (epochActive && visibilityEpoch === pending.epoch) {
            clearPendingNewerVisibility();
            pendingTrailing = false;
            pendingTriggers = [...pending.triggers];
            if (scheduled) {
              scheduled.cancel();
              scheduled = null;
            }
            startRun();
            return;
          }
          // Pending epoch no longer current/active — drop it.
          clearPendingNewerVisibility();
        }

        // Same-epoch truth trailing only when this run's epoch is still active.
        if (
          pendingTrailing &&
          epochActive &&
          visibilityEpoch === startedEpoch
        ) {
          pendingTrailing = false;
          if (pendingTriggers.length === 0) {
            pendingTriggers = ['trailing'];
          } else if (!pendingTriggers.includes('trailing')) {
            pendingTriggers.push('trailing');
          }
          if (scheduled) {
            scheduled.cancel();
            scheduled = null;
          }
          startRun();
          return;
        }

        pendingTrailing = false;
        if (!epochActive || visibilityEpoch !== startedEpoch) {
          pendingTriggers = [];
        }
      }
    })();
  };

  const scheduleCoalesce = () => {
    if (disposed || !epochActive || scheduled) return;
    const scheduledEpoch = visibilityEpoch;
    const handle = schedule(() => {
      scheduled = null;
      if (disposed || !epochActive || visibilityEpoch !== scheduledEpoch) {
        pendingTriggers = [];
        return;
      }
      startRun();
    }, coalesceDelayMs);
    scheduled = {
      cancel: handle.cancel,
      visibilityEpoch: scheduledEpoch,
    };
  };

  const notePendingNewerVisibility = (
    requestId: number,
    trigger: HomeVisibilityTrigger,
    epoch: number
  ) => {
    // Old-epoch truth trailing is stale once a newer visibility epoch is pending.
    pendingTrailing = false;
    pendingTriggers = [];

    if (pendingNewerVisibility && pendingNewerVisibility.epoch === epoch) {
      if (!pendingNewerVisibility.triggers.includes(trigger)) {
        pendingNewerVisibility.triggers.push(trigger);
      }
      record({
        type: 'coalesced',
        requestId,
        trigger,
        visibilityEpoch: epoch,
        into: {
          phase: 'pending_newer_visibility',
          visibilityEpoch: epoch,
        },
      });
      return;
    }

    // Newest pending wins — replace any intermediate pending epoch.
    pendingNewerVisibility = { epoch, triggers: [trigger] };
    record({
      type: 'pending_newer_visibility',
      requestId,
      trigger,
      visibilityEpoch: epoch,
      blockedByRunId: activeRunId,
      blockedByEpoch: activeRunEpoch,
    });
  };

  const requestInternal = (
    trigger: HomeRefreshTrigger,
    kind: 'visibility' | 'truth'
  ) => {
    if (disposed) return;
    if (!ensureVisibleEpoch()) return;

    const requestId = ++requestSeq;
    const epoch = visibilityEpoch;
    record({
      type: 'requested',
      requestId,
      trigger,
      kind,
      visibilityEpoch: epoch,
    });

    // Same-epoch visibility duplicate while a run is already in flight:
    // coalesce — never trailing / never pending-newer.
    if (running && kind === 'visibility' && activeRunEpoch === epoch) {
      record({
        type: 'coalesced',
        requestId,
        trigger,
        visibilityEpoch: epoch,
        into: {
          phase: 'active_run',
          runId: activeRunId,
          visibilityEpoch: activeRunEpoch,
        },
      });
      return;
    }

    if (running) {
      // Newer visibility epoch while older run occupies the slot.
      if (
        kind === 'visibility' &&
        epoch !== activeRunEpoch &&
        epochActive
      ) {
        notePendingNewerVisibility(
          requestId,
          trigger as HomeVisibilityTrigger,
          epoch
        );
        return;
      }

      // Same-epoch truth trailing only.
      if (kind === 'truth' && activeRunEpoch === epoch) {
        pendingTrailing = true;
        if (!pendingTriggers.includes(trigger)) {
          pendingTriggers.push(trigger);
        }
        record({
          type: 'queued_trailing',
          requestId,
          trigger,
          visibilityEpoch: epoch,
          activeRunId,
        });
      }
      return;
    }

    if (scheduled && scheduled.visibilityEpoch === epoch) {
      if (!pendingTriggers.includes(trigger)) {
        pendingTriggers.push(trigger);
      }
      record({
        type: 'coalesced',
        requestId,
        trigger,
        visibilityEpoch: epoch,
        into: { phase: 'scheduled', visibilityEpoch: scheduled.visibilityEpoch },
      });
      return;
    }

    pendingTriggers = [trigger];
    scheduleCoalesce();
  };

  return {
    requestVisibleRefresh(trigger: HomeVisibilityTrigger) {
      requestInternal(trigger, 'visibility');
    },

    requestTruthRefresh(trigger: HomeTruthRefreshTrigger = 'data') {
      requestInternal(trigger, 'truth');
    },

    markHomeHidden() {
      if (disposed) return;
      const epoch = visibilityEpoch;
      epochActive = false;
      pendingTrailing = false;
      pendingTriggers = [];
      clearPendingNewerVisibility();
      cancelScheduled('hidden');
      record({ type: 'hidden', visibilityEpoch: epoch });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      epochActive = false;
      pendingTrailing = false;
      pendingTriggers = [];
      clearPendingNewerVisibility();
      cancelScheduled('dispose');
      record({ type: 'disposed' });
    },

    getActiveVisibilityEpoch: () => visibilityEpoch,

    isEpochActive: (epoch: number) => canApplyEpoch(epoch),

    isDisposed: () => disposed,

    hasPendingTrailing: () => pendingTrailing,

    hasPendingNewerVisibility: () => pendingNewerVisibility != null,

    isBusy: () =>
      running || scheduled != null || pendingNewerVisibility != null,

    flushForTests() {
      if (disposed || !scheduled) return;
      const handle = scheduled;
      scheduled = null;
      handle.cancel();
      if (!epochActive || visibilityEpoch !== handle.visibilityEpoch) {
        pendingTriggers = [];
        return;
      }
      startRun();
    },

    getEventsForTests: () => events,

    resetDiagnosticsForTests() {
      events = [];
    },
  };
}
