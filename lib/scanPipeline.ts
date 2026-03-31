/**
 * 扫描主流程：单张图片 OCR → 分类增强 → 保存。
 * 职责边界：不包含选图、权限、确认弹窗、进度 UI、成功/失败 Alert、复活节彩蛋。
 * 调用方：首页编排层（选图后调用本模块，再根据结果刷新列表与展示提示）。
 */

import { analyzeReceiptImage } from './receiptAnalyzer';
import { applyCategoriesWithLearning } from './receiptEnricher';
import { saveReceipt } from './db';
import { toScanAppError, toScanResult } from './appError';
import { logger } from './logger';

export type ScanOneResult =
  | { ok: true; id: string }
  | { ok: false; code: string; message?: string };

type ScanTrace = {
  id: string;
  t0: number;
};

function nowMs(): number {
  return Date.now();
}

function msSince(t: number): number {
  return nowMs() - t;
}

/**
 * 多张扫描结果聚合：成功数、失败数、按错误码聚合的失败原因。
 * 供首页多张摘要与测试使用。
 */
export function aggregateBatchScanResults(
  results: ScanOneResult[]
): { successCount: number; failCount: number; failureReasonsByCode: Record<string, number> } {
  let successCount = 0;
  const failureReasonsByCode: Record<string, number> = {};
  for (const r of results) {
    if (r.ok) {
      successCount++;
    } else {
      const code = r.code || 'FAILED';
      failureReasonsByCode[code] = (failureReasonsByCode[code] ?? 0) + 1;
    }
  }
  return {
    successCount,
    failCount: results.length - successCount,
    failureReasonsByCode,
  };
}

/**
 * 执行单张收据的完整管道：OCR → 分类增强 → 落库。
 * 不抛错，失败时返回 { ok: false, code, message }。
 * code 与 ocrService 错误码一致，便于调用方用 t('ocr.xxx') 展示。
 */
export async function runScanPipeline(uri: string): Promise<ScanOneResult> {
  const trace: ScanTrace = { id: `scan-${nowMs()}-${Math.random().toString(16).slice(2, 8)}`, t0: nowMs() };
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log('[ScanTiming] start', { id: trace.id });
  }
  try {
    const raw = await analyzeReceiptImage(uri, trace);
    try {
      const enriched = await applyCategoriesWithLearning(raw, trace);
      try {
        const id = await saveReceipt({ imageUri: uri, analysis: enriched }, trace);
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[ScanTiming] total_ms', { id: trace.id, ms: msSince(trace.t0) });
        }
        return { ok: true, id };
      } catch (err: unknown) {
        const appErr = toScanAppError(err, 'save');
        logger.error('ScanPipeline', 'Pipeline failed (save)', { code: appErr.code, message: appErr.message });
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[ScanTiming] failed_total_ms', { id: trace.id, ms: msSince(trace.t0) });
        }
        return toScanResult(appErr);
      }
    } catch (err: unknown) {
      const appErr = toScanAppError(err, 'enrich');
      logger.error('ScanPipeline', 'Pipeline failed (enrich)', { code: appErr.code, message: appErr.message });
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[ScanTiming] failed_total_ms', { id: trace.id, ms: msSince(trace.t0) });
      }
      return toScanResult(appErr);
    }
  } catch (err: unknown) {
    const appErr = toScanAppError(err, 'ocr');
    logger.error('ScanPipeline', 'Pipeline failed (ocr)', { code: appErr.code, message: appErr.message });
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[ScanTiming] failed_total_ms', { id: trace.id, ms: msSince(trace.t0) });
    }
    return toScanResult(appErr);
  }
}
