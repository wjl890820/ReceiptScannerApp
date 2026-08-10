// lib/growthAnalysisEngineV1.ts
// Growth-oriented structured analysis outputs (no AI copywriting).

import type { ReceiptRow } from './db';
import { getReceiptItems } from './receiptItems';
import { filterV1SupportedReceipts } from './merchantType';
import type { AnalysisLevel } from './analysisTriggers';
import { getAnalysisLevel } from './analysisTriggers';
import { normalizeProductCategory, type ProductCategory } from './productCategory';

export type ReceiptAnalysisOutputV1 = {
  shopping_type:
    | 'cook_stockup'
    | 'ready_to_eat'
    | 'snacks_beverages'
    | 'household_restock'
    | 'bulk_stockup'
    | 'mixed'
    | 'unknown';
  shopping_signals: Array<{ key: string; value?: string | number }>;
  // 比例口径统一到新 8 类（不再输出 ingredients/snacks/beverages/prepared_food 等旧名）。
  ratios: Record<ProductCategory, number>;
  top_categories: Array<{ category_main: ProductCategory; amount: number; pct: number }>;
  suggestions_seed: string[];
};

export type AggregateAnalysisOutputV1 = {
  analysis_level: AnalysisLevel;
  dominant_shopping_pattern: ReceiptAnalysisOutputV1['shopping_type'];
  repeated_categories: Array<{ category_main: ProductCategory; count: number }>;
  repeated_items: Array<{ normalized_name: string; count: number }>;
  consumption_style_signals: Array<{ key: string; value?: string | number }>;
  trend_signals: Array<{ key: string; value?: string | number }>;
};

export type WeeklyReportV1 = {
  period: 'weekly';
  total_spend: number;
  main_category_breakdown: Array<{ category_main: ProductCategory; amount: number; pct: number }>;
  top_items: Array<{ normalized_name: string; amount: number; count: number }>;
  snack_beverage_share: number;
  household_restock_candidates: Array<{ normalized_name: string; count: number }>;
};

export type MonthlyReportV1 = {
  period: 'monthly';
  total_spend: number;
  main_category_breakdown: Array<{ category_main: ProductCategory; amount: number; pct: number }>;
  top_items: Array<{ normalized_name: string; amount: number; count: number }>;
  shopping_pattern_changes: Array<{ key: string; value?: string | number }>;
};

export type AnalysisOutputsV1 = {
  receipt_level?: ReceiptAnalysisOutputV1;
  aggregate_level?: AggregateAnalysisOutputV1;
  weekly?: WeeklyReportV1;
  monthly?: MonthlyReportV1;
};

function safeNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function readItemsFromAnalysisJson(analysisJson: string): any[] {
  try {
    const obj = JSON.parse(analysisJson || '{}');
    return Array.isArray(obj?.items) ? obj.items : [];
  } catch {
    return [];
  }
}

/** 将任意来源的商品分类归一到新 8 类（item.category 优先，回退 category_main / 商品名）。 */
function itemMainCategory(it: any): ProductCategory {
  return normalizeProductCategory(
    it?.category ?? it?.category_main,
    it?.normalized_name ?? it?.name
  );
}

function sumByMain(items: any[]): Map<ProductCategory, number> {
  const m = new Map<ProductCategory, number>();
  for (const it of items) {
    const lt = safeNum(it?.line_total ?? it?.lineTotal);
    if (lt <= 0) continue;
    const main = itemMainCategory(it);
    m.set(main, (m.get(main) ?? 0) + lt);
  }
  return m;
}

function totalsum<K>(map: Map<K, number>): number {
  let s = 0;
  for (const v of map.values()) s += v;
  return s;
}

function pct(amount: number, total: number): number {
  return total > 0 ? (amount / total) * 100 : 0;
}

