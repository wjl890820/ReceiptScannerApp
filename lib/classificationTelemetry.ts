/**
 * 分类 telemetry（best-effort，不阻断扫描/审核/保存）。
 */

import type { RunBatchAiResult } from './categoryBatchAi';
import type { MerchantType } from './merchantType';

export type ClassificationTelemetryV1 = {
  merchant_type?: MerchantType;
  item_count: number;
  local_classified_count: number;
  local_uncategorized_count: number;
  batch_ai_enabled: boolean;
  batch_ai_called: boolean;
  batch_ai_item_count: number;
  batch_ai_applied_count: number;
  batch_ai_suggested_count: number;
  final_uncategorized_count: number;
  classification_duration_ms: number;
  batch_ai_duration_ms?: number;
};

export function countClassificationBuckets(items: unknown[]): {
  classified: number;
  uncategorized: number;
} {
  if (!Array.isArray(items)) return { classified: 0, uncategorized: 0 };
  let classified = 0;
  let uncategorized = 0;
  for (const it of items) {
    const cat = (it as { category?: string })?.category;
    if (cat === 'uncategorized' || cat == null || cat === '') uncategorized++;
    else classified++;
  }
  return { classified, uncategorized };
}

export function buildClassificationTelemetry(params: {
  items: unknown[];
  localBuckets: { classified: number; uncategorized: number };
  batchAiEnabled: boolean;
  batchResult: RunBatchAiResult | null;
  batchAiItemCount: number;
  classificationDurationMs: number;
  batchAiDurationMs?: number;
  merchantType?: MerchantType;
}): ClassificationTelemetryV1 {
  const finalBuckets = countClassificationBuckets(params.items);
  const batch = params.batchResult;
  return {
    ...(params.merchantType ? { merchant_type: params.merchantType } : {}),
    item_count: params.items.length,
    local_classified_count: params.localBuckets.classified,
    local_uncategorized_count: params.localBuckets.uncategorized,
    batch_ai_enabled: params.batchAiEnabled,
    batch_ai_called: batch?.called ?? false,
    batch_ai_item_count: params.batchAiItemCount,
    batch_ai_applied_count: batch?.appliedCount ?? 0,
    batch_ai_suggested_count: batch?.suggestedCount ?? 0,
    final_uncategorized_count: finalBuckets.uncategorized,
    classification_duration_ms: Math.max(0, Math.round(params.classificationDurationMs)),
    ...(params.batchAiDurationMs != null
      ? { batch_ai_duration_ms: Math.max(0, Math.round(params.batchAiDurationMs)) }
      : {}),
  };
}

export function logClassificationTelemetryDev(telemetry: ClassificationTelemetryV1): void {
  if (!__DEV__) return;
  // eslint-disable-next-line no-console
  console.log('[ClassificationTelemetry]', telemetry);
}
