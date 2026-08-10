/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
import type * as SQLite from 'expo-sqlite';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import {
  ENGAGEMENT_MILESTONES,
  buildFirstReceiptMilestone,
  buildFiveReceiptMilestone,
  buildRecentCategoryChange,
  buildShoppingFrequency,
  buildTenReceiptMilestone,
  buildThreeReceiptMilestone,
  countSupportedReceipts,
  evaluateEngagementMilestonesWithDb,
  evaluateSavedReceiptMilestoneWithDb,
  getEngagementMilestoneStatus,
  type EngagementMilestoneDatabase,
  type EngagementProductRow,
  type EngagementReceipt,
} from './engagementMilestones';
import { shouldTriggerByCount } from './analysisTriggers';
import { buildProductPriceHistory } from './productPriceHistory';

const DAY_MS = 24 * 60 * 60 * 1000;

function item(
  name: string,
  category: string,
  lineTotal: number,
  quantity = 1
) {
  return { name, category, lineTotal, quantity };
}

function receipt(
  id: string,
  overrides: Partial<EngagementReceipt> = {}
): EngagementReceipt {
  const numericId = Number(id.replace(/\D/g, '')) || 1;
  return {
    id,
    created_at: numericId * DAY_MS,
    transaction_at: numericId * DAY_MS,
    merchant_raw: `Store ${id}`,
    merchant_normalized: `store ${id}`,
    merchant_type: 'supermarket',
    total: 100,
    currency: 'JPY',
    analysis_json: JSON.stringify({ items: [] }),
    final_total: null,
    user_items_json: null,
    ...overrides,
  };
}

function withItems(
  source: EngagementReceipt,
  items: unknown[],
  useUserItems = false
): EngagementReceipt {
  return {
    ...source,
    analysis_json: JSON.stringify({
      items: useUserItems ? [item('stale OCR item', 'other', 9999)] : items,
    }),
    user_items_json: useUserItems ? JSON.stringify(items) : null,
  };
}

function productRow(
  receiptId: string,
  itemId: string,
  overrides: Partial<EngagementProductRow> = {}
): EngagementProductRow {
  return {
    receiptId,
    itemId,
    sourceIndex: 0,
    occurredAt: Number(receiptId.replace(/\D/g, '')) * DAY_MS,
    merchantRaw: 'Store',
    merchantNormalized: 'store',
    merchant_type: 'supermarket',
    analysis_json: '{}',
    displayName: itemId,
    currency: 'JPY',
    lineTotal: 100,
    purchaseQuantity: 1,
    canonicalProductName: null,
    productFamilyKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    ...overrides,
  };
}

describe('authoritative milestone progress', () => {
  it('freezes the only authoritative thresholds', () => {
    expect(ENGAGEMENT_MILESTONES).toEqual([1, 3, 5, 10]);
    expect([1, 3, 5, 10].every(shouldTriggerByCount)).toBe(true);
    expect(shouldTriggerByCount(20)).toBe(false);
  });

  it.each([
    [0, null, 1, 1],
    [1, 1, 3, 2],
    [2, 1, 3, 1],
    [3, 3, 5, 2],
    [4, 3, 5, 1],
    [5, 5, 10, 5],
    [9, 5, 10, 1],
    [10, 10, null, null],
    [15, 10, null, null],
  ] as const)(
    'count %s resolves current %s, next %s, remaining %s',
    (count, current, next, remaining) => {
      expect(getEngagementMilestoneStatus(count)).toMatchObject({
        supportedReceiptCount: count,
        currentMilestone: current,
        nextMilestone: next,
        receiptsUntilNext: remaining,
      });
    }
  );

  it('only reports an exact crossed milestone as just unlocked', () => {
    expect(getEngagementMilestoneStatus(3, 2).justUnlocked).toBe(3);
    expect(getEngagementMilestoneStatus(2, 2).justUnlocked).toBeNull();
    expect(getEngagementMilestoneStatus(4, 2).justUnlocked).toBeNull();
    expect(getEngagementMilestoneStatus(5, 5).justUnlocked).toBeNull();
  });
});

describe('supported receipt count', () => {
  it('reuses V1 support including legacy fallback and excludes other/unknown', () => {
    const rows = [
      receipt('supermarket'),
      receipt('convenience', { merchant_type: 'convenience' }),
      receipt('other', { merchant_type: 'other' }),
      receipt('unknown', { merchant_type: 'unknown' }),
      receipt('legacy', {
        merchant_type: null,
        merchant_raw: 'Legacy Store',
        merchant_normalized: null,
        analysis_json: JSON.stringify({ is_grocery: true, items: [] }),
      }),
      receipt('legacy-name', {
        merchant_type: null,
        merchant_raw: 'イオン',
        merchant_normalized: null,
      }),
    ];

    expect(countSupportedReceipts(rows)).toBe(4);
  });
});

