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
import {
  V1_ACTIVE_PRODUCT_CATEGORIES,
  type ProductCategory,
} from './productCategory';
import {
  isPaymentAllocationLabel,
  resolveAuthoritativeReceiptTotal,
} from './receiptTotalResolve';
import { detectCostcoReceiptSignals } from './groceryDetector';
import {
  applyReceiptDiscountsToItems,
  isBundleSummaryDiscountLabel,
} from './receiptDiscountAllocation';
import { resolvePurchaseQuantity } from './purchaseQuantity';

export type OcrLineKind = 'item' | 'discount' | 'tax' | 'subtotal' | 'payment' | 'unknown';

export type ReceiptDiscount = {
  label: string;
  amount: number;
  /** OCR order: preceding kept item index for safe まとめ売り allocation. */
  adjacentPrecedingItemIndex?: number | null;
};

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

/** Coupon noise ignored when matching explicit discounts[] to negative item lines. */
const DISCOUNT_IDENTITY_NOISE = [
  'cpn',
  'coupon',
  'クーポン',
  '値引',
  '値引き',
  '割引',
  'わりびき',
  'セール',
  'discount',
  'off',
];

/**
 * Conservative logical-discount identity: normalized content tokens + |amount|.
 * Does NOT dedupe by amount alone (two different -600 coupons stay distinct).
 *
 * Strips qty/price annotation tokens so Edge dual representation like
 * "まとめ売り値引 2個¥203" and "▲まとめ売り値引" share one identity.
 */
export function normalizeDiscountIdentityLabel(label: string): string {
  let s = toHalfWidthLower(label || '').replace(/[^\p{L}\p{N}]+/gu, ' ');
  for (const noise of DISCOUNT_IDENTITY_NOISE) {
    s = s.replace(new RegExp(noise, 'gi'), ' ');
  }
  // Drop group-price / pack annotations before tokenization (2個¥203 × 1組).
  s = s
    .replace(/\d+\s*個/g, ' ')
    .replace(/\d+\s*組/g, ' ')
    .replace(/\d+\s*入/g, ' ')
    .replace(/\d+\s*点/g, ' ')
    .replace(/\d+/g, ' ');
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .sort()
    .join(' ');
}

function discountIdentityKey(d: ReceiptDiscount): string {
  const amt = Math.abs(Math.round(Number(d.amount) || 0));
  return `${normalizeDiscountIdentityLabel(d.label)}|${amt}`;
}

function discountDedupKey(d: ReceiptDiscount): string {
  const base = discountIdentityKey(d);
  if (typeof d.adjacentPrecedingItemIndex === 'number') {
    return `${base}|adj:${d.adjacentPrecedingItemIndex}`;
  }
  return base;
}

/** Append discount unless the same logical coupon is already present. */
export function pushUniqueReceiptDiscount(
  discounts: ReceiptDiscount[],
  next: ReceiptDiscount
): void {
  const amount = Number(next.amount);
  if (!Number.isFinite(amount) || amount === 0) return;
  const row: ReceiptDiscount = {
    label: typeof next.label === 'string' && next.label.trim() ? next.label.trim() : '値引',
    amount: amount < 0 ? amount : -Math.abs(amount),
  };
  if (typeof next.adjacentPrecedingItemIndex === 'number') {
    row.adjacentPrecedingItemIndex = next.adjacentPrecedingItemIndex;
  }
  const key = discountDedupKey(row);
  const logicalKey = discountIdentityKey(row);
  let existing =
    discounts.find((d) => discountDedupKey(d) === key) ??
    discounts.find((d) => {
      if (discountIdentityKey(d) !== logicalKey) return false;
      const adjA = d.adjacentPrecedingItemIndex;
      const adjB = row.adjacentPrecedingItemIndex;
      if (adjA == null || adjB == null) return true;
      return adjA === adjB;
    });
  if (existing) {
    // Prefer adjacency captured from OCR item order when discounts[] arrived first.
    if (
      existing.adjacentPrecedingItemIndex == null &&
      typeof row.adjacentPrecedingItemIndex === 'number'
    ) {
      existing.adjacentPrecedingItemIndex = row.adjacentPrecedingItemIndex;
    }
    return;
  }
  discounts.push(row);
}

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

const SUBTOTAL_KEYWORDS = [
  '小計',
  '小 計',
  '合計',
  '合 計',
  'お買上計',
  'お買上げ計',
  'お買い上げ計',
  'お買い上げ金額',
  'subtotal',
  'total',
  '総計',
];

