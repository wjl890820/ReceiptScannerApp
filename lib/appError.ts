/**
 * 轻量统一错误模型，用于扫描链路等。
 * 便于后续挂接错误上报（Sentry/Crashlytics）时有一致结构。
 */

export type ScanErrorStage = 'ocr' | 'enrich' | 'save' | 'ui';

export type ScanAppError = {
  code: string;
  message: string;
  stage: ScanErrorStage;
  userMessageKey?: string;
  originalError?: unknown;
};

const KNOWN_CODES = [
  'RATE_LIMIT',
  'PAYLOAD_TOO_LARGE',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'INVALID_RESPONSE',
  // Edge Function 稳定错误码（ocr-receipt）
  'GEMINI_UPSTREAM_ERROR',
  'OCR_PARSE_ERROR',
  'OCR_TIMEOUT',
  'INVALID_RECEIPT_SCHEMA',
  'RECONCILIATION_FAILED',
] as const;

function isKnownCode(c: string): c is (typeof KNOWN_CODES)[number] {
  return (KNOWN_CODES as readonly string[]).includes(c);
}

/**
 * 从捕获的异常构造扫描错误；保留已知 code，其余归为 FAILED。
 */
export function toScanAppError(
  err: unknown,
  stage: ScanErrorStage
): ScanAppError {
  const anyErr = err as any;
  const code = isKnownCode(anyErr?.code) ? anyErr.code : 'FAILED';
  return {
    code,
    message: anyErr?.message ?? String(err),
    stage,
    originalError: err,
  };
}

/**
 * 转为 pipeline 返回结构，与现有 ScanOneResult 兼容。
 */
export function toScanResult(e: ScanAppError): { ok: false; code: string; message?: string } {
  return { ok: false, code: e.code, message: e.message };
}