describe('first receipt milestone', () => {
  it('uses final items for count, highest line total, composition, and summary', () => {
    const source = withItems(receipt('1', { total: 488 }), [
      item('牛乳', 'food_ingredients', 238),
      item('面包', 'food_ingredients', 150),
      { name: '水', category: 'snacks_drinks', line_total: 100 },
    ]);
    const result = buildFirstReceiptMilestone([source], 123);

    expect(result).toMatchObject({
      milestone: 1,
      generatedAt: 123,
      itemCount: 3,
      total: 488,
      highestItem: { displayName: '牛乳', lineTotal: 238 },
      nextMilestone: 3,
      receiptsUntilNext: 2,
      summary: {
        summaryType: 'dominant_category',
        summaryKey:
          'engagementMilestone.summary.dominant.food_ingredients',
      },
    });
    expect(
      result?.categoryStructure.categories.find(
        (entry) => entry.category === 'food_ingredients'
      )
    ).toMatchObject({ itemCount: 2, spend: 388 });
  });

  it('prefers user_items_json and excludes invalid amounts from highest item', () => {
    const source = withItems(
      receipt('1'),
      [
        item('User milk', 'food_ingredients', 238),
        { name: 'Invalid', category: 'other', lineTotal: Number.NaN },
      ],
      true
    );
    const result = buildFirstReceiptMilestone([source]);

    expect(result?.itemCount).toBe(2);
    expect(result?.highestItem?.displayName).toBe('User milk');
    expect(result?.highestItem?.lineTotal).toBe(238);
  });

  it('maps inactive legacy categories to other and keeps uncategorized separate', () => {
    const source = withItems(receipt('1'), [
      item('Legacy personal', 'personal_care', 100),
      item('Unknown XYZ', 'uncategorized', 50),
    ]);
    const result = buildFirstReceiptMilestone([source]);

    expect(
      result?.categoryStructure.categories.find(
        (entry) => entry.category === 'other'
      )?.itemCount
    ).toBe(1);
    expect(result?.categoryStructure.uncategorizedItemCount).toBe(1);
  });
});

describe('third receipt milestone', () => {
  it('uses exactly three supported receipts for totals, average, and pattern', () => {
    const supported = [
      withItems(receipt('1', { total: 100 }), [
        item('Food 1', 'food_ingredients', 100),
      ]),
      withItems(receipt('2', { total: 200 }), [
        item('Food 2', 'food_ingredients', 200),
      ]),
      withItems(receipt('3', { total: 300 }), [
        item('Snack', 'snacks_drinks', 300),
      ]),
    ];
    const other = receipt('4', { merchant_type: 'other', total: 9999 });
    const result = buildThreeReceiptMilestone([...supported, other], 456);

    expect(result).toMatchObject({
      milestone: 3,
      generatedAt: 456,
      supportedReceiptCount: 3,
      totalSpend: 600,
      averageSpendPerReceipt: 200,
      receiptIds: ['1', '2', '3'],
    });
    expect(result?.summary.summaryType).toBe('recurring_category');
  });
});

