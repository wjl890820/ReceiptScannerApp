// lib/productNormalizer.ts

/**
 * 产品名称标准化
 * - 统一全角/半角
 * - 移除单位/尺寸模式
 * - 移除税相关标记
 * - 输出标准化名称和关键词
 */

// 单位模式（日语和英语）
const UNIT_PATTERNS = [
  /\d+\s*(ml|mL|ML|g|kg|G|KG|L|l)\b/gi,
  /\d+\s*(本|袋|個|枚|パック|pack|Pack|PACK)\b/gi,
  /x\s*\d+|×\s*\d+|X\s*\d+/gi, // x2, ×3, X4
  /\d+\s*x\s*\d+|×\s*\d+\s*x\s*\d+/gi, // 2x3, 2×3
  /\(税込\)|\(税抜\)|\(税別\)|税込|税抜|税別/gi,
  /\d+\s*円|\d+\s*¥/gi, // 价格标记
];

// 移除常见后缀
const SUFFIX_PATTERNS = [
  /\s*\(.*?\)\s*$/g, // 括号内容
  /\s*\[.*?\]\s*$/g, // 方括号内容
];

export type NormalizedProduct = {
  normalizedName: string;
  keywords: string[];
};

/**
 * 标准化产品名称
 */
export function normalizeProductName(rawName: string): NormalizedProduct {
  if (!rawName || typeof rawName !== 'string') {
    return { normalizedName: '', keywords: [] };
  }

  let normalized = rawName.trim();

  // 统一全角/半角（全角转半角）
  normalized = normalized.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => {
    return String.fromCharCode(s.charCodeAt(0) - 0xfee0);
  });

  // 统一空格
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // 移除单位模式
  for (const pattern of UNIT_PATTERNS) {
    normalized = normalized.replace(pattern, '');
  }

  // 移除后缀
  for (const pattern of SUFFIX_PATTERNS) {
    normalized = normalized.replace(pattern, '');
  }

  // 清理多余空格
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // 提取关键词（简单分词：按空格和常见分隔符）
  const keywords = normalized
    .split(/[\s・、,，]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k.length <= 20) // 过滤过长或空的关键词
    .slice(0, 5); // 最多5个关键词

  return {
    normalizedName: normalized.toLowerCase(),
    keywords,
  };
}

/**
 * 标准化商家名称
 */
export function normalizeMerchantName(rawName: string | null | undefined): string {
  if (!rawName || typeof rawName !== 'string') return '';

  let normalized = rawName.trim();

  // 统一全角/半角
  normalized = normalized.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => {
    return String.fromCharCode(s.charCodeAt(0) - 0xfee0);
  });

  // 移除常见后缀
  normalized = normalized
    .replace(/\s*\(.*?\)\s*$/g, '')
    .replace(/\s*\[.*?\]\s*$/g, '')
    .replace(/\s*店\s*$/g, '') // 移除"店"后缀
    .trim();

  return normalized.toLowerCase();
}

/**
 * 计算单价
 */
export function calculateUnitPrice(
  lineTotal: number,
  quantity: number
): number {
  if (!Number.isFinite(lineTotal) || lineTotal <= 0) return 0;
  if (!Number.isFinite(quantity) || quantity <= 0) return lineTotal; // 如果没有数量，返回总价作为单价

  return lineTotal / quantity;
}