/** Costco / grocery purchase-count meta — not merchandise. */
function isPurchaseCountMetaLabel(name: string): boolean {
  const n = toHalfWidthLower(name);
  return /御買上げ点数|お買上げ点数|お買上点数|買上点数|商品点数|購入点数|合計点数|会員番号/.test(
    n
  );
}

/** Taxable base / 対象額 — NEVER treat as actual tax. */
export function isTaxableBaseLabel(name: string): boolean {
  const n = toHalfWidthLower(name);
  if (!n) return false;
  if (/消費税|外税額|内消費税|税額/.test(n) && !/対象/.test(n)) return false;
  return /対象額|課税対象|税抜対象|税率\s*\d+\s*%\s*対象|内税率.*対象|外税.*対象/.test(n);
}

/** Printed actual tax amount lines (included or external). */
export function isActualTaxAmountLabel(name: string): boolean {
  const n = toHalfWidthLower(name);
  if (!n) return false;
  if (isTaxableBaseLabel(n)) return false;
  return (
    /消費税等|内消費税等|内消費税|外税額|消費税|税額/.test(n) ||
    (/外税/.test(n) && !/対象/.test(n)) ||
    /\(\s*内\s*消費\s*税/.test(n) ||
    /（\s*内\s*消費\s*税/.test(n)
  );
}

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
 * Display 应优先使用 OCR/用户编辑的 merchant_raw；本函数结果用于 merchant_normalized（聚合键）。
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
  if (n.includes('イオン') || n.includes('aeon')) {
    return 'イオン';
  }
  if (n.includes('コストコ') || n.includes('costco')) {
    return 'コストコ';
  }
  return original;
}

/**
 * Canonical chain key for cross-store aggregation. Falls back to trimmed original.
 */
export function canonicalizeMerchantChain(raw: string | null | undefined): string {
  const original = (raw ?? '').trim();
  if (!original) return '';
  const chain = normalizeMerchant(original);
  return chain || original;
}

function isNonMerchandiseMetaLabel(name: string): boolean {
  const n = toHalfWidthLower(name);
  if (!n) return false;
  // Change / deposit / balance — not merchandise and not settlement tender for total recovery.
  return (
    n.includes('おつり') ||
    n.includes('お釣り') ||
    n.includes('つり銭') ||
    n.includes('釣銭') ||
    (n.includes('預り') && !n.includes('支払')) ||
    (n.includes('あずかり') && !n.includes('支払')) ||
    n.includes('残高') ||
    n.includes('balance') ||
    (/\bchange\b/.test(n) && !n.includes('exchange'))
  );
}

/** Costco Connection publication / membership lines — not purchased merchandise. */
export function isCostcoConnectionNonMerchandiseLine(name: string): boolean {
  const n = toHalfWidthLower(name).replace(/\s+/g, ' ').trim();
  // Register/dept codes OCR'd as MR/MP immediately before the magazine line.
  const core = n.replace(/^(?:mr|mp)(?:\s+|(?=コストコ|costco))/, '').trim();
  if (core === 'コストコ コネクション' || core === 'コストココネクション') return true;
  return (
    core === 'コストコ コネクション ムリョウ' ||
    core === 'コストココネクション ムリョウ' ||
    core === 'コストココネクションムリョウ'
  );
}

/**
 * 判断 OCR 行类型：item / discount / tax / payment / subtotal。
 * 折扣判定：命中折扣关键字，或金额为负。
 * 支付手段（現金 / プリカ 等）不得当作商品或 total。
 */
export function classifyLineKind(name: string, lineTotal: number): OcrLineKind {
  const n = toHalfWidthLower(name);
  const amt = Number.isFinite(lineTotal) ? lineTotal : 0;

  // 折扣优先：负金额或折扣关键字
  if (amt < 0 || includesAny(n, DISCOUNT_KEYWORDS)) return 'discount';
  // Taxable base before generic TAX_KEYWORDS (「税率10%対象」contains 税率).
  if (isTaxableBaseLabel(name)) return 'subtotal';
  if (includesAny(n, TAX_KEYWORDS) || isActualTaxAmountLabel(name)) return 'tax';
  if (isNonMerchandiseMetaLabel(name) || isPurchaseCountMetaLabel(name)) return 'subtotal';
  // Tender / payment allocation — before bare 合計 subtotal matching.
  if (isPaymentAllocationLabel(name)) return 'payment';
  if (includesAny(n, SUBTOTAL_KEYWORDS)) return 'subtotal';
  return 'item';
}

