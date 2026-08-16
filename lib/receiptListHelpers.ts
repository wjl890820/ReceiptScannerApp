/**
 * 历史列表展示用辅助：从 analysis_json 提取 TopN 分类预览文案。
 */

import { isGroceryCategory, isExcludedFromAnalytics } from './categories';
import { getCategoryLabel } from './categoryPalette';
import { itemAmountForAnalytics } from './receiptDiscountAllocation';
import { normalizeProductCategory } from './productCategory';

function safeNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从 ReceiptRow.analysis_json 提取：仅 ok + 有效 grocery 分类的 TopN 预览标签。
 * 不包含 non_grocery / uncategorized / failed；标签统一走 getCategoryLabel。
 */
export function buildTopCategories(
  analysisJson: string | null | undefined,
  topN = 2
): string[] {
  if (!analysisJson) return [];

  let parsed: { items?: any[] };
  try {
    parsed = JSON.parse(analysisJson);
  } catch {
    return [];
  }

  const items: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
  if (items.length === 0) return [];

  const map = new Map<string, number>();

  for (const it of items) {
    const status = (it as any).classification_status as string | undefined;
    if (status !== undefined && status !== 'ok' && status !== 'fallback') continue;
    const key = normalizeProductCategory(
      it?.category ?? it?.categoryKey,
      typeof it?.name === 'string' ? it.name : undefined
    );
    if (isExcludedFromAnalytics(key) || !isGroceryCategory(key)) continue;

    const amount = itemAmountForAnalytics(it);
    const quantity = safeNumber(it?.quantity);
    const unitPrice = safeNumber(it?.unitPrice);
    const resolved = amount > 0 ? amount : quantity * unitPrice;
    if (resolved <= 0) continue;
    map.set(key, (map.get(key) ?? 0) + resolved);
  }

  const arr = Array.from(map.entries())
    .map(([key, amount]) => ({ key, label: getCategoryLabel(key), amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, topN);

  return arr.map((x) => `${x.label} ${Math.round(x.amount)}`);
}

/**
 * 历史列表中日期 + 税的元信息行。
 * Never pretend created_at is the purchase datetime.
 * Unknown tax (tax_is_known=0) must not display as a fake "税 0".
 */
export function buildHistoryMetaLine(
  transactionAt: number | null | undefined,
  _createdAt: number,
  taxLabel: string,
  tax: number | null | undefined,
  formatDate: (ts: number) => string,
  unknownDateLabel = '—',
  unknownTaxLabel = '待确认',
  taxIsKnown?: boolean | number | null
): string {
  const datePart =
    transactionAt != null && Number.isFinite(transactionAt) && transactionAt > 0
      ? formatDate(transactionAt)
      : unknownDateLabel;
  const known = taxIsKnown === true || taxIsKnown === 1;
  const taxPart =
    known && tax != null && Number.isFinite(tax)
      ? `${taxLabel} ${tax}`
      : `${taxLabel} ${unknownTaxLabel}`;
  return `${datePart} · ${taxPart}`;
}

/** True when receipt tax is evidence-backed (including explicit printed 0). */
export function isReceiptTaxKnown(
  taxIsKnown: boolean | number | null | undefined
): boolean {
  return taxIsKnown === true || taxIsKnown === 1;
}

/**
 * Review tax input prefill: unknown storage tax=0 must not become the string "0",
 * or save would incorrectly mark tax_is_known=1.
 */
export function taxFieldPrefillFromSnapshot(snap: {
  tax?: number | null;
  tax_is_known?: boolean | number | null;
} | null | undefined): string {
  if (!snap) return '';
  if (!isReceiptTaxKnown(snap.tax_is_known)) return '';
  if (typeof snap.tax === 'number' && Number.isFinite(snap.tax)) return String(snap.tax);
  return '';
}
