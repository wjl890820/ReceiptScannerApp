/**
 * M1-E — focused domain-boundary / hardcode-cleanup tests.
 * Only covers contracts touched or reaffirmed in this phase.
 */
import { calculateStats } from './statsCalculator';
import {
  buildAnalysisCategoryShares,
  categoryCompositionPercent,
  filterReceiptsByTimeRange,
} from './analysisPresentation';
import {
  V1_SPENDING_CATEGORIES,
  isV1SpendingCategory,
} from './productTaxonomy';
import { merchantAnalyticsKey } from './merchantAnalytics';
import { jstCalendarDayKey, jstCalendarDayStartMs } from './dateParser';
import { resolveProductFamily } from './productFamily';
import { resolveProductIdentity } from './productIdentity';
import { resolveShoppingIntentSemantics } from './shoppingIntent';
import { parseProductSpecification } from './productSpecification';
import {
  filterByRollingWindowDays,
  rollingDaysForAnalysisRange,
  rollingWindowCutoffMs,
} from './rollingTimeWindow';
import { aggregateCategoryData } from './homeMetricsHelpers';
import type { ReceiptRow } from './db';

function receiptFixture(
  id: string,
  opts: {
    total: number;
    at: number;
    merchantNormalized?: string;
    merchantRaw?: string;
    merchantType?: string;
    items: Array<Record<string, unknown>>;
  }
): ReceiptRow {
  return {
    id,
    created_at: opts.at,
    transaction_at: opts.at,
    image_uri: '',
    total: opts.total,
    tax: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: opts.items,
      total: opts.total,
    }),
    merchant_raw: opts.merchantRaw ?? '業務スーパー',
    merchant_normalized: opts.merchantNormalized ?? '業務スーパー',
    merchant_type: opts.merchantType ?? 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  } as ReceiptRow;
}

describe('M1-E domain boundaries', () => {
  it('A — identical receipts + identical window → same shared category composition metric', () => {
    const now = Date.parse('2026-08-22T12:00:00+09:00');
    const receipts = [
      receiptFixture('r1', {
        total: 1000,
        at: now - 2 * 24 * 60 * 60 * 1000,
        items: [
          {
            name: '牛乳',
            category: 'food_ingredients',
            lineTotal: 200,
            quantity: 1,
          },
          {
            name: '不明',
            category: 'uncategorized',
            lineTotal: 100,
            quantity: 1,
          },
        ],
      }),
    ];
    const viaStats = calculateStats(receipts, 'week');
    const viaFilter = filterReceiptsByTimeRange(receipts, 'week', now);
    expect(viaFilter).toHaveLength(1);
    expect(viaStats.categoryCompositionTotal).toBe(200);
    const shares = buildAnalysisCategoryShares(viaStats);
    const food = shares.find((s) => s.category === 'food_ingredients');
    expect(food?.share).toBeCloseTo(1, 5);
    expect(categoryCompositionPercent(200, viaStats.categoryCompositionTotal)).toBe(
      100
    );
  });

  it('B — active spending categories come from M1-A taxonomy SSOT', () => {
    expect(V1_SPENDING_CATEGORIES).toEqual(
      expect.arrayContaining([
        'food_ingredients',
        'ready_to_eat',
        'snacks_drinks',
        'household',
        'personal_care',
        'pet_care',
        'other',
      ])
    );
    expect(V1_SPENDING_CATEGORIES).not.toContain('uncategorized');
    expect(isV1SpendingCategory('food_ingredients')).toBe(true);
    expect(isV1SpendingCategory('uncategorized')).toBe(false);
  });

  it('C — uncategorized does not enter spending-category denominator', () => {
    const now = Date.now();
    const receipts = [
      receiptFixture('r1', {
        total: 500,
        at: now,
        items: [
          {
            name: '豆腐',
            category: 'food_ingredients',
            lineTotal: 120,
            quantity: 1,
          },
          {
            name: '???',
            category: 'uncategorized',
            lineTotal: 380,
            quantity: 1,
          },
        ],
      }),
    ];
    const stats = calculateStats(receipts, 'all');
    expect(stats.categoryCompositionTotal).toBe(120);
    expect(stats.uncategorizedTotal).toBe(380);
    // Display aggregation may still surface uncategorized as its own slice.
    const display = aggregateCategoryData(receipts);
    expect(display.some((row) => row.category === 'uncategorized')).toBe(true);
  });

  it('D — merchant grouping uses merchantAnalyticsKey', () => {
    const a = merchantAnalyticsKey({
      merchant_normalized: 'セブンイレブン',
      merchant_raw: 'セブン‐イレブン渋谷店',
    });
    const b = merchantAnalyticsKey({
      merchant_normalized: 'セブンイレブン',
      merchant_raw: '別の支店',
    });
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it('E — occurrence remains one row regardless of quantity', () => {
    const now = Date.now();
    const receipts = [
      receiptFixture('r1', {
        total: 600,
        at: now,
        items: [
          {
            name: '卵',
            category: 'food_ingredients',
            lineTotal: 600,
            quantity: 10,
          },
        ],
      }),
    ];
    const stats = calculateStats(receipts, 'all');
    // One supported receipt / one merchandise line contribution — qty does not multiply occurrence.
    expect(stats.supportedReceiptCount).toBe(1);
    expect(stats.categoryCompositionTotal).toBe(600);
  });

  it('F — JST same-day helpers remain stable (C2 contract)', () => {
    // 2026-08-01 00:30 JST
    const ms = Date.parse('2026-08-01T00:30:00+09:00');
    expect(jstCalendarDayKey(ms)).toBe('2026-08-01');
    const start = jstCalendarDayStartMs(ms)!;
    expect(jstCalendarDayKey(start)).toBe('2026-08-01');
  });

  it('G — family price path still uses M1-B spec reliability (exact volume)', () => {
    const spec = parseProductSpecification('牛乳 1L');
    expect(spec.dimension).toBe('volume');
    expect(spec.volumeBaseMl).toBe(1000);
    expect(spec.reliability).toBe('exact');
  });

  it('H/I — 牛奶 family resolution is shared productFamily (not Shopping-only)', () => {
    const family = resolveProductFamily({ rawName: '牛奶' });
    expect(family.family).toBe('milk');
    const identity = resolveProductIdentity({ rawName: '牛奶' });
    expect(identity.productFamilyKey).toBe('milk');
    const shopping = resolveShoppingIntentSemantics('牛奶');
    expect(shopping.resolution?.familyKey).toBe('milk');
    expect(shopping.resolution?.level).toBe('family');
  });

  it('rolling window helper is the shared Analysis cutoff source', () => {
    const now = 1_000_000_000_000;
    expect(rollingWindowCutoffMs(7, now)).toBe(now - 7 * 24 * 60 * 60 * 1000);
    expect(rollingDaysForAnalysisRange('week')).toBe(7);
    expect(rollingDaysForAnalysisRange('month')).toBe(30);
    expect(rollingDaysForAnalysisRange('all')).toBeNull();
    const rows = [{ t: now - 1 }, { t: now - 8 * 24 * 60 * 60 * 1000 }];
    expect(
      filterByRollingWindowDays(rows, (r) => r.t, 7, now).map((r) => r.t)
    ).toEqual([now - 1]);
  });
});