/** 新一级分类（ProductCategory）也是合法 categoryKey；uncategorized 无信息量，丢弃。 */
const VALID_NEW_CATEGORY_KEYS = new Set<string>(
  (V1_ACTIVE_PRODUCT_CATEGORIES as readonly string[]).filter((c) => c !== 'uncategorized')
);

/**
 * 清洗 OCR categoryKey：允许“旧固定枚举 + V1 ACTIVE ProductCategory”；
 * legacy personal_care/pet_care 与店铺类型词一律丢弃（新写入边界）。
 */
export function sanitizeOcrCategoryKey(
  raw: unknown
): CategoryKey | ProductCategory | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'personal_care' || v === 'pet_care') return undefined;
  if ((VALID_CATEGORY_KEYS as readonly string[]).includes(v)) return v as CategoryKey;
  if (VALID_NEW_CATEGORY_KEYS.has(v)) return v as ProductCategory;
  return undefined;
}

/**
 * Resolve printed tax with known/unknown provenance.
 * - Harvested actual tax lines (消費税 / 内消費税等) → known (preferred)
 * - Explicit positive top-level tax → known
 * - taxBreakdown amounts that are NOT taxable bases → sum, known
 * - Bare OCR tax=0 without known marker → unknown
 * - Never invent tax from rates × taxable bases
 */
export type ResolvedReceiptTax = {
  tax: number;
  taxIsKnown: boolean;
};

export function resolveReceiptTax(
  analysis: ReceiptAnalysis & Record<string, unknown>
): ResolvedReceiptTax {
  const top = analysis.tax;
  const priorKnown = (analysis as any).tax_is_known ?? (analysis as any).taxIsKnown;
  const harvested =
    typeof (analysis as any)._harvestedActualTax === 'number' &&
    Number.isFinite((analysis as any)._harvestedActualTax)
      ? Math.round((analysis as any)._harvestedActualTax)
      : harvestActualTaxFromItems(analysis.items);

  // Respect an explicit unknown marker from upstream (e.g. review empty tax field).
  if (priorKnown === false || priorKnown === 0) {
    if (harvested != null && harvested > 0) {
      return { tax: harvested, taxIsKnown: true };
    }
    const breakdownUnknown = sumExplicitTaxBreakdown(analysis);
    if (breakdownUnknown != null) {
      return { tax: breakdownUnknown, taxIsKnown: true };
    }
    return {
      tax: typeof top === 'number' && Number.isFinite(top) ? Math.round(top) : 0,
      taxIsKnown: false,
    };
  }

  // Explicit known marker (review entered 0, or Edge/client asserted known zero).
  if (priorKnown === true || priorKnown === 1) {
    if (typeof top === 'number' && Number.isFinite(top)) {
      return { tax: Math.round(top), taxIsKnown: true };
    }
    if (harvested != null && harvested > 0) {
      return { tax: harvested, taxIsKnown: true };
    }
    const fromBreakdownKnown = sumExplicitTaxBreakdown(analysis);
    if (fromBreakdownKnown != null) {
      return { tax: fromBreakdownKnown, taxIsKnown: true };
    }
    return { tax: 0, taxIsKnown: true };
  }

  // Printed actual tax line(s) win over Edge top-level / breakdown that may include taxable bases.
  if (harvested != null && harvested > 0) {
    return { tax: harvested, taxIsKnown: true };
  }

  const fromBreakdown = sumExplicitTaxBreakdown(analysis);
  if (typeof top === 'number' && Number.isFinite(top) && top > 0) {
    const topRounded = Math.round(top);
    // When Edge summed taxable bases into tax, sanitized breakdown is smaller and
    // the gap equals skipped base-like amounts (Sample 061: 75 = 72 + 3).
    if (
      fromBreakdown != null &&
      topRounded > fromBreakdown &&
      topRounded - fromBreakdown === skippedTaxableBaseAmounts(analysis)
    ) {
      return { tax: fromBreakdown, taxIsKnown: true };
    }
    return { tax: topRounded, taxIsKnown: true };
  }

  if (fromBreakdown != null) {
    return { tax: fromBreakdown, taxIsKnown: true };
  }

  // Missing tax, or bare tax=0 without known provenance → unknown.
  return { tax: 0, taxIsKnown: false };
}

/** Sum printed actual-tax amounts from OCR item rows (before they are stripped). */
export function harvestActualTaxFromItems(
  items: Array<{ name?: string | null; lineTotal?: number | null }> | null | undefined
): number | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  let sum = 0;
  let any = false;
  for (const it of items) {
    const name = typeof it?.name === 'string' ? it.name : '';
    if (!isActualTaxAmountLabel(name)) continue;
    if (isTaxableBaseLabel(name)) continue;
    const amt = Number(it?.lineTotal);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    sum += Math.round(amt);
    any = true;
  }
  return any ? sum : null;
}

