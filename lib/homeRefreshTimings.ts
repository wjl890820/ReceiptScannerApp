/**
 * DEV/validation-only Home refresh stage timings (P1A).
 * No production telemetry.
 */

export type HomeRefreshTimingStage =
  | 'listReceipts'
  | 'selectAnalyticsReceipts'
  | 'engagementMilestone'
  | 'productContext'
  | 'personalInventory'
  | 'buildHomeProgressiveExperience'
  | 'total';

export type HomeRefreshTimingSample = {
  stage: HomeRefreshTimingStage;
  durationMs: number;
  receiptCount?: number;
  analyticsReceiptCount?: number;
  productRowCount?: number;
};

let enabled = false;
let samples: HomeRefreshTimingSample[] = [];

export function enableHomeRefreshTimingsForTests(on = true): void {
  enabled = on;
  if (!on) samples = [];
}

export function isHomeRefreshTimingEnabled(): boolean {
  return enabled || (typeof __DEV__ !== 'undefined' && __DEV__);
}

export function beginHomeRefreshTimingCapture(): void {
  samples = [];
}

export function recordHomeRefreshTiming(sample: HomeRefreshTimingSample): void {
  if (!isHomeRefreshTimingEnabled()) return;
  samples.push(sample);
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.log('[HomeRefreshTiming]', sample);
  }
}

export async function measureHomeRefreshStage<T>(
  stage: HomeRefreshTimingStage,
  work: () => Promise<T> | T,
  meta?: Omit<HomeRefreshTimingSample, 'stage' | 'durationMs'>
): Promise<T> {
  if (!isHomeRefreshTimingEnabled()) {
    return await Promise.resolve(work());
  }
  const started = Date.now();
  try {
    return await Promise.resolve(work());
  } finally {
    recordHomeRefreshTiming({
      stage,
      durationMs: Date.now() - started,
      ...meta,
    });
  }
}

export function endHomeRefreshTimingCapture(): HomeRefreshTimingSample[] {
  const snapshot = samples;
  samples = [];
  return snapshot;
}

export function logHomeRefreshCoordinatorEvent(event: unknown): void {
  if (!(typeof __DEV__ !== 'undefined' && __DEV__)) return;
  // eslint-disable-next-line no-console
  console.log('[HomeRefreshCoordinator]', event);
}
