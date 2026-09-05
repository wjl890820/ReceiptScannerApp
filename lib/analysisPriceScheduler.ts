/**
 * AP-3 scheduling helpers — first paint before CPU work; cooperative yields.
 *
 * Intentionally does not import `react-native` (Jest node env cannot parse RN).
 * Production Analysis enablement wraps with InteractionManager before calling
 * into the loader; this module adds a macrotask + rAF deferral that is safe
 * in both RN and Node tests.
 */

export type AnalysisPriceGeneration = {
  id: number;
  isCanceled: () => boolean;
  cancel: () => void;
};

let generationSeq = 0;

export function createAnalysisPriceGeneration(): AnalysisPriceGeneration {
  const id = ++generationSeq;
  let canceled = false;
  return {
    id,
    isCanceled: () => canceled || id !== generationSeq,
    cancel: () => {
      canceled = true;
    },
  };
}

/** Cancel any in-flight generation by advancing the global sequence. */
export function invalidateAnalysisPriceGenerations(): void {
  generationSeq += 1;
}

export function __resetAnalysisPriceGenerationsForTests(): void {
  generationSeq = 0;
}

/** Analysis screen focus / lifetime token (blur/unmount cancels). */
export type AnalysisPriceFocusToken = {
  id: number;
  isActive: () => boolean;
  cancel: () => void;
};

let focusSeq = 0;

export function createAnalysisPriceFocusToken(): AnalysisPriceFocusToken {
  const id = ++focusSeq;
  let active = true;
  return {
    id,
    isActive: () => active && id === focusSeq,
    cancel: () => {
      active = false;
    },
  };
}

/** Invalidate all focus tokens (e.g. Analysis blur cleanup). */
export function invalidateAnalysisPriceFocus(): void {
  focusSeq += 1;
}

export function __resetAnalysisPriceFocusForTests(): void {
  focusSeq = 0;
}

function scheduleAnimationFrame(cb: (time: number) => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(cb);
  }
  return setTimeout(() => cb(Date.now()), 0) as unknown as number;
}

function cancelScheduledFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle);
}

export type ScheduledPaintWork<T> = {
  promise: Promise<T>;
  cancel: () => void;
};

/**
 * Schedule work after a macrotask + one animation frame so Analysis can paint.
 * Cancel before start → work never runs. Pair with InteractionManager at enablement.
 */
export function scheduleAfterAnalysisFirstPaint<T>(
  work: () => Promise<T>,
  options?: {
    isStale?: () => boolean;
    canceledResult: () => T;
  }
): ScheduledPaintWork<T> {
  let canceled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let rafId: number | null = null;
  const isStale = options?.isStale ?? (() => false);

  const promise = new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (canceled || isStale()) {
        resolve(options!.canceledResult());
        return;
      }
      rafId = scheduleAnimationFrame(() => {
        rafId = null;
        if (canceled || isStale()) {
          resolve(options!.canceledResult());
          return;
        }
        Promise.resolve()
          .then(work)
          .then(resolve, reject);
      });
    }, 0);
  });

  return {
    promise,
    cancel: () => {
      canceled = true;
      if (timeoutId != null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (rafId != null) {
        cancelScheduledFrame(rafId);
        rafId = null;
      }
    },
  };
}

/**
 * Schedule work after a macrotask + one animation frame so Analysis can paint.
 * Pair with InteractionManager.runAfterInteractions at the Analysis enablement
 * boundary (see analysisPriceEnablement) for RN interaction quiescence.
 */
export function runAfterAnalysisFirstPaint<T>(
  work: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      scheduleAnimationFrame(() => {
        Promise.resolve()
          .then(work)
          .then(resolve, reject);
      });
    }, 0);
  });
}