function isBreakdownAmountLikelyTaxableBase(rate: number, amount: number): boolean {
  if (!Number.isFinite(rate) || rate < 8) return false;
  if (!Number.isFinite(amount) || amount <= 0) return false;
  // If `amount` were a taxable base at `rate`, tax would round to 0 → not an actual tax line.
  return Math.round((amount * rate) / 100) === 0;
}

function skippedTaxableBaseAmounts(
  analysis: ReceiptAnalysis & Record<string, unknown>
): number {
  const breakdown = (analysis as any).taxBreakdown ?? (analysis as any).tax_breakdown;
  if (!Array.isArray(breakdown) || breakdown.length === 0) return 0;
  let skipped = 0;
  for (const row of breakdown) {
    const label = String(row?.label ?? row?.name ?? row?.description ?? '');
    const amt =
      typeof row?.amount === 'number'
        ? row.amount
        : typeof row?.tax === 'number'
          ? row.tax
          : typeof row?.taxAmount === 'number'
            ? row.taxAmount
            : NaN;
    if (!Number.isFinite(amt) || amt <= 0) continue;
    if (label && isTaxableBaseLabel(label)) {
      skipped += amt;
      continue;
    }
    if (row?.kind === 'taxable_base' || row?.kind === 'base') {
      skipped += amt;
      continue;
    }
    const rate = Number(row?.rate);
    if (isBreakdownAmountLikelyTaxableBase(rate, amt)) {
      skipped += amt;
    }
  }
  return Math.round(skipped);
}

function sumExplicitTaxBreakdown(
  analysis: ReceiptAnalysis & Record<string, unknown>
): number | null {
  const breakdown = (analysis as any).taxBreakdown ?? (analysis as any).tax_breakdown;
  if (!Array.isArray(breakdown) || breakdown.length === 0) return null;
  let sum = 0;
  let any = false;
  for (const row of breakdown) {
    const label = String(row?.label ?? row?.name ?? row?.description ?? '');
    if (label && isTaxableBaseLabel(label)) continue;
    if (row?.kind === 'taxable_base' || row?.kind === 'base') continue;
    const amt =
      typeof row?.amount === 'number'
        ? row.amount
        : typeof row?.tax === 'number'
          ? row.tax
          : typeof row?.taxAmount === 'number'
            ? row.taxAmount
            : NaN;
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const rate = Number(row?.rate);
    if (isBreakdownAmountLikelyTaxableBase(rate, amt)) continue;
    sum += amt;
    any = true;
  }
  if (!any || sum <= 0) return null;
  return Math.round(sum);
}

/** Persist helper: prefer analysis.tax_is_known; else resolve from evidence. */
export function persistReceiptTaxFields(analysis: ReceiptAnalysis & Record<string, unknown>): {
  tax: number;
  taxIsKnown: 0 | 1;
} {
  const prior = (analysis as any).tax_is_known ?? (analysis as any).taxIsKnown;
  if (prior === true || prior === 1) {
    const tax =
      typeof analysis.tax === 'number' && Number.isFinite(analysis.tax)
        ? Math.round(analysis.tax)
        : 0;
    return { tax, taxIsKnown: 1 };
  }
  if (prior === false || prior === 0) {
    const tax =
      typeof analysis.tax === 'number' && Number.isFinite(analysis.tax)
        ? Math.round(analysis.tax)
        : 0;
    return { tax, taxIsKnown: 0 };
  }
  const resolved = resolveReceiptTax(analysis);
  return { tax: resolved.tax, taxIsKnown: resolved.taxIsKnown ? 1 : 0 };
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
  tax_is_known?: boolean;
};

/**
 * 对一次 OCR 的 analysis 做确定性后处理：剔除折扣/税/小计行、清洗分类、归一化店铺名、金额对账。
 * 返回新对象（不修改入参）。下游分类增强应使用本函数的输出。
 */