describe('fifth receipt frequent products', () => {
  function fiveReceiptFixture() {
    return [1, 2, 3, 4, 5].map((number) =>
      withItems(receipt(`r${number}`), [
        item(`Indexed ${number}`, 'food_ingredients', 100),
      ])
    );
  }

  function frequentRows(): EngagementProductRow[] {
    return [
      productRow('r1', 'milk-1', {
        canonicalProductName: '明治牛乳',
        productFamilyKey: 'milk',
        volumeBaseMl: 1000,
        lineTotal: 238,
      }),
      productRow('r2', 'milk-2', {
        canonicalProductName: '明治牛乳',
        productFamilyKey: 'milk',
        volumeBaseMl: 1000,
        lineTotal: 248,
      }),
      productRow('r3', 'milk-3', {
        canonicalProductName: '明治牛乳',
        productFamilyKey: 'milk',
        volumeBaseMl: 1000,
        lineTotal: 228,
      }),
      productRow('r4', 'milk-4', {
        canonicalProductName: '明治牛乳',
        productFamilyKey: 'milk',
        volumeBaseMl: 1000,
        lineTotal: 250,
      }),
      productRow('r1', 'water-1', {
        productFamilyKey: 'water',
        volumeBaseMl: 500,
        lineTotal: 100,
      }),
      productRow('r2', 'water-2', {
        productFamilyKey: 'water',
        volumeBaseMl: 500,
        lineTotal: 110,
      }),
      productRow('r3', 'water-3', {
        productFamilyKey: 'water',
        volumeBaseMl: 500,
        lineTotal: 90,
      }),
      productRow('r5', 'eggs-1', {
        productFamilyKey: 'eggs',
        countBase: 10,
        lineTotal: 250,
      }),
    ];
  }

  it('returns only repeated canonical/family identities in stable order', () => {
    const result = buildFiveReceiptMilestone(
      fiveReceiptFixture(),
      {
        rows: frequentRows(),
        queryFailed: false,
        priceHistoryBuilder: buildProductPriceHistory,
      },
      789
    );

    expect(
      result?.frequentProducts.map((product) => ({
        label: product.displayLabel,
        type: product.groupingType,
        count: product.purchaseOccurrenceCount,
      }))
    ).toEqual([
      { label: '明治牛乳', type: 'canonical', count: 4 },
      { label: 'water', type: 'family', count: 3 },
    ]);
    expect(result?.frequentProducts[0].priceSummary).toMatchObject({
      priceKind: 'per_liter',
      latestPrice: 250,
      minRecordedPrice: 228,
    });
    expect(result?.dataCoverageIncomplete).toBe(false);
  });

  it('never promotes normalized-only identity into frequent products', () => {
    const rows = frequentRows();
    rows.push(
      productRow('r4', 'unknown-1', { displayName: 'same normalized name' }),
      productRow('r5', 'unknown-2', { displayName: 'same normalized name' })
    );
    const result = buildFiveReceiptMilestone(fiveReceiptFixture(), {
      rows,
      queryFailed: false,
      priceHistoryBuilder: buildProductPriceHistory,
    });

    expect(
      result?.frequentProducts.some((product) =>
        product.key.includes('normalized')
      )
    ).toBe(false);
  });

  it('reuses safe price eligibility and omits unsupported family price summaries', () => {
    const rows = frequentRows();
    rows.push(
      productRow('r4', 'tofu-1', {
        productFamilyKey: 'tofu',
        weightBaseG: 300,
      }),
      productRow('r5', 'tofu-2', {
        productFamilyKey: 'tofu',
        weightBaseG: 300,
      })
    );
    const result = buildFiveReceiptMilestone(fiveReceiptFixture(), {
      rows,
      queryFailed: false,
      priceHistoryBuilder: buildProductPriceHistory,
    });

    expect(
      result?.frequentProducts.find((product) => product.key === 'tofu')
        ?.priceSummary
    ).toBeNull();
  });
});

describe('tenth receipt shopping profile', () => {
  function tenReceiptFixture(latestFoodSpend = 40): EngagementReceipt[] {
    return Array.from({ length: 10 }, (_, index) => {
      const number = index + 1;
      const isFirstWindow = number <= 5;
      const foodSpend = isFirstWindow ? 20 : latestFoodSpend;
      const snackSpend = 100 - foodSpend;
      return withItems(receipt(`r${number}`, { total: foodSpend + snackSpend }), [
        ...(foodSpend > 0
          ? [item(`Food ${number}`, 'food_ingredients', foodSpend)]
          : []),
        item(`Snack ${number}`, 'snacks_drinks', snackSpend),
      ]);
    });
  }

  it('uses strict first-five and latest-five windows', () => {
    const receipts = tenReceiptFixture();
    const rows = receipts.map((row, index) =>
      productRow(row.id, `product-${index}`, {
        canonicalProductName: index % 2 === 0 ? 'Repeated' : null,
        productFamilyKey: index % 2 === 0 ? 'milk' : null,
        volumeBaseMl: index % 2 === 0 ? 1000 : null,
      })
    );
    const result = buildTenReceiptMilestone(receipts, {
      rows,
      queryFailed: false,
    });

    expect(result?.windowComparison.firstReceiptIds).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
    ]);
    expect(result?.windowComparison.latestReceiptIds).toEqual([
      'r6',
      'r7',
      'r8',
      'r9',
      'r10',
    ]);
    expect(result?.recentChange).toMatchObject({
      changeType: 'category_share_increase',
      category: 'food_ingredients',
    });
    expect(result?.recentChange?.differencePercentagePoints).toBeCloseTo(20);
  });

  it('does not manufacture a change below 15 percentage points', () => {
    const first = buildTenReceiptMilestone(tenReceiptFixture(27), {
      rows: [],
      queryFailed: true,
    })!.windowComparison;

    expect(
      buildRecentCategoryChange(
        first.firstCategoryStructure,
        first.latestCategoryStructure
      )
    ).toBeNull();
  });

  it('returns factual recorded-shopping interval data only for distinct dates', () => {
    const receipts = [receipt('r1'), receipt('r2'), receipt('r4')];
    expect(buildShoppingFrequency(receipts)).toMatchObject({
      recordedReceiptCount: 3,
      activeSpanDays: 3,
      intervalCount: 2,
      averageIntervalDays: 1.5,
    });
    expect(
      buildShoppingFrequency(
        receipts.map((row) => ({
          ...row,
          transaction_at: DAY_MS,
          created_at: DAY_MS,
        }))
      )
    ).toBeNull();
  });
});

