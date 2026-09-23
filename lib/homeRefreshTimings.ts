/**
 * DEV/validation-only Home refresh stage timings (P1A / H1.1).
 * Also feeds Internal Diagnostics when the diagnostics gate is enabled.
 *
 * Privacy: counts / success / duration only — never ownerKey, receipt IDs,
 * product names, merchant names, or identity keys.
 */

import {
  recordDiagnosticTiming,
  recordHomeCoordinatorDiagnostic,
} from './internalDiagnostics';
import { isInternalDiagnosticsEnabled } from './internalDiagnosticsGate';

export type HomeRefreshTimingStage =
  | 'listReceipts'
  | 'engagementReceiptLoad'
  | 'selectAnalyticsReceipts'
  | 'engagementMilestone'
  | 'productContext'
  | 'personalInventory'
  | 'buildHomeProgressiveExperience'
  | 'focusGenerationCheck'
  | 'heavySnapshotReuse'
  | 'volatileRefresh'
  | 'timeProjection'
  | 'total'
  /** Slice H1.1: shared product-insight SQLite JOIN only. */
  | 'home.productContext.db'
  /** Slice H1.1: enrichProductRowsWithCurrentItemMonetaryTruth only. */
  | 'home.productContext.enrich'
  /** Slice H1.1: personal inventory owner-wide DB reads before identity. */
  | 'home.personalInventory.db'
  /** Slice H1.1: resolveReceiptItemIdentity loop + inventory build. */
  | 'home.personalInventory.identity'
  /** Slice H1.1: buildHomeRepeatSurfaces / Repeat+NP construction. */
  | 'home.progressive.repeatBuild';

export type HomeRefreshTimingSample = {
  stage: HomeRefreshTimingStage;
  durationMs: number;
  receiptCount?: number;
  analyticsReceiptCount?: number;
  productRowCount?: number;
  success?: boolean;
  /** productContext.db / inventory: rows returned from SQLite. */
  rowCount?: number;
  itemRowCount?: number;
  decisionCount?: number;
  inputRowCount?: number;
  outputRowCount?: number;
  resolvedRowCount?: number;
};

type StageMeta = Omit<HomeRefreshTimingSample, 'stage' | 'durationMs'>;

let enabled = false;
let samples: HomeRefreshTimingSample[] = [];

export function enableHomeRefreshTimingsForTests(on = true): void {
  enabled = on;
  if (!on) samples = [];
}

export function isHomeRefreshTimingEnabled(): boolean {
  return (
    enabled ||
    (typeof __DEV__ !== 'undefined' && __DEV__) ||
    isInternalDiagnosticsEnabled()
  );
}

export function beginHomeRefreshTimingCapture(): void {
  samples = [];
}

function diagnosticMetaFromSample(
  sample: HomeRefreshTimingSample
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (sample.receiptCount != null) meta.receiptCount = sample.receiptCount;
  if (sample.analyticsReceiptCount != null) {
    meta.analyticsReceiptCount = sample.analyticsReceiptCount;
  }
  if (sample.productRowCount != null) {
    meta.productRowCount = sample.productRowCount;
  }
  if (sample.success != null) meta.success = sample.success;
  if (sample.rowCount != null) meta.rowCount = sample.rowCount;
  if (sample.itemRowCount != null) meta.itemRowCount = sample.itemRowCount;
  if (sample.decisionCount != null) meta.decisionCount = sample.decisionCount;
  if (sample.inputRowCount != null) meta.inputRowCount = sample.inputRowCount;
  if (sample.outputRowCount != null) meta.outputRowCount = sample.outputRowCount;
  if (sample.resolvedRowCount != null) {
    meta.resolvedRowCount = sample.resolvedRowCount;
  }
  return meta;
}

export function recordHomeRefreshTiming(sample: HomeRefreshTimingSample): void {
  if (!isHomeRefreshTimingEnabled()) return;
  samples.push(sample);
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.log('[HomeRefreshTiming]', sample);
  }
  try {
    if (isInternalDiagnosticsEnabled()) {
      recordDiagnosticTiming(
        'home',
        sample.stage,
        sample.durationMs,
        diagnosticMetaFromSample(sample)
      );
    }
  } catch {
    // ignore
  }
}

function resolveMeta<T>(
  meta: StageMeta | ((result: T) => StageMeta) | undefined,
  result: T
): StageMeta {
  if (typeof meta === 'function') return meta(result);
  return meta ?? {};
}

/**
 * Synchronous stage measurement — must not introduce Promise boundaries.
 * On throw: records success:false and rethrows unchanged.
 */
export function measureHomeRefreshStageSync<T>(
  stage: HomeRefreshTimingStage,
  work: () => T,
  meta?: StageMeta | ((result: T) => StageMeta)
): T {
  if (!isHomeRefreshTimingEnabled()) {
    return work();
  }
  const started = Date.now();
  try {
    const result = work();
    recordHomeRefreshTiming({
      stage,
      durationMs: Date.now() - started,
      ...resolveMeta(meta, result),
    });
    return result;
  } catch (error) {
    const resolved = typeof meta === 'function' ? {} : (meta ?? {});
    recordHomeRefreshTiming({
      stage,
      durationMs: Date.now() - started,
      success: false,
      ...resolved,
    });
    throw error;
  }
}

export async function measureHomeRefreshStage<T>(
  stage: HomeRefreshTimingStage,
  work: () => Promise<T> | T,
  meta?: StageMeta | ((result: T) => StageMeta)
): Promise<T> {
  if (!isHomeRefreshTimingEnabled()) {
    return await Promise.resolve(work());
  }
  const started = Date.now();
  try {
    const result = await Promise.resolve(work());
    recordHomeRefreshTiming({
      stage,
      durationMs: Date.now() - started,
      ...resolveMeta(meta, result),
    });
    return result;
  } catch (error) {
    const resolved = typeof meta === 'function' ? {} : (meta ?? {});
    recordHomeRefreshTiming({
      stage,
      durationMs: Date.now() - started,
      success: false,
      ...resolved,
    });
    throw error;
  }
}

export function endHomeRefreshTimingCapture(): HomeRefreshTimingSample[] {
  const snapshot = samples;
  samples = [];
  return snapshot;
}

export function logHomeRefreshCoordinatorEvent(event: unknown): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // eslint-disable-next-line no-console
    console.log('[HomeRefreshCoordinator]', event);
  }
  try {
    if (
      event &&
      typeof event === 'object' &&
      typeof (event as { type?: unknown }).type === 'string'
    ) {
      recordHomeCoordinatorDiagnostic(event as { type: string });
    }
  } catch {
    // ignore
  }
}
