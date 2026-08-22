/**
 * Phase B — Analysis V1 minimal correctness:
 * P0-A user-edited amount vs stale effectiveLineTotal
 * P0-B category composition denominator unification
 */
import {
  applyUserLineAmountEdit,
  applyReceiptDiscountsToItems,
  itemAmountForAnalytics,
} from './receiptDiscountAllocation';
import {
  buildAnalysisCategoryShares,
  buildAnalysisInsightPresentation,
  categoryCompositionPercent,
} from './analysisPresentation';
import { createEmptyStats } from './analysisHelpers';
import { getReceiptItems } from './receiptItems';
import { calculateStats } from './statsCalculator';
import type { ReceiptRow } from './db';

function receiptFixture(
  id: string,
  opts: {
    total: number;
    merchantType?: string;
    analysisItems?: unknown[];
    userItems?: unknown[] | null;
  }
): ReceiptRow {
  const now = Date.now();
  return {
    id,
    created_at: now,
    transaction_at: now,
    image_uri: '',
    total: opts.total,
    tax: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: opts.analysisItems ?? [],
      total: opts.total,
    }),
    merchant_raw: '業務スーパー古川店',
    merchant_normalized: '業務スーパー古川店',
    merchant_type: opts.merchantType ?? 'supermarket',
    user_edited: opts.userItems ? 1 : 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: opts.userItems ? JSON.stringify(opts.userItems) : null,
  } as ReceiptRow;
}

describe('Phase B P0-A — user-edited amount vs discounts', () => {
  it('1 — stale effectiveLineTotal=69 does not win over user lineTotal=70', () => {
    const item = {
      name: 'コカ・コーラやかんの麦茶 特',
      quantity: 1,
      unitPrice: 69,
      lineTotal: 70,
      line_total: 69,
      effectiveLineTotal: 69,
      category: 'snacks_drinks',
    };
    expect(itemAmountForAnalytics(item)).toBe(70);
  });

  it('2 — unedited discounted line still prefers effectiveLineTotal', () => {
    const result = applyReceiptDiscountsToItems(
      [{ name: 'FERRERO ROCHER', lineTotal: 2988, quantity: 1 }],
      [{ label: 'ROCHER CPN', amount: -600 }]
    );
    const item = result.items[0] as {
      lineTotal?: number;
      effectiveLineTotal?: number;
      discountAllocated?: number;
    };
    expect(Number(item.lineTotal)).toBe(2988);
    expect(Number(item.effectiveLineTotal)).toBe(2388);
    expect(Number(item.discountAllocated)).toBe(-600);
    expect(itemAmountForAnalytics(item)).toBe(2388);
  });

  it('3 — quantity>1: lineTotal is already the line amount (no double multiply)', () => {
    const edited = applyUserLineAmountEdit(
      { name: '卵', quantity: 2, lineTotal: 200, effectiveLineTotal: 200 },
      220
    ) as {
      lineTotal?: number;
      effectiveLineTotal?: number;
      unitPrice?: number;
    };
    expect(edited.lineTotal).toBe(220);
    expect(edited.effectiveLineTotal).toBe(220);
    expect(edited.unitPrice).toBe(110);
    expect(itemAmountForAnalytics(edited)).toBe(220);
  });

  it('4 — applyUserLineAmountEdit marks override; raw analysis JSON stays separate', () => {
    const analysisItems = [
      {
        name: 'コカ・コーラやかんの麦茶 特',
        quantity: 1,
        unitPrice: 69,
        lineTotal: 69,
        effectiveLineTotal: 69,
        category: 'snacks_drinks',
      },
    ];
    const userItems = [
      applyUserLineAmountEdit(
        {
          name: 'コカ・コーラやかんの麦茶 特',
          quantity: 1,
          unitPrice: 69,
          lineTotal: 69,
          line_total: 69,
          effectiveLineTotal: 69,
          category: 'snacks_drinks',
        },
        70
      ),
    ];
    const row = receiptFixture('r1', {
      total: 2846,
      analysisItems,
      userItems,
    });
    const items = getReceiptItems(row) as Array<Record<string, unknown>>;
    expect(itemAmountForAnalytics(items[0])).toBe(70);
    const raw = JSON.parse(row.analysis_json || '{}');
    expect(raw.items[0].lineTotal).toBe(69);
    expect(raw.items[0].effectiveLineTotal).toBe(69);
  });

  it('5 — restore/rebuild path: user_items overrides feed analytics amount 70', () => {
    const row = receiptFixture('restored', {
      total: 2846,
      userItems: [
        {
          name: 'コカ・コーラやかんの麦茶 特',
          quantity: 1,
          unitPrice: 69,
          lineTotal: 70,
          line_total: 69,
          effectiveLineTotal: 69,
          category: 'snacks_drinks',
          amountUserEdited: true,
        },
        {
          name: '弁当',
          quantity: 1,
          lineTotal: 334,
          effectiveLineTotal: 334,
          category: 'ready_to_eat',
        },
      ],
    });
    const stats = calculateStats([row], 'all');
    const snacks = stats.topCategories.find((c) => c.category === 'snacks_drinks');
    expect(snacks?.amount).toBe(70);
  });

  it('6 — deleted receipt contributes nothing (hard-deleted rows absent from input)', () => {
    const kept = receiptFixture('kept', {
      total: 1000,
      analysisItems: [
        {
          name: '牛乳',
          lineTotal: 200,
          effectiveLineTotal: 200,
          category: 'food_ingredients',
        },
      ],
    });
    const stats = calculateStats([kept], 'all');
    expect(stats.supportedReceiptCount).toBe(1);
    expect(stats.supportedSpend).toBe(1000);
    expect(stats.categoryCompositionTotal).toBe(200);
  });
});