export function normalizeOcrAnalysis(analysis: ReceiptAnalysis): NormalizedOcrAnalysis {
  const rawItems = Array.isArray(analysis.items) ? analysis.items : [];
  const keptItems: ReceiptItem[] = [];
  const discounts: ReceiptDiscount[] = [];
  const payments: { label: string; amount: number }[] = [];
  const evidenceTexts: string[] = [];
  const rawText =
    typeof (analysis as any).ocr_raw_text === 'string'
      ? (analysis as any).ocr_raw_text
      : typeof (analysis as any).rawText === 'string'
        ? (analysis as any).rawText
        : '';

  // Cropped-header Costco: score on raw OCR rows BEFORE subtotal/meta stripping.
  let merchantOut = typeof analysis.merchant === 'string' ? analysis.merchant : analysis.merchant;
  const costcoPre = detectCostcoReceiptSignals({
    merchant: merchantOut,
    items: rawItems as Array<{ name?: string | null }>,
    rawText,
  });
  if (costcoPre.isCostco) {
    const weak =
      !String(merchantOut || '').trim() ||
      /unknown|未知|biz\s*\/?\s*gold|wholesale/i.test(String(merchantOut || ''));
    if (weak) {
      merchantOut = 'コストコ';
    }
  }

  // Explicit Edge discounts[] first — authoritative labels preferred when both present.
  const incomingDiscounts = Array.isArray((analysis as NormalizedOcrAnalysis).discounts)
    ? ((analysis as NormalizedOcrAnalysis).discounts as ReceiptDiscount[])
    : [];
  for (const d of incomingDiscounts) {
    pushUniqueReceiptDiscount(discounts, {
      label: typeof d?.label === 'string' ? d.label : '値引',
      amount: Number(d?.amount),
      adjacentPrecedingItemIndex: d?.adjacentPrecedingItemIndex,
    });
  }

  for (const it of rawItems) {
    const name = typeof it?.name === 'string' ? it.name : '';
    const lineTotal = Number.isFinite(Number(it?.lineTotal)) ? Number(it.lineTotal) : 0;
    const kind = classifyLineKind(name, lineTotal);

    // Keep group-price / bundle annotation text for Edge-only まとめ売り binding.
    if (/個\s*[¥￥]?\s*\d+|まとめ/.test(name)) {
      evidenceTexts.push(name);
    }

    if (kind === 'discount') {
      // Negative coupon lines often duplicate an entry already in discounts[].
      // Capture OCR adjacency from printed order (ordinary 値引/割引 and まとめ売り).
      pushUniqueReceiptDiscount(discounts, {
        label: name || '値引',
        amount: lineTotal <= 0 ? lineTotal : -Math.abs(lineTotal),
        adjacentPrecedingItemIndex: keptItems.length > 0 ? keptItems.length - 1 : null,
      });
      continue;
    }
    if (kind === 'payment') {
      if (lineTotal > 0) {
        payments.push({ label: name || '支払', amount: Math.round(lineTotal) });
      }
      continue;
    }
    if (kind === 'tax' || kind === 'subtotal') {
      // 税/小计/合计/Costco点数 不是商品；点数文案已进入 evidence / Costco pre-pass。
      continue;
    }
    if (costcoPre.isCostco && isCostcoConnectionNonMerchandiseLine(name)) {
      continue;
    }

    keptItems.push({
      name,
      quantity: resolvePurchaseQuantity(name, it?.quantity),
      unitPrice: Number.isFinite(Number(it?.unitPrice)) ? Number(it.unitPrice) : 0,
      lineTotal,
      categoryKey: sanitizeOcrCategoryKey((it as any)?.categoryKey),
    });
  }

  if (rawText) evidenceTexts.push(rawText);

  // Allocation runs only after discount representations are collapsed.
  const allocated = applyReceiptDiscountsToItems(keptItems, discounts, { evidenceTexts });
  const itemsPositiveSum = allocated.items.reduce(
    (s, it) => s + (it.lineTotal > 0 ? it.lineTotal : 0),
    0
  );
  const discountsSum = discounts.reduce((s, d) => s + (d.amount < 0 ? d.amount : -Math.abs(d.amount)), 0);
  const resolvedTax = resolveReceiptTax(analysis as ReceiptAnalysis & Record<string, unknown>);
  const tax = resolvedTax.tax;
  const total = resolveAuthoritativeReceiptTotal({
    ocrTotal: analysis.total,
    itemsPositiveSum,
    discountsSum,
    payments,
  });
  const reconciliation = reconcileReceiptTotals(itemsPositiveSum, discountsSum, tax, total);

  const merchant_normalized = canonicalizeMerchantChain(merchantOut);

  return {
    ...analysis,
    merchant: merchantOut,
    items: allocated.items,
    total,
    tax: resolvedTax.tax,
    tax_is_known: resolvedTax.taxIsKnown,
    merchant_normalized,
    // Keep full coupon list (bound + unbound) for audit; binding is on items.
    discounts,
    reconciliation,
    amount_mismatch: !reconciliation.ok,
  };
}
