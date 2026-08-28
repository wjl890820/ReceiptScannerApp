/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({ initIfNeeded: jest.fn(async () => undefined) }));

import { openDatabaseAsync } from 'expo-sqlite';
import {
  buildAnalysisDReport,
  formatAnalysisDReportSummary,
  occurrenceCountIgnoringQuantity,
  serializeAnalysisDReport,
} from './analysisDReport';
import { buildTrustedProductPriceHistoryForTests as buildTrustedProductPriceHistory } from './productPriceHistory.testFixtures';
import type { ReceiptRow } from './db';
import { V1_SPENDING_CATEGORIES } from './productTaxonomy';
import {
  appendUserCorrections,
  buildUserCorrectionEvent,
} from './userCorrections';

const nowMs = Date.parse('2026-08-22T12:00:00+09:00');
const MS_DAY = 24 * 60 * 60 * 1000;

type FixtureItem = {
  name: string;
  category: string;
  lineTotal: number;
  quantity: number;
  user_corrections?: unknown;
};

function makeReceipt(args: {
  id: string;
  at: number;
  merchantType: string;
  items: FixtureItem[];
  total?: number;
  merchantNormalized?: string;
  transactionAt?: number | null;
  analysisExtras?: Record<string, unknown>;
}): ReceiptRow {
  const itemSum = args.items.reduce((sum, item) => sum + (item.lineTotal || 0), 0);
  const analysis = {
    items: args.items,
    evidenceCaptureVersion: 1,
    ...(args.analysisExtras ?? {}),
  };
  return {
    id: args.id,
    created_at: args.at,
    transaction_at:
      args.transactionAt === undefined ? args.at : args.transactionAt,
    image_uri: '',
    total: args.total ?? itemSum,
    tax: 0,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify(analysis),
    merchant_raw: args.merchantNormalized ?? 'イオン',
    merchant_normalized: args.merchantNormalized ?? 'イオン',
    merchant_type: args.merchantType,
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  } as ReceiptRow;
}

function privacyAndReviewNull(report: ReturnType<typeof buildAnalysisDReport>) {
  expect(report.privacy).toEqual({
    localOnly: true,
    autoUpload: false,
    productAnalytics: false,
    supabaseTelemetry: false,
  });
  expect(
    report.insights.every((row) => row.reviewClassificationSlot === null)
  ).toBe(true);
}

