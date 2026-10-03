/**
 * History Detail item source selection and category-row construction.
 * user_items_json wins only when it parses to a nonempty array.
 * Otherwise the displayed items are analysis_json.items.
 */

import { itemAmountForAnalytics } from './receiptDiscountAllocation';
import { normalizePersistedProductCategory } from './productCategory';

export type HistoryDetailCategoryRow = {
  category: string;
  amount: number;
};

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round0(n: number): number {
  return Math.round(n);
}

/** Amount for summary: shared analytics resolver (user override > effective > gross). */
function itemLineAmountForSummary(it: any): number {
  const amount = itemAmountForAnalytics(it);
  if (amount > 0) return round0(amount);
  const qRaw = toNum(it.quantity, 0);
  const q = qRaw > 0 ? qRaw : 1;
  const up = toNum(it.unitPrice ?? it.unit_price, 0);
  return up > 0 ? round0(up * q) : 0;
}

/** Same contract as the former page-local safeParseItems. */
export function parseHistoryDetailUserItems(
  json: string | null | undefined
): unknown[] | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return null;
    return arr;
  } catch {
    return null;
  }
}

export function selectHistoryDetailDisplayItems<T>(input: {
  userItemsJson: string | null | undefined;
  analysisItems?: readonly T[] | null;
}): T[] {
  const userItems = parseHistoryDetailUserItems(input.userItemsJson);
  if (userItems && userItems.length > 0) {
    return userItems as T[];
  }
  return (input.analysisItems ?? []) as T[];
}

export function historyDetailDisplayItemSource(
  userItemsJson: string | null | undefined
): 'user_items_json' | 'analysis_json.items' {
  const userItems = parseHistoryDetailUserItems(userItemsJson);
  return userItems && userItems.length > 0
    ? 'user_items_json'
    : 'analysis_json.items';
}

/**
 * Category rows for the rendered summary.
 * Trust stored category semantics. Do not invent a category from the name
 * when the stored value is uncategorized.
 */
export function buildHistoryDetailCategorySummary(
  items: readonly unknown[] | null | undefined
): HistoryDetailCategoryRow[] {
  const map = new Map<string, number>();
  if (!items?.length) return [];

  for (const it of items) {
    const item = it as {
      classification_status?: string;
      category?: unknown;
      categoryKey?: unknown;
      name?: unknown;
    };
    const status = item.classification_status;
    if (status !== undefined && status !== 'ok' && status !== 'fallback') continue;
    const rawCat =
      (typeof item.category === 'string' && item.category) ||
      (typeof item.categoryKey === 'string' && item.categoryKey) ||
      '';
    const cat = normalizePersistedProductCategory(
      rawCat,
      typeof item.name === 'string' ? item.name : undefined
    );
    const amt = itemLineAmountForSummary(item);
    map.set(cat, (map.get(cat) ?? 0) + amt);
  }

  const arr = Array.from(map.entries()).map(([category, amount]) => ({
    category,
    amount,
  }));
  arr.sort((a, b) => b.amount - a.amount);
  return arr;
}
