/**
 * OCR 结果的确定性后处理（纯函数，无副作用，可单测）。
 *
 * 目的（在 OCR 返回后、分类增强前应用）：
 *  - 便利店/店铺名归一化（セブン-イレブン 等）。
 *  - 把折扣 / 税 / 小计 / 合计行从 items 中剔除，折扣进入 discounts。
 *  - 清洗 item.categoryKey：店铺类型词（コンビニ/スーパー/非超市…）绝不进入分类。
 *  - 金额对账：items 正向合计 ± 折扣 (+税) ≈ total，不一致仅标记 warning，不静默改结构。
 *
 * 注意：这里只做"展示前 deterministic 修正"，不声称提升 OCR 看图准确率。
 */

import type { ReceiptAnalysis, ReceiptItem, CategoryKey } from './receiptAnalyzer';
import { PRODUCT_CATEGORIES, type ProductCategory } from './productCategory';
import { applyReceiptDiscountsToItems } from './receiptDiscountAllocation';

export type OcrLineKind = 'item' | 'discount' | 'tax' | 'subtotal' | 'unknown';

export type ReceiptDiscount = { label: string; amount: number };

export type ReceiptReconciliation = {
  ok: boolean;
  itemsPositiveSum: number;
  discountsSum: number; // 负数（折扣减项）
  tax: number;
  total: number;
  /** 与 total 的最小偏差（已分别考虑内税/外税两种口径） */
  diff: number;
  warnings: string[];
};

/** OCR categoryKey 合法枚举（与 receiptAnalyzer.CategoryKey 对齐） */
const VALID_CATEGORY_KEYS: readonly CategoryKey[] = [
  'fresh',
  'staple',
  'dairy_egg',
  'snack',
  'drink',
  'frozen_deli',
  'seasoning',
  'household',
  'alcohol',
  'other',
];

const DISCOUNT_KEYWORDS = [
  '値引',
  '値引き',
  '割引',
  'わりびき',
  'クーポン',
  'coupon',
  'cpn',
  'セール',
  'ポイント利用',
  'ポイント割',
  'point',
  '％off',
  '%off',
  'off',
  '引き',
];

const TAX_KEYWORDS = ['消費税', '内税', '外税', '軽減税率', '税率', '（税', '(税', 'tax'];

const SUBTOTAL_KEYWORDS = ['小計', '小 計', '合計', '合 計', 'お買上', 'お買い上げ', 'subtotal', 'total', '総計'];

function toHalfWidthLower(s: string): string {
  return (s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .trim();
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => n && haystack.includes(toHalfWidthLower(n)));
}

/**
 * 便利店/常见店铺名归一化。命中则返回归一名，否则原样返回（trim）。
 */
export function normalizeMerchant(raw: string | null | undefined): string {
  const original = (raw ?? '').trim();
  if (!original) return original;
  const n = toHalfWidthLower(original).replace(/[\s　]/g, '').replace(/[－—–−ー]/g, '-');

  if (
    n.includes('セブン-イレブン') ||
    n.includes('セブンイレブン') ||
    n.includes('セブン') ||
    n.includes('7-eleven') ||
    n.includes('7eleven') ||
    n.includes('seven-eleven') ||
    n.includes('seveneleven')
  ) {
    return 'セブン-イレブン';
  }
  if (n.includes('ファミリーマート') || n.includes('ファミマ') || n.includes('familymart') || n.includes('family-mart')) {
    return 'ファミリーマート';
  }
  if (n.includes('ローソン') || n.includes('lawson')) {
    return 'ローソン';
  }
  if (n.includes('ミニストップ') || n.includes('ministop')) {
    return 'ミニストップ';
  }
  return original;
}

/**
 * 判断 OCR 行类型：item / discount / tax / subtotal。
 * 折扣判定：命中折扣关键字，或金额为负。
 */
export function classifyLineKind(name: string, lineTotal: number): OcrLineKind {
  const n = toHalfWidthLower(name);
  const amt = Number.isFinite(lineTotal) ? lineTotal : 0;

  // 折扣优先：负金额或折扣关键字
  if (amt < 0 || includesAny(n, DISCOUNT_KEYWORDS)) return 'discount';
  if (includesAny(n, TAX_KEYWORDS)) return 'tax';
  if (includesAny(n, SUBTOTAL_KEYWORDS)) return 'subtotal';
  return 'item';
}

/** 新一级分类（ProductCategory）也是合法 categoryKey；uncategorized 无信息量，丢弃。 */
const VALID_NEW_CATEGORY_KEYS = new Set<string>(
  (PRODUCT_CATEGORIES as readonly string[]).filter((c) => c !== 'uncategorized')
);

/**
 * 清洗 OCR categoryKey：允许“旧固定枚举 + 新一级分类(ProductCategory)”；
 * 店铺类型词（コンビニ/スーパー/非超市…）或未知一律返回 undefined。
 * 说明：OCR prompt 现已输出新分类（如 snacks_drinks），若仍只认旧枚举会被整段丢弃，
 *       导致 OCR categoryKey 这一辅助信号丢失。这里同时接受新枚举以保留辅助 fallback。
 */
