/**
 * 历史列表展示用辅助：从 analysis_json 提取 TopN 分类预览文案。
 */

import { isGroceryCategory, isExcludedFromAnalytics } from './categories';
import { getCategoryLabel } from './categoryPalette';

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
    const key = String(it?.category ?? it?.categoryKey ?? '').trim();
    if (!key || key === 'non_grocery' || isExcludedFromAnalytics(key)) continue;
    const status = (it as any).classification_status as string | undefined;
    if (status !== undefined && status !== 'ok' && status !== 'fallback') continue;
    if (!isGroceryCategory(key)) continue;

    const lineTotal = safeNumber(it?.lineTotal);
    const quantity = safeNumber(it?.quantity);
    const unitPrice = safeNumber(it?.unitPrice);
    const amount = lineTotal > 0 ? lineTotal : quantity * unitPrice;
    map.set(key, (map.get(key) ?? 0) + safeNumber(amount));
  }

  const arr = Array.from(map.entries())
    .map(([key, amount]) => ({ key, label: getCategoryLabel(key), amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, topN);

  return arr.map((x) => `${x.label} ${Math.round(x.amount)}`);
}

/**
 * 历史列表中日期 + 税的元信息行。
 */
export function buildHistoryMetaLine(
  transactionAt: number | null | undefined,
  createdAt: number,
  taxLabel: string,
  tax: number,
  formatDate: (ts: number) => string
): string {
  const ts = transactionAt || createdAt;
  return `${formatDate(ts)} · ${taxLabel} ${tax}`;
}

