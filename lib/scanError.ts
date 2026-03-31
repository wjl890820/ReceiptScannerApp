/**
 * 扫描错误码 → 用户可见文案的单一映射层。
 * 供首页单张失败 Alert、多张失败摘要、以及 handleScanPress 外层 catch 共用。
 */

import { t } from './i18n';

/** 与 ocrService / scanPipeline 一致的错误码 */
const KNOWN_CODES = [
  'RATE_LIMIT',
  'PAYLOAD_TOO_LARGE',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'INVALID_RESPONSE',
] as const;

const CODE_TO_I18N: Record<string, string> = {
  RATE_LIMIT: 'ocr.rateLimit',
  PAYLOAD_TOO_LARGE: 'ocr.payloadTooLarge',
  NETWORK_ERROR: 'ocr.networkError',
  SERVER_ERROR: 'ocr.serverError',
  INVALID_RESPONSE: 'ocr.invalidResponse',
};

/**
 * 将扫描错误码转为当前语言下的用户可见文案。
 * 未知 code 统一归为「识别失败」类。
 */
export function getScanErrorMessage(code: string): string {
  const key = CODE_TO_I18N[code];
  return key ? t(key) : t('ocr.failed');
}