export function buildReceiptAnalysisV1(params: {
  items: any[];
  total?: number;
}): ReceiptAnalysisOutputV1 {
  const items = Array.isArray(params.items) ? params.items : [];
  const mainMap = sumByMain(items);
  const total = totalsum(mainMap) || safeNum(params.total);

  const ratios: ReceiptAnalysisOutputV1['ratios'] = {
    food_ingredients: pct(mainMap.get('food_ingredients') ?? 0, total),
    ready_to_eat: pct(mainMap.get('ready_to_eat') ?? 0, total),
    snacks_drinks: pct(mainMap.get('snacks_drinks') ?? 0, total),
    household: pct(mainMap.get('household') ?? 0, total),
    personal_care: pct(mainMap.get('personal_care') ?? 0, total),
    pet_care: pct(mainMap.get('pet_care') ?? 0, total),
    other: pct(mainMap.get('other') ?? 0, total),
    uncategorized: pct(mainMap.get('uncategorized') ?? 0, total),
  };

  const top_categories = Array.from(mainMap.entries())
    .map(([k, amount]) => ({ category_main: k, amount, pct: pct(amount, total) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);

  // Determine shopping_type based on ratios + tags
  const tagCounts = new Map<string, number>();
  for (const it of items) {
    const tags: any[] = Array.isArray(it?.analysis_tags) ? it.analysis_tags : [];
    for (const t of tags) tagCounts.set(String(t), (tagCounts.get(String(t)) ?? 0) + 1);
  }
  const ready = tagCounts.get('ready_to_eat') ?? 0;
  const ingredient = tagCounts.get('ingredient') ?? 0;
  const household = tagCounts.get('household_essential') ?? 0;

  let shopping_type: ReceiptAnalysisOutputV1['shopping_type'] = 'mixed';
  if (total <= 0) shopping_type = 'unknown';
  else if (ratios.food_ingredients >= 55 && ingredient >= Math.max(2, Math.floor(items.length * 0.3))) shopping_type = 'cook_stockup';
  else if (ratios.ready_to_eat >= 45 || ready >= Math.max(2, Math.floor(items.length * 0.3))) shopping_type = 'ready_to_eat';
  else if (ratios.snacks_drinks >= 55) shopping_type = 'snacks_beverages';
  else if (ratios.household >= 45 || household >= 2) shopping_type = 'household_restock';
  else if (items.length >= 18 || total >= 12000) shopping_type = 'bulk_stockup';

  const shopping_signals: ReceiptAnalysisOutputV1['shopping_signals'] = [
    { key: 'items_count', value: items.length },
    { key: 'total_amount', value: total },
  ];

  const suggestions_seed: string[] = [];
  if (shopping_type === 'ready_to_eat') suggestions_seed.push('consider_ingredients_balance');
  if (shopping_type === 'snacks_beverages') suggestions_seed.push('monitor_non_essential');
  if ((ratios.uncategorized ?? 0) >= 35) suggestions_seed.push('improve_item_categorization');

  return {
    shopping_type,
    shopping_signals,
    ratios,
    top_categories,
    suggestions_seed,
  };
}

export function buildAggregateAnalysisV1(receipts: ReceiptRow[]): AggregateAnalysisOutputV1 {
  const supported = filterV1SupportedReceipts(receipts);
  const receiptCount = supported.length;
  const analysis_level = getAnalysisLevel(receiptCount);

  // Aggregate mains + repeated items
  const mainCounts = new Map<ProductCategory, number>();
  const itemCounts = new Map<string, number>();
  const shoppingTypeCounts = new Map<string, number>();

  for (const r of supported) {
    const list = getReceiptItems(r) as any[];
    const receiptOut = buildReceiptAnalysisV1({ items: list, total: r.total });
    shoppingTypeCounts.set(receiptOut.shopping_type, (shoppingTypeCounts.get(receiptOut.shopping_type) ?? 0) + 1);

    for (const it of list) {
      const main = itemMainCategory(it);
      mainCounts.set(main, (mainCounts.get(main) ?? 0) + 1);
      const nn = String(it?.normalized_name || it?.name || '').trim();
      if (nn) itemCounts.set(nn, (itemCounts.get(nn) ?? 0) + 1);
    }
  }

  const dominant_shopping_pattern = Array.from(shoppingTypeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] as any || 'unknown';

  const repeated_categories = Array.from(mainCounts.entries())
    .map(([category_main, count]) => ({ category_main, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const repeated_items = Array.from(itemCounts.entries())
    .map(([normalized_name, count]) => ({ normalized_name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const consumption_style_signals: Array<{ key: string; value?: string | number }> = [
    { key: 'receipts_count', value: receiptCount },
  ];
  const trend_signals: Array<{ key: string; value?: string | number }> = [];

  return {
    analysis_level,
    dominant_shopping_pattern,
    repeated_categories,
    repeated_items,
    consumption_style_signals,
    trend_signals,
  };
}

export function buildWeeklyReportV1(receipts: ReceiptRow[]): WeeklyReportV1 {
  const supported = filterV1SupportedReceipts(receipts);
  const now = Date.now();
  const weekStart = now - 7 * 24 * 60 * 60 * 1000;
  const inWeek = supported.filter((r) => (r.transaction_at || r.created_at) >= weekStart);

  let total_spend = 0;
  const mainMap = new Map<ProductCategory, number>();
  const itemAgg = new Map<string, { amount: number; count: number }>();
  const householdCandidates = new Map<string, number>();

  for (const r of inWeek) {
    total_spend += safeNum(r.total);
    const list = getReceiptItems(r) as any[];
    const m = sumByMain(list);
    for (const [k, v] of m.entries()) mainMap.set(k, (mainMap.get(k) ?? 0) + v);

    for (const it of list) {
      const nn = String(it?.normalized_name || it?.name || '').trim();
      const lt = safeNum(it?.line_total ?? it?.lineTotal);
      if (!nn || lt <= 0) continue;
      const cur = itemAgg.get(nn) ?? { amount: 0, count: 0 };
      cur.amount += lt;
      cur.count += 1;
      itemAgg.set(nn, cur);
      const tags: any[] = Array.isArray(it?.analysis_tags) ? it.analysis_tags : [];
      if (tags.includes('household_essential')) householdCandidates.set(nn, (householdCandidates.get(nn) ?? 0) + 1);
    }
  }

  const mainTotal = totalsum(mainMap);
  const main_category_breakdown = Array.from(mainMap.entries())
    .map(([category_main, amount]) => ({ category_main, amount, pct: pct(amount, mainTotal) }))
    .sort((a, b) => b.amount - a.amount);

  const top_items = Array.from(itemAgg.entries())
    .map(([normalized_name, v]) => ({ normalized_name, amount: v.amount, count: v.count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);

  const snack_beverage_share = pct(mainMap.get('snacks_drinks') ?? 0, mainTotal);

  const household_restock_candidates = Array.from(householdCandidates.entries())
    .map(([normalized_name, count]) => ({ normalized_name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    period: 'weekly',
    total_spend,
    main_category_breakdown,
    top_items,
    snack_beverage_share,
    household_restock_candidates,
  };
}

export function buildMonthlyReportV1(receipts: ReceiptRow[]): MonthlyReportV1 {
  const supported = filterV1SupportedReceipts(receipts);
  const now = Date.now();
  const start = now - 30 * 24 * 60 * 60 * 1000;
  const inMonth = supported.filter((r) => (r.transaction_at || r.created_at) >= start);

  let total_spend = 0;
  const mainMap = new Map<ProductCategory, number>();
  const itemAgg = new Map<string, { amount: number; count: number }>();

  for (const r of inMonth) {
    total_spend += safeNum(r.total);
    const list = getReceiptItems(r) as any[];
    const m = sumByMain(list);
    for (const [k, v] of m.entries()) mainMap.set(k, (mainMap.get(k) ?? 0) + v);
    for (const it of list) {
      const nn = String(it?.normalized_name || it?.name || '').trim();
      const lt = safeNum(it?.line_total ?? it?.lineTotal);
      if (!nn || lt <= 0) continue;
      const cur = itemAgg.get(nn) ?? { amount: 0, count: 0 };
      cur.amount += lt;
      cur.count += 1;
      itemAgg.set(nn, cur);
    }
  }

  const mainTotal = totalsum(mainMap);
  const main_category_breakdown = Array.from(mainMap.entries())
    .map(([category_main, amount]) => ({ category_main, amount, pct: pct(amount, mainTotal) }))
    .sort((a, b) => b.amount - a.amount);

  const top_items = Array.from(itemAgg.entries())
    .map(([normalized_name, v]) => ({ normalized_name, amount: v.amount, count: v.count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  return {
    period: 'monthly',
    total_spend,
    main_category_breakdown,
    top_items,
    shopping_pattern_changes: [],
  };
}

