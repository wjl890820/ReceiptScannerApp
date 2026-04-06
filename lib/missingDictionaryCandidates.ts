// Aggregates normalized_name lines that are not yet in product_dictionary (same logic as Dev Tools).

import { isExcludedFromAnalytics, isGroceryCategory } from './categories';
import { listReceipts } from './db';
import { getAllProductDictionaryKeys } from './productDictionary';

export type MissingDictionaryCandidate = {
  normalized_name: string;
  count: number;
  /** 小票行上最常见的 legacy category；无有效分类时为 null */
  receiptCategoryLegacy: string | null;
};

/**
 * 与 Settings → Dev Tools「Missing in product_dictionary (Top 100)」同源；
 * 额外附带 receiptCategoryLegacy 供列表展示「当前分类 / 未分类」。
 */
export async function getMissingInProductDictionaryTop100(
  receiptLimit = 1500,
  topN = 100
): Promise<MissingDictionaryCandidate[]> {
  const [receipts, dictKeys] = await Promise.all([
    listReceipts(receiptLimit),
    getAllProductDictionaryKeys(),
  ]);
  const dictSet = new Set(dictKeys);
  const agg = new Map<string, { count: number; catCounts: Map<string, number> }>();

  for (const r of receipts) {
    let items: any[] = [];
    try {
      if (r.user_edited === 1 && r.user_items_json) {
        items = JSON.parse(r.user_items_json || '[]');
      } else {
        const analysis = JSON.parse(r.analysis_json || '{}');
        items = Array.isArray(analysis?.items) ? analysis.items : [];
      }
    } catch {
      continue;
    }
    for (const it of items) {
      const nn = String((it as any)?.normalized_name || '').trim().toLowerCase();
      if (!nn) continue;
      if (dictSet.has(nn)) continue;

      let entry = agg.get(nn);
      if (!entry) {
        entry = { count: 0, catCounts: new Map() };
        agg.set(nn, entry);
      }
      entry.count += 1;

      const cat = String((it as any)?.category || '').trim();
      if (cat && isGroceryCategory(cat) && !isExcludedFromAnalytics(cat)) {
        entry.catCounts.set(cat, (entry.catCounts.get(cat) ?? 0) + 1);
      }
    }
  }

  const rows: MissingDictionaryCandidate[] = [];
  for (const [normalized_name, data] of agg) {
    let receiptCategoryLegacy: string | null = null;
    if (data.catCounts.size > 0) {
      const sorted = Array.from(data.catCounts.entries()).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      );
      receiptCategoryLegacy = sorted[0][0];
    }
    rows.push({ normalized_name, count: data.count, receiptCategoryLegacy });
  }

  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, Math.max(0, topN));
}
