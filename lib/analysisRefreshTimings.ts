/**
 * DEV/validation-only Analysis focus timings (AP-3 OFF path).
 * Also feeds Internal Diagnostics when the diagnostics gate is enabled.
 */

import { isInternalDiagnosticsEnabled } from './internalDiagnosticsGate';
import { recordDiagnosticTiming } from './internalDiagnostics';

export type AnalysisRefreshTimingStage =
  | 'listReceiptsForAnalysis'
  | 'selectAnalyticsReceipts'
  | 'buildAnalysisTruthSnapshot'
  | 'buildAnalysisAllTimeStats'
  | 'buildAnalysisReleaseViewModel'
  | 'total';

export type AnalysisRefreshTimingSample = {
  stage: AnalysisRefreshTimingStage;
  durationMs: number;
  receiptCount?: number;
  analyticsReceiptCount?: number;
};

let samples: AnalysisRefreshTimingSample[] = [];
let forceEnabledForTests = false;

export function enableAnalysisRefreshTimingsForTests(on = true): void {
  forceEnabledForTests = on;
  if (!on) samples = [];
}

export function isAnalysisRefreshTimingEnabled(): boolean {
  return (
    forceEnabledForTests ||
    (typeof __DEV__ !== 'undefined' && __DEV__) ||
    isInternalDiagnosticsEnabled()
  );
}

export function beginAnalysisRefreshTimingCapture(): void {
  samples = [];
}

export function recordAnalysisRefreshTiming(
  sample: AnalysisRefreshTimingSample
): void {
  if (!isAnalysisRefreshTimingEnabled()) return;
  samples.push(sample);
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.log('[AnalysisRefreshTiming]', sample);
  }
  try {
    if (isInternalDiagnosticsEnabled()) {
      recordDiagnosticTiming('analysis', sample.stage, sample.durationMs, {
        receiptCount: sample.receiptCount,
        analyticsReceiptCount: sample.analyticsReceiptCount,
      });
    }
  } catch {
    // ignore
  }
}

/** Sync stage measure for useMemo / pure helpers. */
export function measureAnalysisRefreshStageSync<T>(
  stage: AnalysisRefreshTimingStage,
  work: () => T,
  meta?: Omit<AnalysisRefreshTimingSample, 'stage' | 'durationMs'>
): T {
  if (!isAnalysisRefreshTimingEnabled()) {
    return work();
  }
  const started = Date.now();
  try {
    return work();
  } finally {
    recordAnalysisRefreshTiming({
      stage,
      durationMs: Date.now() - started,
      ...meta,
    });
  }
}

export async function measureAnalysisRefreshStage<T>(
  stage: AnalysisRefreshTimingStage,
  work: () => Promise<T> | T,
  meta?: Omit<AnalysisRefreshTimingSample, 'stage' | 'durationMs'>
): Promise<T> {
  if (!isAnalysisRefreshTimingEnabled()) {
    return await Promise.resolve(work());
  }
  const started = Date.now();
  try {
    return await Promise.resolve(work());
  } finally {
    recordAnalysisRefreshTiming({
      stage,
      durationMs: Date.now() - started,
      ...meta,
    });
  }
}

export function endAnalysisRefreshTimingCapture(): AnalysisRefreshTimingSample[] {
  const snapshot = samples;
  samples = [];
  return snapshot;
}
