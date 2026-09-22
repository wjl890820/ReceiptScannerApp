/**
 * Product Detail load stage timings (Performance Slice 3A).
 * Instrumentation only — feeds Internal Diagnostics when the gate is enabled.
 * Never records product names, identity keys, or merchant strings.
 */

import { recordDiagnosticTiming } from './internalDiagnostics';
import { isInternalDiagnosticsEnabled } from './internalDiagnosticsGate';

export const PRODUCT_DETAIL_DIAGNOSTICS_SCREEN = 'product_detail';

export type ProductDetailLoadTimingName =
  | 'productDetail.total'
  | 'productDetail.ownerReceiptUniverse'
  | 'productDetail.exclusionBuild'
  | 'productDetail.exclusionAnalyticsSelection'
  | 'productDetail.exclusionOccurrence'
  | 'productDetail.historyLoad'
  | 'productDetail.pphLoad'
  | 'productDetail.personalResolve'
  | 'productDetail.shoppingMembership';

export type ProductDetailExclusionCacheStateMeta =
  | 'hit'
  | 'miss'
  | 'direct'
  | 'stale';

export type ProductDetailLoadTimingSample = {
  stage: ProductDetailLoadTimingName;
  durationMs: number;
  targetType?: string;
  cacheState?: ProductDetailExclusionCacheStateMeta;
  receiptCount?: number;
  selectedReceiptCount?: number;
  excludedCount?: number;
  purchaseOccurrenceCount?: number;
  pointCount?: number;
  comparableOccurrenceCount?: number;
  found?: boolean;
  success?: boolean;
};

let forceEnabledForTests = false;
let samples: ProductDetailLoadTimingSample[] = [];

export function enableProductDetailLoadTimingsForTests(on = true): void {
  forceEnabledForTests = on;
  if (!on) samples = [];
}

export function isProductDetailLoadTimingEnabled(): boolean {
  return (
    forceEnabledForTests ||
    (typeof __DEV__ !== 'undefined' && __DEV__) ||
    isInternalDiagnosticsEnabled()
  );
}

export function beginProductDetailLoadTimingCapture(): void {
  samples = [];
}

export function recordProductDetailLoadTiming(
  sample: ProductDetailLoadTimingSample
): void {
  if (!isProductDetailLoadTimingEnabled()) return;
  samples.push(sample);
  try {
    if (isInternalDiagnosticsEnabled()) {
      const meta: Record<string, unknown> = {};
      if (sample.targetType != null) meta.targetType = sample.targetType;
      if (sample.cacheState != null) meta.cacheState = sample.cacheState;
      if (sample.receiptCount != null) meta.receiptCount = sample.receiptCount;
      if (sample.selectedReceiptCount != null) {
        meta.selectedReceiptCount = sample.selectedReceiptCount;
      }
      if (sample.excludedCount != null) meta.excludedCount = sample.excludedCount;
      if (sample.purchaseOccurrenceCount != null) {
        meta.purchaseOccurrenceCount = sample.purchaseOccurrenceCount;
      }
      if (sample.pointCount != null) meta.pointCount = sample.pointCount;
      if (sample.comparableOccurrenceCount != null) {
        meta.comparableOccurrenceCount = sample.comparableOccurrenceCount;
      }
      if (sample.found != null) meta.found = sample.found;
      if (sample.success != null) meta.success = sample.success;
      recordDiagnosticTiming(
        PRODUCT_DETAIL_DIAGNOSTICS_SCREEN,
        sample.stage,
        sample.durationMs,
        meta
      );
    }
  } catch {
    // ignore diagnostics failures
  }
}

type StageMeta = Omit<ProductDetailLoadTimingSample, 'stage' | 'durationMs'>;

export function measureProductDetailLoadStageSync<T>(
  stage: ProductDetailLoadTimingName,
  work: () => T,
  meta?: StageMeta | ((result: T) => StageMeta)
): T {
  if (!isProductDetailLoadTimingEnabled()) {
    return work();
  }
  const started = Date.now();
  try {
    const result = work();
    const resolved =
      typeof meta === 'function' ? meta(result) : (meta ?? {});
    recordProductDetailLoadTiming({
      stage,
      durationMs: Date.now() - started,
      ...resolved,
    });
    return result;
  } catch (error) {
    const resolved = typeof meta === 'function' ? {} : (meta ?? {});
    recordProductDetailLoadTiming({
      stage,
      durationMs: Date.now() - started,
      success: false,
      ...resolved,
    });
    throw error;
  }
}

export async function measureProductDetailLoadStage<T>(
  stage: ProductDetailLoadTimingName,
  work: () => Promise<T> | T,
  meta?: StageMeta | ((result: T) => StageMeta)
): Promise<T> {
  if (!isProductDetailLoadTimingEnabled()) {
    return await Promise.resolve(work());
  }
  const started = Date.now();
  try {
    const result = await Promise.resolve(work());
    const resolved =
      typeof meta === 'function' ? meta(result) : (meta ?? {});
    recordProductDetailLoadTiming({
      stage,
      durationMs: Date.now() - started,
      ...resolved,
    });
    return result;
  } catch (error) {
    const resolved = typeof meta === 'function' ? {} : (meta ?? {});
    recordProductDetailLoadTiming({
      stage,
      durationMs: Date.now() - started,
      success: false,
      ...resolved,
    });
    throw error;
  }
}

export function endProductDetailLoadTimingCapture(): ProductDetailLoadTimingSample[] {
  const snapshot = samples;
  samples = [];
  return snapshot;
}
