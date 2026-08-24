import { logger } from './logger';

export const HOME_COLD_START_TIMING_STORAGE_KEY =
  'diagnostics.homeColdStartTiming.v1';
export const HOME_COLD_START_TIMING_VERSION = 1;
export const HOME_COLD_START_TIMING_LIMIT = 10;

export type HomeColdStartTimingOutcome = 'success' | 'failure';

export type HomeColdStartTimingPhase =
  | 'sqliteInitialization'
  | 'initialReceiptRead'
  | 'initialAnalyticsSelection'
  | 'engagementTotal'
  | 'productContextReceiptRead'
  | 'productContextDuplicateSelection'
  | 'productContextItemIndexRead'
  | 'productContextTotal'
  | 'homeBuildTotal'
  | 'identityFrequentTotal'
  | 'identityResolution'
  | 'frequentAggregation'
  | 'totalToSnapshotPublication'
  | 'totalToFirstCompleteFrame';

export type HomeColdStartTimingCounts = Record<string, number>;

export type HomeColdStartTimingPhaseResult = {
  durationMs: number;
  counts?: HomeColdStartTimingCounts;
};

export type HomeColdStartTimingSummary = {
  version: typeof HOME_COLD_START_TIMING_VERSION;
  correlationId: string;
  startedAtEpochMs: number;
  completedAtEpochMs: number;
  outcome: HomeColdStartTimingOutcome;
  phases: Partial<
    Record<HomeColdStartTimingPhase, HomeColdStartTimingPhaseResult>
  >;
};

export type HomeColdStartTimingHandle = {
  correlationId: string;
};

type MutableHomeColdStartTiming = {
  handle: HomeColdStartTimingHandle;
  startedAtEpochMs: number;
  startedAtMonotonicMs: number;
  phases: HomeColdStartTimingSummary['phases'];
  finalized: boolean;
};

type TimingStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

let activeTiming: MutableHomeColdStartTiming | null = null;
let completedForProcess = false;
let correlationSequence = 0;

export function monotonicNowMs(): number {
  const now = globalThis.performance?.now?.();
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
}

function roundedDuration(durationMs: number): number {
  return Math.round(Math.max(0, durationMs) * 10) / 10;
}

function sanitizeCounts(
  counts: HomeColdStartTimingCounts | undefined
): HomeColdStartTimingCounts | undefined {
  if (!counts) return undefined;
  const safe: HomeColdStartTimingCounts = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      safe[key] = Math.max(0, Math.round(value));
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function beginHomeColdStartTiming(): HomeColdStartTimingHandle | null {
  if (completedForProcess) return null;
  if (activeTiming) return activeTiming.handle;

  correlationSequence += 1;
  const startedAtEpochMs = Date.now();
  const handle = {
    correlationId: `home-cold-${startedAtEpochMs.toString(36)}-${correlationSequence}`,
  };
  activeTiming = {
    handle,
    startedAtEpochMs,
    startedAtMonotonicMs: monotonicNowMs(),
    phases: {},
    finalized: false,
  };
  return handle;
}

function activeTimingFor(
  handle?: HomeColdStartTimingHandle | null
): MutableHomeColdStartTiming | null {
  if (!activeTiming || activeTiming.finalized) return null;
  if (handle && activeTiming.handle.correlationId !== handle.correlationId) {
    return null;
  }
  return activeTiming;
}

export function recordHomeColdStartPhase(
  phase: HomeColdStartTimingPhase,
  durationMs: number,
  counts?: HomeColdStartTimingCounts
): void {
  const timing = activeTimingFor();
  if (!timing) return;
  const safeCounts = sanitizeCounts(counts);
  timing.phases[phase] = {
    durationMs: roundedDuration(durationMs),
    ...(safeCounts ? { counts: safeCounts } : {}),
  };
}

export function measureHomeColdStartSync<T>(
  phase: HomeColdStartTimingPhase,
  operation: () => T,
  counts?: (result: T) => HomeColdStartTimingCounts | undefined
): T {
  const timing = activeTimingFor();
  if (!timing) return operation();
  const startedAt = monotonicNowMs();
  const result = operation();
  recordHomeColdStartPhase(
    phase,
    monotonicNowMs() - startedAt,
    counts?.(result)
  );
  return result;
}

export async function measureHomeColdStartAsync<T>(
  phase: HomeColdStartTimingPhase,
  operation: () => Promise<T>,
  counts?: (result: T) => HomeColdStartTimingCounts | undefined
): Promise<T> {
  const timing = activeTimingFor();
  if (!timing) return operation();
  const startedAt = monotonicNowMs();
  const result = await operation();
  recordHomeColdStartPhase(
    phase,
    monotonicNowMs() - startedAt,
    counts?.(result)
  );
  return result;
}

export function markHomeColdStartSnapshotPublished(
  handle: HomeColdStartTimingHandle | null,
  counts?: HomeColdStartTimingCounts
): void {
  const timing = activeTimingFor(handle);
  if (!timing) return;
  recordHomeColdStartPhase(
    'totalToSnapshotPublication',
    monotonicNowMs() - timing.startedAtMonotonicMs,
    counts
  );
}

async function defaultTimingStorage(): Promise<TimingStorage> {
  const module = await import('@react-native-async-storage/async-storage');
  return module.default;
}

export function parseHomeColdStartTimingSummaries(
  raw: string | null
): HomeColdStartTimingSummary[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is HomeColdStartTimingSummary =>
          entry != null &&
          typeof entry === 'object' &&
          entry.version === HOME_COLD_START_TIMING_VERSION &&
          typeof entry.correlationId === 'string' &&
          typeof entry.startedAtEpochMs === 'number' &&
          typeof entry.completedAtEpochMs === 'number' &&
          (entry.outcome === 'success' || entry.outcome === 'failure') &&
          entry.phases != null &&
          typeof entry.phases === 'object'
      )
      .slice(-HOME_COLD_START_TIMING_LIMIT);
  } catch {
    return [];
  }
}