describe('analysisDReport (D0 fixtures A–N)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('A — supported + unsupported receipts (other/unknown → unsupported)', () => {
    const receipts = [
      makeReceipt({
        id: 'a-super',
        at: nowMs - 2 * MS_DAY,
        merchantType: 'supermarket',
        items: [
          {
            name: '牛乳',
            category: 'food_ingredients',
            lineTotal: 200,
            quantity: 1,
          },
        ],
      }),
      makeReceipt({
        id: 'a-conv',
        at: nowMs - 3 * MS_DAY,
        merchantType: 'convenience',
        items: [
          {
            name: 'おにぎり',
            category: 'ready_to_eat',
            lineTotal: 150,
            quantity: 1,
          },
        ],
      }),
      makeReceipt({
        id: 'a-other',
        at: nowMs - 4 * MS_DAY,
        merchantType: 'other',
        items: [
          {
            name: '外食',
            category: 'other',
            lineTotal: 1000,
            quantity: 1,
          },
        ],
      }),
      makeReceipt({
        id: 'a-unknown',
        at: nowMs - 5 * MS_DAY,
        merchantType: 'unknown',
        items: [
          {
            name: '謎店',
            category: 'other',
            lineTotal: 500,
            quantity: 1,
          },
        ],
      }),
    ];

    const report = buildAnalysisDReport({ receipts, nowMs });
    expect(report.dataset.totalLocalReceiptCount).toBe(4);
    expect(report.dataset.v1SupportedReceiptCount).toBe(2);
    expect(report.dataset.unsupportedReceiptCount).toBe(2);
    expect(
      report.dataQualityFlags.filter((f) => f.code === 'unsupported_merchant')
        .length
    ).toBe(2);
    privacyAndReviewNull(report);
  });

  test('B — all seven taxonomy categories + uncategorized', () => {
    const items: FixtureItem[] = [
      ...V1_SPENDING_CATEGORIES.map((category, index) => ({
        name: `cat-${category}`,
        category,
        lineTotal: 100 + index,
        quantity: 1,
      })),
      {
        name: '未分類アイテム',
        category: 'uncategorized',
        lineTotal: 50,
        quantity: 1,
      },
    ];
    const classifiedSum = V1_SPENDING_CATEGORIES.reduce(
      (sum, _category, index) => sum + (100 + index),
      0
    );
    const receipt = makeReceipt({
      id: 'b-all-cats',
      at: nowMs - MS_DAY,
      merchantType: 'supermarket',
      items,
    });

    const report = buildAnalysisDReport({ receipts: [receipt], nowMs });
    const allWindow = report.categoryValue.find((w) => w.window === 'all');
    expect(allWindow).toBeTruthy();
    // Report always enumerates the full V1 taxonomy slot list (SSOT import).
    expect(allWindow!.categories.map((c) => c.category)).toEqual([
      ...V1_SPENDING_CATEGORIES,
    ]);
    // D2-B: diagnostic 7-buckets conserve against categoryCompositionTotal.
    expect(allWindow!.categoryCompositionTotal).toBe(classifiedSum);
    expect(allWindow!.stats.categoryCompositionTotal).toBe(classifiedSum);
    expect(allWindow!.stats.categoryBreakdown.length).toBe(
      V1_SPENDING_CATEGORIES.length
    );
    expect(allWindow!.stats.topCategories.length).toBe(3);
    const bucketSum = allWindow!.categories.reduce((sum, c) => sum + c.amount, 0);
    expect(bucketSum).toBe(classifiedSum);
    expect(allWindow!.conservation.conserved).toBe(true);
    expect(allWindow!.conservation.gap).toBe(0);
    expect(
      allWindow!.stats.topCategories.every((row) =>
        (V1_SPENDING_CATEGORIES as readonly string[]).includes(row.category)
      )
    ).toBe(true);
    expect(allWindow!.stats.uncategorizedCount).toBe(1);
    expect(allWindow!.stats.uncategorizedTotal).toBe(50);
    expect(report.categoryCoverage.uncategorizedItemCount).toBe(1);
    expect(report.categoryCoverage.uncategorizedEffectiveMerchandiseAmount).toBe(
      50
    );
    privacyAndReviewNull(report);
  });

  test('C — category coverage denominator uses eligible item amounts NOT receipt.total', () => {
    const items: FixtureItem[] = [
      {
        name: '牛乳',
        category: 'food_ingredients',
        lineTotal: 250,
        quantity: 1,
      },
      {
        name: '謎',
        category: 'uncategorized',
        lineTotal: 100,
        quantity: 1,
      },
    ];
    const itemSum = 350;
    const receipt = makeReceipt({
      id: 'c-denom',
      at: nowMs - MS_DAY,
      merchantType: 'supermarket',
      items,
      total: 9999,
    });
    expect(receipt.total).not.toBe(itemSum);

    const report = buildAnalysisDReport({ receipts: [receipt], nowMs });
    expect(report.categoryCoverage.coverageDenominator).toBe(
      'eligible_item_effective_amount'
    );
    expect(report.categoryCoverage.eligibleEffectiveMerchandiseAmount).toBe(
      itemSum
    );
    expect(report.categoryCoverage.classifiedEffectiveMerchandiseAmount).toBe(
      250
    );
    expect(report.categoryCoverage.eligibleEffectiveMerchandiseAmount).not.toBe(
      receipt.total
    );
    expect(report.dataset.supportedReceiptSpendTotal).toBe(9999);
    privacyAndReviewNull(report);
  });

  test('D — occurrence independent from quantity (qty=10 still one occurrence)', () => {
    const receipt = makeReceipt({
      id: 'd-qty',
      at: nowMs - MS_DAY,
      merchantType: 'supermarket',
      items: [
        {
          name: '明治おいしい牛乳 1000ml',
          category: 'food_ingredients',
          lineTotal: 2500,
          quantity: 10,
        },
      ],
    });

    const report = buildAnalysisDReport({ receipts: [receipt], nowMs });
    expect(report.categoryCoverage.eligibleItemOccurrences).toBe(1);
    expect(report.categoryCoverage.classifiedItemOccurrences).toBe(1);
    expect(occurrenceCountIgnoringQuantity(1, 10)).toBe(1);
    expect(occurrenceCountIgnoringQuantity(2, 99)).toBe(2);
    privacyAndReviewNull(report);
  });

  test('E — canonical/family unresolved rows counted', () => {
    const receipt = makeReceipt({
      id: 'e-unresolved',
      at: nowMs - MS_DAY,
      merchantType: 'supermarket',
      items: [
        {
          name: '明治おいしい牛乳 1000ml',
          category: 'food_ingredients',
          lineTotal: 250,
          quantity: 1,
        },
        {
          name: '謎の商品XYZ123',
          category: 'other',
          lineTotal: 80,
          quantity: 1,
        },
      ],
    });

    const report = buildAnalysisDReport({ receipts: [receipt], nowMs });
    expect(report.identityCoverage.eligibleItemRows).toBe(2);
    expect(report.identityCoverage.withFamily).toBe(1);
    expect(report.identityCoverage.withCanonical).toBe(1);
    const allFreq = report.frequentProducts.find((w) => w.window === 'all');
    expect(allFreq!.unresolvedIdentityItemRows).toBe(1);
    expect(
      report.dataQualityFlags.some(
        (f) =>
          f.code === 'unresolved_identity' && f.receiptId === 'e-unresolved'
      )
    ).toBe(true);
    privacyAndReviewNull(report);
  });

  test('F — reliable 1L / 900ml normalized family price (milk)', () => {
    const receipt = makeReceipt({
      id: 'f-milk',
      at: nowMs - MS_DAY,
      merchantType: 'supermarket',
      items: [
        {
          name: '明治おいしい牛乳 1000ml',
          category: 'food_ingredients',
          lineTotal: 250,
          quantity: 1,
        },
        {
          name: '明治おいしい牛乳 900ml',
          category: 'food_ingredients',
          lineTotal: 230,
          quantity: 1,
        },
      ],
    });

    const report = buildAnalysisDReport({
      receipts: [receipt],
      nowMs,
      priceHistoryBuilder: (target, rows) =>
        buildTrustedProductPriceHistory(target, rows),
    });
    expect(report.priceCoverage.familyNormalizedComparableRows).toBeGreaterThanOrEqual(
      2
    );
    expect(
      report.priceCoverage.familyGroupsWithAtLeast2Observations
    ).toBeGreaterThanOrEqual(1);
    const milkExample = report.priceHistoryExamples.find(
      (ex) => ex.groupingType === 'family' && ex.key === 'milk'
    );
    expect(milkExample).toBeTruthy();
    expect(milkExample!.observationCount).toBeGreaterThanOrEqual(2);
    expect(milkExample!.points.length).toBeGreaterThanOrEqual(2);
    expect(
      milkExample!.points.every((p) => typeof p.normalizedPrice === 'number')
    ).toBe(true);
    privacyAndReviewNull(report);
  });

  test('G — unknown spec excluded from family normalized comparison', () => {
    const receipt = makeReceipt({
      id: 'g-unknown-spec',
      at: nowMs - MS_DAY,
      merchantType: 'supermarket',
      items: [
        {
          name: '明治おいしい牛乳',
          category: 'food_ingredients',
          lineTotal: 200,
          quantity: 1,
        },
      ],
    });

    const report = buildAnalysisDReport({ receipts: [receipt], nowMs });
    expect(report.priceCoverage.familyNormalizedComparableRows).toBe(0);
    expect(report.specCoverage.unknownSpecCount).toBeGreaterThanOrEqual(1);
    expect(
      report.dataQualityFlags.some(
        (f) => f.code === 'price_normalization_unavailable'
      )
    ).toBe(true);
    privacyAndReviewNull(report);
  });

  test('H — trend gate both sides >=3 → eligible with matched windows', () => {
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);

    const receipts: ReceiptRow[] = [];
    for (let i = 0; i < 3; i += 1) {
      receipts.push(
        makeReceipt({
          id: `h-cur-${i}`,
          at: nowMs - (i + 1) * MS_DAY,
          merchantType: 'supermarket',
          items: [
            {
              name: `cur-${i}`,
              category: 'food_ingredients',
              lineTotal: 300,
              quantity: 1,
            },
          ],
        })
      );
    }
    for (let i = 0; i < 3; i += 1) {
      receipts.push(
        makeReceipt({
          id: `h-prev-${i}`,
          at: nowMs - (8 + i) * MS_DAY,
          merchantType: 'supermarket',
          items: [
            {
              name: `prev-${i}`,
              category: 'food_ingredients',
              lineTotal: 300,
              quantity: 1,
            },
          ],
        })
      );
    }

    const report = buildAnalysisDReport({ receipts, nowMs });
    const week = report.trends.find((t) => t.window === '7d');
    expect(week).toBeTruthy();
    expect(week!.currentReceiptSampleSize).toBeGreaterThanOrEqual(3);
    expect(week!.previousReceiptSampleSize).toBeGreaterThanOrEqual(3);
    expect(week!.eligible).toBe(true);
    expect(week!.suppressionReason).toBeNull();
    privacyAndReviewNull(report);
  });

  test('I — insufficient trend sample → suppression', () => {
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);

    const receipts = [
      makeReceipt({
        id: 'i-only-1',
        at: nowMs - MS_DAY,
        merchantType: 'supermarket',
        items: [
          {
            name: '牛乳',
            category: 'food_ingredients',
            lineTotal: 200,
            quantity: 1,
          },
        ],
      }),
      makeReceipt({
        id: 'i-only-2',
        at: nowMs - 2 * MS_DAY,
        merchantType: 'supermarket',
        items: [
          {
            name: 'パン',
            category: 'food_ingredients',
            lineTotal: 150,
            quantity: 1,
          },
        ],
      }),
    ];

    const report = buildAnalysisDReport({ receipts, nowMs });
    const week = report.trends.find((t) => t.window === '7d');
    expect(week!.eligible).toBe(false);
    expect(week!.suppressionReason).toBe(
      'both_sides_need_at_least_3_supported_receipts'
    );
    privacyAndReviewNull(report);
  });

  test('J — correction counts from M1-C (buildUserCorrectionEvent + appendUserCorrections)', () => {
    const baseItem = {
      name: '牛乳',
      category: 'food_ingredients',
      lineTotal: 200,
      quantity: 1,
    };
    const correctedItem = appendUserCorrections(baseItem, [
      buildUserCorrectionEvent({
        field: 'item_category',
        originalValue: 'uncategorized',
        correctedValue: 'food_ingredients',
        itemSourceIndex: 0,
        now: () => new Date('2026-08-20T00:00:00.000Z'),
      }),
      buildUserCorrectionEvent({
        field: 'item_amount',
        originalValue: 180,
        correctedValue: 200,
        itemSourceIndex: 0,
        now: () => new Date('2026-08-20T00:01:00.000Z'),
      }),
    ]);

    const analysisRoot = appendUserCorrections(
      {
        items: [correctedItem],
        user_corrections: undefined as unknown,
      },
      [
        buildUserCorrectionEvent({
          field: 'merchant',
          originalValue: '旧店名',
          correctedValue: 'イオン',
          now: () => new Date('2026-08-20T00:02:00.000Z'),
        }),
      ]
    );

    const receipt = makeReceipt({
      id: 'j-corrections',
      at: nowMs - MS_DAY,
      merchantType: 'supermarket',
      items: [correctedItem as FixtureItem],
      analysisExtras: {
        user_corrections: analysisRoot.user_corrections,
      },
    });

    const report = buildAnalysisDReport({ receipts: [receipt], nowMs });
    expect(report.corrections.privacy).toBe('local_diagnostic_only');
    expect(report.corrections.totalCorrectionEvents).toBe(3);
    expect(report.corrections.countsByField.item_category).toBe(1);
    expect(report.corrections.countsByField.item_amount).toBe(1);
    expect(report.corrections.countsByField.merchant).toBe(1);
    privacyAndReviewNull(report);
  });

  test('K — invalid transaction date flag (null/0)', () => {
    const receipts = [
      makeReceipt({
        id: 'k-null',
        at: nowMs - MS_DAY,
        merchantType: 'supermarket',
        transactionAt: null,
        items: [
          {
            name: '牛乳',
            category: 'food_ingredients',
            lineTotal: 200,
            quantity: 1,
          },
        ],
      }),
      makeReceipt({
        id: 'k-zero',
        at: nowMs - 2 * MS_DAY,
        merchantType: 'supermarket',
        transactionAt: 0,
        items: [
          {
            name: 'パン',
            category: 'food_ingredients',
            lineTotal: 150,
            quantity: 1,
          },
        ],
      }),
      makeReceipt({
        id: 'k-ok',
        at: nowMs - 3 * MS_DAY,
        merchantType: 'supermarket',
        items: [
          {
            name: '卵',
            category: 'food_ingredients',
            lineTotal: 100,
            quantity: 1,
          },
        ],
      }),
    ];

    const report = buildAnalysisDReport({ receipts, nowMs });
    expect(report.dataset.invalidOrMissingTransactionDateCount).toBe(2);
    expect(report.dataset.validTransactionDateCount).toBe(1);
    const dateFlags = report.dataQualityFlags.filter(
      (f) => f.code === 'invalid_or_missing_transaction_date'
    );
    expect(dateFlags.map((f) => f.receiptId).sort()).toEqual([
      'k-null',
      'k-zero',
    ]);
    privacyAndReviewNull(report);
  });

  test('L — same-window shared metric parity (crossSurfaceParity identical true)', () => {
    const receipts = [
      makeReceipt({
        id: 'l-1',
        at: nowMs - MS_DAY,
        merchantType: 'supermarket',
        items: [
          {
            name: '牛乳',
            category: 'food_ingredients',
            lineTotal: 250,
            quantity: 1,
          },
          {
            name: 'チョコ',
            category: 'snacks_drinks',
            lineTotal: 100,
            quantity: 1,
          },
        ],
      }),
    ];

    const report = buildAnalysisDReport({ receipts, nowMs });
    expect(report.crossSurfaceParity.length).toBeGreaterThan(0);
    expect(report.crossSurfaceParity.every((row) => row.identical)).toBe(true);
    for (const row of report.crossSurfaceParity) {
      expect(row.analysisValue).toBe(row.homePathValue);
      expect(['categoryCompositionTotal', 'supportedSpend']).toContain(
        row.sharedMetric
      );
    }
    privacyAndReviewNull(report);
  });

  test('M — report generation causes ZERO data writes', () => {
    (openDatabaseAsync as jest.Mock).mockClear();
    const receipts = [
      makeReceipt({
        id: 'm-readonly',
        at: nowMs - MS_DAY,
        merchantType: 'supermarket',
        items: [
          {
            name: '明治おいしい牛乳 1000ml',
            category: 'food_ingredients',
            lineTotal: 250,
            quantity: 1,
          },
        ],
      }),
    ];
    const before = JSON.parse(JSON.stringify(receipts));

    buildAnalysisDReport({ receipts, nowMs });

    expect(JSON.parse(JSON.stringify(receipts))).toEqual(before);
    expect(openDatabaseAsync).not.toHaveBeenCalled();
  });

  test('N — serializeAnalysisDReport deterministic (call twice, equal; key-sorted)', () => {
    const receipt = makeReceipt({
      id: 'n-serialize',
      at: nowMs - MS_DAY,
      merchantType: 'supermarket',
      items: [
        {
          name: '明治おいしい牛乳 900ml',
          category: 'food_ingredients',
          lineTotal: 230,
          quantity: 1,
        },
        {
          name: '謎',
          category: 'uncategorized',
          lineTotal: 40,
          quantity: 1,
        },
      ],
    });

    const report = buildAnalysisDReport({ receipts: [receipt], nowMs });
    const a = serializeAnalysisDReport(report);
    const b = serializeAnalysisDReport(report);
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(a) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(Object.keys(parsed).sort());
    expect(typeof formatAnalysisDReportSummary(report)).toBe('string');
    privacyAndReviewNull(report);
  });
});
