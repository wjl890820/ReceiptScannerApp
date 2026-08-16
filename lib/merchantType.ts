/**
 * 商户类型检测（V1 基础设施）。
 *
 * merchant_type 仅描述商户，不得映射为商品 category。
 * 商品 category 必须逐商品判断。
 */

import { normalizeMerchantName } from './productNormalizer';
import { detectCostcoReceiptSignals, isGroceryMerchant } from './groceryDetector';

export type MerchantType = 'supermarket' | 'convenience' | 'other' | 'unknown';

/** 日本主要便利店（与 groceryDetector EXCLUDE 便利店子集对齐） */
const CONVENIENCE_TERMS = [
  '7-eleven',
  'セブンイレブン',
  'セブン',
  'lawson',
  'ローソン',
  'familymart',
  'ファミリーマート',
  'ファミマ',
  'ministop',
  'ミニストップ',
  'newdays',
  'ニューデイズ',
] as const;

/** 明确非 V1 目标零售类型（药妆 / 餐饮 / 电商等） */
const OTHER_NON_RETAIL_TERMS = [
  'matsukiyo',
  'マツキヨ',
  'マツキヨココカラ',
  'sugi',
  'スギ',
  'スギ薬局',
  'tsuruha',
  'ツルハ',
  'cocokara',
  'ココカラ',
  'welcia',
  'ウェルシア',
  'mcdonalds',
  'マクドナルド',
  'starbucks',
  'スターバックス',
  'amazon',
  'アマゾン',
  'rakuten',
  '楽天',
  'ubereats',
  'ウーバーイーツ',
] as const;

function normalizeForMatch(rawName?: string | null, normalizedName?: string | null): string {
  const base = normalizedName || rawName || '';
  return normalizeMerchantName(base);
}

function matchesAny(normalized: string, terms: readonly string[]): boolean {
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  for (const term of terms) {
    if (lower.includes(term.toLowerCase())) return true;
  }
  return false;
}

/**
 * 根据商户名检测类型。
 * 优先级：convenience → other（已知非目标零售）→ supermarket → unknown
 */
export function detectMerchantType(
  rawName?: string | null,
  normalizedName?: string | null
): MerchantType {
  const normalized = normalizeForMatch(rawName, normalizedName);
  if (!normalized) return 'unknown';

  if (matchesAny(normalized, CONVENIENCE_TERMS)) return 'convenience';
  if (matchesAny(normalized, OTHER_NON_RETAIL_TERMS)) return 'other';
  if (isGroceryMerchant(rawName, normalizedName ?? normalized)) return 'supermarket';

  return 'unknown';
}

/**
 * Enricher helper: if merchant name alone is unknown but receipt has multiple
 * strong Costco signals (cropped header), treat as supermarket.
 */
export function detectMerchantTypeFromReceipt(analysis: {
  merchant?: string | null;
  merchant_normalized?: string | null;
  items?: Array<{ name?: string | null }> | null;
  rawText?: string | null;
  ocr_raw_text?: string | null;
}): MerchantType {
  const base = detectMerchantType(analysis.merchant, analysis.merchant_normalized);
  if (isV1SupportedMerchantType(base)) return base;

  const costco = detectCostcoReceiptSignals({
    merchant: analysis.merchant,
    items: analysis.items,
    rawText: analysis.rawText ?? analysis.ocr_raw_text,
  });
  if (costco.isCostco) return 'supermarket';
  return base;
}

export type ReceiptMerchantTypeSource = {
  merchant_type?: MerchantType | string | null;
  merchant_raw?: string | null;
  merchant_normalized?: string | null;
};

/**
 * 读取 receipt 的 merchant_type；DB 列为 null 时 runtime fallback。
 */
export function resolveReceiptMerchantType(receipt: ReceiptMerchantTypeSource): MerchantType {
  const stored = receipt.merchant_type;
  if (
    stored === 'supermarket' ||
    stored === 'convenience' ||
    stored === 'other' ||
    stored === 'unknown'
  ) {
    return stored;
  }
  return detectMerchantType(receipt.merchant_raw, receipt.merchant_normalized);
}

/** V1 正式支持的零售商户类型（supermarket + convenience）。 */
export function isV1SupportedMerchantType(type: MerchantType | string | null | undefined): boolean {
  return type === 'supermarket' || type === 'convenience';
}

export type V1SupportedReceiptSource = ReceiptMerchantTypeSource & {
  analysis_json?: string | null;
};

/**
 * 判断小票是否属于 V1 正式支持零售（supermarket + convenience）。
 * 优先 DB merchant_type → resolveReceiptMerchantType → analysis_json 兼容 fallback。
 */
export function isV1SupportedReceipt(receipt: V1SupportedReceiptSource): boolean {
  const type = resolveReceiptMerchantType(receipt);
  if (isV1SupportedMerchantType(type)) return true;

  // Legacy：enriched analysis_json 中的 merchant_type / is_grocery（旧超市 flag）
  try {
    const analysis = JSON.parse(receipt.analysis_json || '{}');
    if (isV1SupportedMerchantType(analysis?.merchant_type)) return true;
    if (analysis?.is_grocery === true) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** 筛选 V1 正式支持的小票（supermarket + convenience）。 */
export function filterV1SupportedReceipts<T extends V1SupportedReceiptSource>(receipts: T[]): T[] {
  return receipts.filter(isV1SupportedReceipt);
}
