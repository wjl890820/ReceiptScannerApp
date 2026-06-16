/**
 * 扫描失败重试的纯函数辅助层（无副作用，便于测试）。
 * 供首页多张扫描的“重试失败图片 / 重试全部”编排使用。
 */

import type { ScanOneResult } from './scanPipeline';

export type FailedScanItem = {
  uri: string;
  index: number;
  code: string;
  message?: string;
};

/**
 * 从一次批量扫描的输入 uris 与结果中，收集失败项（保留原始 index 与 code）。
 * results[i] 对应 uris[i]。
 */
export function collectFailedScanItems(uris: string[], results: ScanOneResult[]): FailedScanItem[] {
  const failed: FailedScanItem[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) {
      failed.push({
        uri: uris[i],
        index: i,
        code: r.code || 'FAILED',
        message: r.message,
      });
    }
  }
  return failed;
}

/**
 * 把一次重试得到的成功 draftId 追加到原有成功 draftIds 之后，保持顺序、不丢已成功项。
 */
export function mergeDraftIdsAfterRetry(originalDraftIds: string[], retryResults: ScanOneResult[]): string[] {
  const merged = [...originalDraftIds];
  for (const r of retryResults) {
    if (r.ok && r.kind === 'review') {
      merged.push(r.draftId);
    }
  }
  return merged;
}

/**
 * 按错误码聚合失败项数量，供构造“主要失败原因”摘要使用。
 */
export function buildBatchFailureSummary(
  failed: FailedScanItem[]
): { failCount: number; failureReasonsByCode: Record<string, number> } {
  const failureReasonsByCode: Record<string, number> = {};
  for (const f of failed) {
    const code = f.code || 'FAILED';
    failureReasonsByCode[code] = (failureReasonsByCode[code] ?? 0) + 1;
  }
  return { failCount: failed.length, failureReasonsByCode };
}