export async function appendHomeColdStartTimingSummary(
  summary: HomeColdStartTimingSummary,
  storage?: TimingStorage
): Promise<void> {
  const target = storage ?? (await defaultTimingStorage());
  const existing = parseHomeColdStartTimingSummaries(
    await target.getItem(HOME_COLD_START_TIMING_STORAGE_KEY)
  );
  const next = [...existing, summary].slice(-HOME_COLD_START_TIMING_LIMIT);
  await target.setItem(HOME_COLD_START_TIMING_STORAGE_KEY, JSON.stringify(next));
}

export async function readHomeColdStartTimingSummaries(
  storage?: TimingStorage
): Promise<HomeColdStartTimingSummary[]> {
  const target = storage ?? (await defaultTimingStorage());
  return parseHomeColdStartTimingSummaries(
    await target.getItem(HOME_COLD_START_TIMING_STORAGE_KEY)
  );
}

function finalizeHomeColdStartTiming(
  handle: HomeColdStartTimingHandle | null,
  outcome: HomeColdStartTimingOutcome
): HomeColdStartTimingSummary | null {
  const timing = activeTimingFor(handle);
  if (!timing) return null;
  timing.finalized = true;
  completedForProcess = true;
  const summary: HomeColdStartTimingSummary = {
    version: HOME_COLD_START_TIMING_VERSION,
    correlationId: timing.handle.correlationId,
    startedAtEpochMs: timing.startedAtEpochMs,
    completedAtEpochMs: Date.now(),
    outcome,
    phases: { ...timing.phases },
  };
  activeTiming = null;
  logger.info('HomeColdStartTiming', 'summary', summary);
  void appendHomeColdStartTimingSummary(summary).catch((error) => {
    logger.warn('HomeColdStartTiming', 'local_summary_write_failed', { error });
  });
  return summary;
}

export function finishHomeColdStartTimingAfterFrame(
  handle: HomeColdStartTimingHandle | null
): void {
  const timing = activeTimingFor(handle);
  if (!timing) return;

  const finish = () => {
    const current = activeTimingFor(handle);
    if (!current) return;
    recordHomeColdStartPhase(
      'totalToFirstCompleteFrame',
      monotonicNowMs() - current.startedAtMonotonicMs
    );
    finalizeHomeColdStartTiming(handle, 'success');
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(finish));
  } else {
    setTimeout(finish, 0);
  }
}

export function failHomeColdStartTiming(
  handle: HomeColdStartTimingHandle | null
): void {
  const timing = activeTimingFor(handle);
  if (!timing) return;
  if (!timing.phases.totalToSnapshotPublication) {
    recordHomeColdStartPhase(
      'totalToSnapshotPublication',
      monotonicNowMs() - timing.startedAtMonotonicMs
    );
  }
  finalizeHomeColdStartTiming(handle, 'failure');
}

export function getActiveHomeColdStartTimingSnapshotForTests(): {
  correlationId: string;
  phases: HomeColdStartTimingSummary['phases'];
} | null {
  const timing = activeTimingFor();
  return timing
    ? {
        correlationId: timing.handle.correlationId,
        phases: { ...timing.phases },
      }
    : null;
}

export function resetHomeColdStartTimingForTests(): void {
  activeTiming = null;
  completedForProcess = false;
  correlationSequence = 0;
}
