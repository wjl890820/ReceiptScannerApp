/**
 * 扫描主流程：单张图片 OCR → 分类增强 → 保存。
 * 职责边界：不包含选图、权限、确认弹窗、进度 UI、成功/失败 Alert、复活节彩蛋。
 * 调用方：首页编排层（选图后调用本模块，再根据结果刷新列表与展示提示）。
 */

import { analyzeReceiptImage } from './receiptAnalyzer';
import { applyCategoriesWithLearning } from './receiptEnricher';
import { saveReceipt } from './db';
import { toScanAppError, toScanResult, isRecoverableScanCode, type ScanAppError } from './appError';
import { logger } from './logger';

/**
 * 可恢复的扫描错误（超时/限流/解析/上游等）记录为 warn，避免 RN dev redbox；
 * 仅真正意外的错误用 error。
 */
function logScanFailure(tag: string, message: string, appErr: ScanAppError): void {
  const level = isRecoverableScanCode(appErr.code) ? 'warn' : 'error';
  logger[level](tag, message, { code: appErr.code, message: appErr.message });
}
import { getDefaultReceiptSource } from './receiptSourceSettings';
import { putScanReviewDraft } from './scanReviewDraftStore';

/** 直扫落库成功（测试/兼容保留） */
export type ScanSaveSuccess = { ok: true; kind: 'saved'; id: string };
/** 识别完成，进入审核草稿 */
export type ScanReviewSuccess = { ok: true; kind: 'review'; draftId: string; traceId: string };
export type ScanOneResult = ScanSaveSuccess | ScanReviewSuccess | { ok: false; code: string; message?: string };

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
        const source = await getDefaultReceiptSource();
        const id = await saveReceipt({ imageUri: uri, analysis: enriched, source }, trace);
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[ScanTiming] total_ms', { id: trace.id, ms: msSince(trace.t0) });
        }
        return { ok: true, kind: 'saved', id };
      } catch (err: unknown) {
        const appErr = toScanAppError(err, 'save');
        logScanFailure('ScanPipeline', 'Pipeline failed (save)', appErr);
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.log('[ScanTiming] failed_total_ms', { id: trace.id, ms: msSince(trace.t0) });
        }
        return toScanResult(appErr);
      }
    } catch (err: unknown) {
      const appErr = toScanAppError(err, 'enrich');
      logScanFailure('ScanPipeline', 'Pipeline failed (enrich)', appErr);
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[ScanTiming] failed_total_ms', { id: trace.id, ms: msSince(trace.t0) });
      }
      return toScanResult(appErr);
    }
  } catch (err: unknown) {
    const appErr = toScanAppError(err, 'ocr');
    logScanFailure('ScanPipeline', 'Pipeline failed (ocr)', appErr);
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[ScanTiming] failed_total_ms', { id: trace.id, ms: msSince(trace.t0) });
    }
    return toScanResult(appErr);
  }
}

/**
 * OCR → 分类增强 → 内存草稿；不直接落库。首页应导航至 /scan-review/[draftId]。
 */
export async function runScanPipelineToReview(uri: string): Promise<ScanOneResult> {
  const trace: ScanTrace = { id: `scan-${nowMs()}-${Math.random().toString(16).slice(2, 8)}`, t0: nowMs() };
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log('[ScanTiming] review_draft_start', { id: trace.id });
  }
  try {
    const raw = await analyzeReceiptImage(uri, trace);
    try {
      const enriched = await applyCategoriesWithLearning(raw, trace);
      const snapshot = JSON.parse(JSON.stringify(enriched)) as unknown;
      const draftId = await putScanReviewDraft({
        imageUri: uri,
        recognitionSnapshot: snapshot,
        traceId: trace.id,
      });
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[ScanTiming] review_draft_ready_ms', { id: trace.id, ms: msSince(trace.t0) });
      }
      return { ok: true, kind: 'review', draftId, traceId: trace.id };
    } catch (err: unknown) {
      const appErr = toScanAppError(err, 'enrich');
      logScanFailure('ScanPipeline', 'Review draft failed (enrich)', appErr);
      return toScanResult(appErr);
    }
  } catch (err: unknown) {
    const appErr = toScanAppError(err, 'ocr');
    logScanFailure('ScanPipeline', 'Review draft failed (ocr)', appErr);
    return toScanResult(appErr);
  }
}
