// lib/structuredAnalysisEngine.ts
// Minimal structured analysis output (no AI copywriting).

import type { MainCategory, SubCategory, AnalysisTag } from './categoryTaxonomyV1';

export type ReceiptStructuredAnalysisV1 = {
  shopping_type: 'grocery' | 'mixed' | 'unknown';
  main_category_breakdown: Array<{ category_main: MainCategory; amount: number; pct: number }>;
  sub_category_breakdown: Array<{ category_sub: SubCategory; amount: number; pct: number }>;
  analysis_tags_summary: Array<{ tag: AnalysisTag; count: number }>;
  top_items: Array<{ normalized_name: string; line_total: number; category_main: MainCategory; category_sub: SubCategory | null }>;
  signals: Array<{ key: string; value?: string | number }>;
};

function safeNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function buildReceiptStructuredAnalysis(input: {
  merchant?: string;
  items: any[];
  total: number;
  tax: number;
  currency: string;
}): ReceiptStructuredAnalysisV1 {
  const items = Array.isArray(input.items) ? input.items : [];
  const mainMap = new Map<string, number>();
  const subMap = new Map<string, number>();
  const tagMap = new Map<string, number>();

  for (const it of items) {
    const lt = safeNum(it?.line_total ?? it?.lineTotal);
    if (lt <= 0) continue;
    const main = String(it?.category_main || 'uncategorized');
    const sub = it?.category_sub ? String(it.category_sub) : '';
    mainMap.set(main, (mainMap.get(main) ?? 0) + lt);
    if (sub) subMap.set(sub, (subMap.get(sub) ?? 0) + lt);

    const tags: any[] = Array.isArray(it?.analysis_tags) ? it.analysis_tags : [];
    for (const t of tags) {
      const key = String(t);
      tagMap.set(key, (tagMap.get(key) ?? 0) + 1);
    }
  }

  const mainTotal = Array.from(mainMap.values()).reduce((a, b) => a + b, 0);
  const subTotal = Array.from(subMap.values()).reduce((a, b) => a + b, 0);

  const main_category_breakdown = Array.from(mainMap.entries())
    .map(([k, amount]) => ({
      category_main: k as MainCategory,
      amount,
      pct: mainTotal > 0 ? (amount / mainTotal) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const sub_category_breakdown = Array.from(subMap.entries())
    .map(([k, amount]) => ({
      category_sub: k as SubCategory,
      amount,
      pct: subTotal > 0 ? (amount / subTotal) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const analysis_tags_summary = Array.from(tagMap.entries())
    .map(([tag, count]) => ({ tag: tag as AnalysisTag, count }))
    .sort((a, b) => b.count - a.count);

  const top_items = items
    .map((it) => ({
      normalized_name: String(it?.normalized_name || it?.name || ''),
      line_total: safeNum(it?.line_total ?? it?.lineTotal),
      category_main: String(it?.category_main || 'uncategorized') as MainCategory,
      category_sub: (it?.category_sub ? String(it.category_sub) : null) as SubCategory | null,
    }))
    .filter((x) => x.line_total > 0)
    .sort((a, b) => b.line_total - a.line_total)
    .slice(0, 5);

  const shopping_type: ReceiptStructuredAnalysisV1['shopping_type'] = mainTotal > 0 ? 'grocery' : 'unknown';

  return {
    shopping_type,
    main_category_breakdown,
    sub_category_breakdown,
    analysis_tags_summary,
    top_items,
    signals: [
      { key: 'currency', value: input.currency },
      { key: 'items_count', value: items.length },
    ],
  };
}