export function sanitizeOcrCategoryKey(
  raw: unknown
): CategoryKey | ProductCategory | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if ((VALID_CATEGORY_KEYS as readonly string[]).includes(v)) return v as CategoryKey;
  if (VALID_NEW_CATEGORY_KEYS.has(v)) return v as ProductCategory;
  return undefined;
}

/**
 * 金额对账：分别按"外税(items+discount+tax)"与"内税(items+discount)"两种口径与 total 比较，
 * 任一口径在容差内即视为一致；都不一致则给出 warning，不修改结构。
 */
export function reconcileReceiptTotals(
  itemsPositiveSum: number,
  discountsSum: number,
  tax: number,
  total: number,
  toleranceJpy = 2
): ReceiptReconciliation {
  const items = Math.round(itemsPositiveSum);
  const disc = Math.round(discountsSum); // 负数
  const t = Math.round(Number.isFinite(tax) ? tax : 0);
  const tot = Math.round(Number.isFinite(total) ? total : 0);

  const warnings: string[] = [];
  // total 缺失/为 0 时不做对账（避免误报）
  if (!tot) {
    return { ok: true, itemsPositiveSum: items, discountsSum: disc, tax: t, total: tot, diff: 0, warnings };
  }

  const expectedExclTax = items + disc + t; // 外税
  const expectedInclTax = items + disc; // 内税（商品价已含税）
  const diffExcl = Math.abs(expectedExclTax - tot);
  const diffIncl = Math.abs(expectedInclTax - tot);
  const diff = Math.min(diffExcl, diffIncl);
  const ok = diff <= toleranceJpy;
  if (!ok) {
    warnings.push(
      `amount_mismatch: items(${items}) + discounts(${disc}) [+tax(${t})] != total(${tot}), minDiff=${diff}`
    );
  }
  return { ok, itemsPositiveSum: items, discountsSum: disc, tax: t, total: tot, diff, warnings };
}

export type NormalizedOcrAnalysis = ReceiptAnalysis & {
  merchant_normalized?: string;
  discounts?: ReceiptDiscount[];
  reconciliation?: ReceiptReconciliation;
  amount_mismatch?: boolean;
};

/**
 * 对一次 OCR 的 analysis 做确定性后处理：剔除折扣/税/小计行、清洗分类、归一化店铺名、金额对账。
 * 返回新对象（不修改入参）。下游分类增强应使用本函数的输出。
 */
export function normalizeOcrAnalysis(analysis: ReceiptAnalysis): NormalizedOcrAnalysis {
  const rawItems = Array.isArray(analysis.items) ? analysis.items : [];
  const keptItems: ReceiptItem[] = [];
  const discounts: ReceiptDiscount[] = [];

  // Preserve discounts already returned by the OCR edge (if any).
  const incomingDiscounts = Array.isArray((analysis as NormalizedOcrAnalysis).discounts)
    ? ((analysis as NormalizedOcrAnalysis).discounts as ReceiptDiscount[])
    : [];
  for (const d of incomingDiscounts) {
    const amount = Number(d?.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    discounts.push({
      label: typeof d?.label === 'string' && d.label.trim() ? d.label : '値引',
      amount: amount < 0 ? amount : -Math.abs(amount),
    });
  }

  for (const it of rawItems) {
    const name = typeof it?.name === 'string' ? it.name : '';
    const lineTotal = Number.isFinite(Number(it?.lineTotal)) ? Number(it.lineTotal) : 0;
    const kind = classifyLineKind(name, lineTotal);

    if (kind === 'discount') {
      discounts.push({ label: name || '値引', amount: lineTotal <= 0 ? lineTotal : -Math.abs(lineTotal) });
      continue;
    }
    if (kind === 'tax' || kind === 'subtotal') {
      // 税/小计/合计行不是商品，剔除（税额走 analysis.tax，合计走 analysis.total）
      continue;
    }

    keptItems.push({
      name,
      quantity: Number.isFinite(Number(it?.quantity)) && Number(it.quantity) > 0 ? Number(it.quantity) : 1,
      unitPrice: Number.isFinite(Number(it?.unitPrice)) ? Number(it.unitPrice) : 0,
      lineTotal,
      categoryKey: sanitizeOcrCategoryKey((it as any)?.categoryKey),
    });
  }

  const allocated = applyReceiptDiscountsToItems(keptItems, discounts);
  const itemsPositiveSum = allocated.items.reduce(
    (s, it) => s + (it.lineTotal > 0 ? it.lineTotal : 0),
    0
  );
  const discountsSum = discounts.reduce((s, d) => s + (d.amount < 0 ? d.amount : -Math.abs(d.amount)), 0);
  const tax = Number.isFinite(analysis.tax) ? analysis.tax : 0;
  const total = Number.isFinite(analysis.total) ? analysis.total : 0;
  const reconciliation = reconcileReceiptTotals(itemsPositiveSum, discountsSum, tax, total);

  const merchant_normalized = normalizeMerchant(analysis.merchant);

  return {
    ...analysis,
    items: allocated.items,
    merchant_normalized,
    // Keep full coupon list (bound + unbound) for audit; binding is on items.
    discounts,
    reconciliation,
    amount_mismatch: !reconciliation.ok,
  };
}