/** Yield to the JS event loop between cooperative chunks. */
export function yieldAnalysisPriceChunk(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export type ChunkTimingSample = {
  label: string;
  durationMs: number;
};

/** Wall-clock prepare span — includes yields; never part of sync chunk max. */
export const AP3_PREPARE_TOTAL_WALL_LABEL = 'prepare:totalWall';

const SYNC_EXACT_LABELS = new Set([
  'identity:rows',
  'identity:qualify',
  'identity:peerPrepare',
  'prepare:evidence',
  'prepare:finalize',
]);

/**
 * True when the label's timer bounds contain only contiguous sync work
 * (no await/yield inside the measured interval).
 */
export function isSyncAp3ChunkTimingLabel(label: string): boolean {
  if (label === AP3_PREPARE_TOTAL_WALL_LABEL) return false;
  if (SYNC_EXACT_LABELS.has(label)) return true;
  if (label.startsWith('sku:')) return true;
  if (label.startsWith('mp:')) return true;
  return false;
}

/**
 * Strip dynamic identifiers (sku keys / mp ids) for diagnostics privacy.
 */
export function sanitizeAp3ChunkTimingLabelForDiagnostics(label: string): string {
  if (label.startsWith('sku:')) return 'sku';
  if (label.startsWith('mp:')) return 'mp';
  if (SYNC_EXACT_LABELS.has(label)) return label;
  if (label === AP3_PREPARE_TOTAL_WALL_LABEL) return AP3_PREPARE_TOTAL_WALL_LABEL;
  return 'unknown';
}

export type Ap3SyncChunkTimingSummary = {
  /** Max duration among sync-only samples (ms). */
  maxDurationMs: number;
  /** Safe static label of the max sync sample, or null if none. */
  maxLabel: string | null;
  /** Number of sync samples included in the max. */
  sampleCount: number;
  /** prepare:totalWall duration if present; otherwise null. */
  prepareWallMs: number | null;
};

/**
 * Split wall-clock prepare from contiguous sync chunk timings.
 */
export function summarizeAp3SyncChunkTimings(
  samples: readonly ChunkTimingSample[]
): Ap3SyncChunkTimingSummary {
  let prepareWallMs: number | null = null;
  let maxDurationMs = 0;
  let maxRawLabel: string | null = null;
  let sampleCount = 0;

  for (const sample of samples) {
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0) continue;
    if (sample.label === AP3_PREPARE_TOTAL_WALL_LABEL) {
      prepareWallMs =
        prepareWallMs == null
          ? sample.durationMs
          : Math.max(prepareWallMs, sample.durationMs);
      continue;
    }
    if (!isSyncAp3ChunkTimingLabel(sample.label)) continue;
    sampleCount += 1;
    // First valid sample initializes max (including 0ms); later only when greater.
    if (maxRawLabel == null || sample.durationMs > maxDurationMs) {
      maxDurationMs = sample.durationMs;
      maxRawLabel = sample.label;
    }
  }

  return {
    maxDurationMs,
    maxLabel:
      maxRawLabel != null
        ? sanitizeAp3ChunkTimingLabelForDiagnostics(maxRawLabel)
        : null,
    sampleCount,
    prepareWallMs,
  };
}

let chunkTimings: ChunkTimingSample[] = [];

export function beginAnalysisPriceChunkTimingCapture(): void {
  chunkTimings = [];
}

export function recordAnalysisPriceChunkTiming(
  label: string,
  durationMs: number
): void {
  chunkTimings.push({ label, durationMs });
}

export function endAnalysisPriceChunkTimingCapture(): ChunkTimingSample[] {
  const snapshot = chunkTimings;
  chunkTimings = [];
  return snapshot;
}

export function getMaxAnalysisPriceChunkDurationMs(): number {
  return summarizeAp3SyncChunkTimings(chunkTimings).maxDurationMs;
}

/** Controllable scheduler for G1/G2 race tests. */
type DeferredPaintGate = {
  release: () => void;
  promise: Promise<void>;
};

let testPaintGate: DeferredPaintGate | null = null;

export function __armAnalysisPricePaintGateForTests(): {
  release: () => void;
} {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  testPaintGate = { release, promise };
  return { release };
}

export function __clearAnalysisPricePaintGateForTests(): void {
  testPaintGate = null;
}

/**
 * Test-friendly paint deferral: if a paint gate is armed, wait for release
 * before running work (simulates InteractionManager / rAF delay).
 */
export function scheduleAfterAnalysisFirstPaintForTests<T>(
  work: () => Promise<T>,
  options: {
    isStale?: () => boolean;
    canceledResult: () => T;
  }
): ScheduledPaintWork<T> {
  let canceled = false;
  const isStale = options.isStale ?? (() => false);
  const gate = testPaintGate;
  const promise = (async () => {
    if (gate) await gate.promise;
    if (canceled || isStale()) return options.canceledResult();
    return work();
  })();
  return {
    promise,
    cancel: () => {
      canceled = true;
    },
  };
}
