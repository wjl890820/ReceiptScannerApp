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
 */
export function buildHistoryMetaLine(
  transactionAt: number | null | undefined,
  _createdAt: number,
  taxLabel: string,
  tax: number,
  formatDate: (ts: number) => string,
  unknownDateLabel = '—'
): string {
  const datePart =
    transactionAt != null && Number.isFinite(transactionAt) && transactionAt > 0
      ? formatDate(transactionAt)
      : unknownDateLabel;
  return `${datePart} · ${taxLabel} ${tax}`;
}