describe('Phase B P0-B — category denominator unification', () => {
  it('1 — bar % and insight % use the same composition denominator', () => {
    const stats = {
      ...createEmptyStats(),
      supportedSpend: 2846,
      supportedReceiptCount: 5,
      categoryCompositionTotal: 2577,
      topCategories: [
        { category: 'snacks_drinks', amount: 2243 },
        { category: 'ready_to_eat', amount: 334 },
      ],
    };
    const shares = buildAnalysisCategoryShares(stats);
    const insight = buildAnalysisInsightPresentation('ready', stats, null);
    const snacksShare = shares.find((s) => s.category === 'snacks_drinks')!;
    const expectedPct = categoryCompositionPercent(2243, 2577)!;
    expect(Math.round(snacksShare.share * 100)).toBe(expectedPct);
    expect(insight?.bodyParams?.pct).toBe(expectedPct);
    // Must NOT use receipt total 2846 as denominator
    expect(expectedPct).not.toBe(Math.round((100 * 2243) / 2846));
  });

  it('2 — categoryCompositionTotal != receipt supportedSpend is allowed', () => {
    const stats = {
      ...createEmptyStats(),
      supportedSpend: 2846, // includes tax
      supportedReceiptCount: 3,
      categoryCompositionTotal: 2576, // merchandise only
      topCategories: [
        { category: 'snacks_drinks', amount: 2242 },
        { category: 'ready_to_eat', amount: 334 },
      ],
    };
    const insight = buildAnalysisInsightPresentation('ready', stats, null);
    expect(insight?.bodyParams?.pct).toBe(
      categoryCompositionPercent(2242, 2576)
    );
  });

  it('3 — top-N display still uses full compositionTotal denominator', () => {
    const stats = {
      ...createEmptyStats(),
      supportedSpend: 5000,
      supportedReceiptCount: 4,
      // Full universe includes a 4th category not in topCategories slice
      categoryCompositionTotal: 1000,
      topCategories: [
        { category: 'snacks_drinks', amount: 400 },
        { category: 'food_ingredients', amount: 300 },
        { category: 'ready_to_eat', amount: 200 },
      ],
    };
    const shares = buildAnalysisCategoryShares(stats);
    const top = shares[0];
    expect(Math.round(top.share * 100)).toBe(40); // 400/1000, not 400/900
    const insight = buildAnalysisInsightPresentation('ready', stats, null);
    expect(insight?.bodyParams?.pct).toBe(40);
  });

  it('4 — zero denominator yields no share insight / zero shares', () => {
    const stats = {
      ...createEmptyStats(),
      supportedSpend: 1000,
      supportedReceiptCount: 3,
      categoryCompositionTotal: 0,
      topCategories: [],
    };
    expect(buildAnalysisCategoryShares(stats)).toEqual([]);
    expect(buildAnalysisInsightPresentation('ready', stats, null)).toBeNull();
    expect(categoryCompositionPercent(10, 0)).toBeNull();
  });

  it('5 — rounding convention is shared', () => {
    const a = categoryCompositionPercent(1, 3);
    const b = categoryCompositionPercent(1, 3);
    expect(a).toBe(b);
    expect(a).toBe(33);
  });
});

describe('Phase B — ¥2846 sample regression semantics', () => {
  it('after 69→70 edit: category merchandise +1; receipt total stays 2846', () => {
    // Synthetic reconstruction of observed pre-edit category sum 2576 with mugicha at 69.
    const beforeItems = [
      {
        name: 'コカ・コーラやかんの麦茶 特',
        quantity: 1,
        lineTotal: 69,
        line_total: 69,
        effectiveLineTotal: 69,
        category: 'snacks_drinks',
      },
      {
        name: 'その他飲料菓子',
        quantity: 1,
        lineTotal: 2173,
        effectiveLineTotal: 2173,
        category: 'snacks_drinks',
      },
      {
        name: '弁当',
        quantity: 1,
        lineTotal: 334,
        effectiveLineTotal: 334,
        category: 'ready_to_eat',
      },
    ];
    const afterItems = beforeItems.map((it) =>
      String(it.name).includes('麦茶') ? applyUserLineAmountEdit(it, 70) : it
    );
    const beforeSum = beforeItems.reduce((s, i) => s + itemAmountForAnalytics(i), 0);
    const afterSum = afterItems.reduce((s, i) => s + itemAmountForAnalytics(i), 0);
    expect(beforeSum).toBe(2576);
    expect(afterSum).toBe(2577);

    const row = receiptFixture('gyomu', {
      total: 2846,
      analysisItems: beforeItems,
      userItems: afterItems,
    });
    const stats = calculateStats([row], 'all');
    expect(stats.supportedSpend).toBe(2846);
    expect(stats.categoryCompositionTotal).toBe(2577);
    // Remaining printed pre-tax gap: 2636 - 2577 = 59 (OCR/input backlog; not invented here)
    expect(2636 - stats.categoryCompositionTotal).toBe(59);
  });
});