describe('database evaluation and graceful degradation', () => {
  it('keeps supported count accurate when product index coverage is incomplete', async () => {
    const receipts = [1, 2, 3, 4, 5].map((number) =>
      withItems(receipt(`r${number}`), [
        item(`Item ${number}`, 'food_ingredients', 100),
      ])
    );
    const db: EngagementMilestoneDatabase = {
      async getAllAsync<T>(source: string) {
        if (/FROM receipts/i.test(source)) return receipts as T[];
        throw new Error('receipt_items unavailable');
      },
    };

    const evaluation = await evaluateEngagementMilestonesWithDb(db, {
      beforeSupportedReceiptCount: 4,
      generatedAt: 999,
    });
    expect(evaluation.status).toMatchObject({
      supportedReceiptCount: 5,
      justUnlocked: 5,
    });
    expect(evaluation.unlockedResult).toMatchObject({
      milestone: 5,
      generatedAt: 999,
      dataCoverageIncomplete: true,
      frequentProducts: [],
    });
  });

  it('uses receipts for counts and INNER JOIN receipts for product aggregation', async () => {
    const receipts = [1, 2, 3, 4, 5].map((number) =>
      withItems(receipt(`r${number}`), [
        item(`Item ${number}`, 'food_ingredients', 100),
      ])
    );
    const calls: { source: string; params: SQLite.SQLiteBindParams }[] = [];
    const db: EngagementMilestoneDatabase = {
      async getAllAsync<T>(source: string, params: SQLite.SQLiteBindParams) {
        calls.push({ source, params });
        return (/FROM receipt_items/i.test(source) ? [] : receipts) as T[];
      },
    };

    await evaluateEngagementMilestonesWithDb(db, {
      beforeSupportedReceiptCount: 4,
    });
    expect(calls[0].source).toMatch(/FROM receipts/i);
    expect(calls[0].source).not.toMatch(/receipt_items/i);
    expect(calls[1].source).toMatch(
      /FROM receipt_items\s+INNER JOIN receipts/i
    );
    expect(calls[1].source).not.toMatch(/UPDATE|INSERT|DELETE/i);
  });

  it('does not fabricate unlock after an imported count jump', async () => {
    const receipts = [1, 2, 3, 4].map((number) => receipt(`r${number}`));
    const db: EngagementMilestoneDatabase = {
      async getAllAsync<T>() {
        return receipts as T[];
      },
    };

    const evaluation = await evaluateEngagementMilestonesWithDb(db, {
      beforeSupportedReceiptCount: 2,
    });
    expect(evaluation.status.justUnlocked).toBeNull();
    expect(evaluation.unlockedResult).toBeNull();
  });

  it('derives transient unlock from the saved receipt without persisted state', async () => {
    const receipts = [1, 2, 3].map((number) => receipt(`r${number}`));
    const db: EngagementMilestoneDatabase = {
      async getAllAsync<T>() {
        return receipts as T[];
      },
    };
    const evaluation = await evaluateSavedReceiptMilestoneWithDb(db, 'r3', {
      generatedAt: 123,
    });

    expect(evaluation.status).toMatchObject({
      supportedReceiptCount: 3,
      justUnlocked: 3,
    });
    expect(evaluation.unlockedResult).toMatchObject({
      milestone: 3,
      generatedAt: 123,
    });
  });

  it('does not increment or unlock for an unsupported saved receipt', async () => {
    const receipts = [
      receipt('r1'),
      receipt('r2'),
      receipt('other', { merchant_type: 'other' }),
    ];
    const db: EngagementMilestoneDatabase = {
      async getAllAsync<T>() {
        return receipts as T[];
      },
    };
    const evaluation = await evaluateSavedReceiptMilestoneWithDb(db, 'other');

    expect(evaluation.status).toMatchObject({
      supportedReceiptCount: 2,
      justUnlocked: null,
      nextMilestone: 3,
    });
    expect(evaluation.unlockedResult).toBeNull();
  });
});

describe('deterministic dependency boundary', () => {
  it('does not import AI, network, or classification clients', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'engagementMilestones.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /Gemini|Supabase|supabase|classify-item|classifyItems|fetch\(|Edge Function/
    );
  });
});
