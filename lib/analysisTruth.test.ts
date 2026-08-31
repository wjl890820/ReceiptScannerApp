/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import type { ReceiptRow } from './db';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { buildInsights } from './buildInsights';
import { buildAnalysisSpendChangeSurface } from './analysisValueSurfaces';
import { buildAnalysisTruthSnapshot } from './analysisTruthCycle';
import { buildStatsSafe } from './analysisHelpers';
import { countSupportedItemsInRange } from './analysisPresentation';
import {
  ANALYSIS_STORY_MIN_ITEMS,
  ANALYSIS_STORY_MIN_SUPPORTED_RECEIPTS,
  ANALYSIS_STORY_MIN_SUPPORTED_SPEND_JPY,
  countSupportedItemsInEligibleReceipts,
  isAnalysisStorySufficient,
  selectAnalysisEligibleReceipts,
  selectAnalysisPeriodReceiptSets,
} from './analysisEligibility';
import {
  filterAnalysisReceiptsByTransactionWindow,
  resolveAnalysisRollingWindowBounds,
  validAnalysisTransactionAt,
} from './analysisPeriod';
import { calculateStats } from './statsCalculator';

const NOW = Date.parse('2026-08-31T12:00:00+09:00');
const MS_DAY = 24 * 60 * 60 * 1000;

function item(
  name: string,
  lineTotal: number,
  category: string,
  extra: Record<string, unknown> = {}
) {
  return { name, lineTotal, quantity: 1, category, ...extra };
}

function receipt(
  id: string,
  overrides: Partial<ReceiptRow> & {
    transaction_at: number;
    items?: ReturnType<typeof item>[];
    discounts?: Array<{ label: string; amount: number }>;
  }
): ReceiptRow {
  const {
    items = [item(`Item-${id}`, 500, 'food_ingredients')],
    discounts,
    transaction_at,
    ...rest
  } = overrides;
  return {
    id,
    created_at: overrides.created_at ?? transaction_at,
    transaction_at,
    image_uri: '',
    total: overrides.total ?? items.reduce((s, i) => s + i.lineTotal, 0),
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items,
      ...(discounts ? { discounts } : {}),
    }),
    merchant_raw: overrides.merchant_raw ?? `Store-${id}`,
    merchant_normalized: overrides.merchant_normalized ?? `store-${id}`,
    merchant_type: overrides.merchant_type ?? 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    ...rest,
  } as ReceiptRow;
}

/** Canonical mixed-world fixture for Analysis truth regression. */
function buildCanonicalTruthFixture(): {
  storedReceipts: ReceiptRow[];
  analyticsReceipts: ReceiptRow[];
} {
  const duplicateCanonical = receipt('dup-canonical', {
    transaction_at: NOW - 2 * MS_DAY,
    total: 198,
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    items: [item('明治おいしい牛乳', 198, 'food_ingredients')],
  });
  const duplicateExtra = receipt('dup-extra', {
    transaction_at: NOW - 2 * MS_DAY,
    total: 198,
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    items: [item('明治おいしい牛乳', 198, 'food_ingredients')],
  });

  const storedReceipts: ReceiptRow[] = [
    duplicateCanonical,
    duplicateExtra,
    receipt('unsupported', {
      transaction_at: NOW - 3 * MS_DAY,
      total: 9000,
      merchant_type: 'other',
      items: [item('Pharmacy', 9000, 'other')],
    }),
    receipt('usd', {
      transaction_at: NOW - 4 * MS_DAY,
      currency: 'USD',
      total: 42,
      items: [item('Import', 42, 'food_ingredients')],
    }),
    receipt('discounted', {
      transaction_at: NOW - 5 * MS_DAY,
      total: 1800,
      merchant_raw: 'Costco',
      merchant_normalized: 'costco',
      items: [
        item('Bulk rice', 2000, 'food_ingredients'),
      ],
      discounts: [{ label: 'coupon', amount: -200 }],
    }),
    receipt('uncategorized-row', {
      transaction_at: NOW - 6 * MS_DAY,
      total: 400,
      items: [item('Mystery', 400, 'uncategorized')],
    }),
    receipt('cur-a', {
      transaction_at: NOW - 1 * MS_DAY,
      total: 3000,
      items: Array.from({ length: 4 }, (_, i) =>
        item(`CurA-${i}`, 750, 'ready_to_eat')
      ),
    }),
    receipt('cur-b', {
      transaction_at: NOW - 10 * MS_DAY,
      total: 2500,
      items: Array.from({ length: 4 }, (_, i) =>
        item(`CurB-${i}`, 625, 'snacks_drinks')
      ),
    }),
    receipt('cur-c', {
      transaction_at: NOW - 20 * MS_DAY,
      total: 2200,
      items: Array.from({ length: 4 }, (_, i) =>
        item(`CurC-${i}`, 550, 'food_ingredients')
      ),
    }),
    receipt('prev-a', {
      transaction_at: NOW - 35 * MS_DAY,
      total: 1500,
      items: Array.from({ length: 4 }, (_, i) =>
        item(`PrevA-${i}`, 375, 'food_ingredients')
      ),
    }),
    receipt('prev-b', {
      transaction_at: NOW - 45 * MS_DAY,
      total: 1500,
      items: Array.from({ length: 4 }, (_, i) =>
        item(`PrevB-${i}`, 375, 'household')
      ),
    }),
    receipt('prev-c', {
      transaction_at: NOW - 55 * MS_DAY,
      total: 1500,
      items: Array.from({ length: 4 }, (_, i) =>
        item(`PrevC-${i}`, 375, 'ready_to_eat')
      ),
    }),
    receipt('boundary-current', {
      transaction_at: NOW - 30 * MS_DAY,
      total: 1000,
      items: [item('BoundaryCurrent', 1000, 'food_ingredients')],
    }),
    receipt('boundary-previous', {
      transaction_at: NOW - 30 * MS_DAY - 1,
      total: 1000,
      items: [item('BoundaryPrevious', 1000, 'food_ingredients')],
    }),
  ];

  const { analyticsReceipts, excludedDuplicateReceiptIds } =
    selectAnalyticsReceipts(storedReceipts);

  expect(excludedDuplicateReceiptIds.has('dup-extra')).toBe(true);
  expect(analyticsReceipts.some((r) => r.id === 'dup-canonical')).toBe(true);
  expect(analyticsReceipts.some((r) => r.id === 'dup-extra')).toBe(false);

  return { storedReceipts, analyticsReceipts };
}

/** Fixed month-window truth for the canonical mixed fixture (independent oracle). */
const CANONICAL_MONTH_TRUTH = {
  currentSupportedReceiptCount: 7,
  /** dup 198 + cur-a 3000 + cur-b 2500 + cur-c 2200 + boundary 1000 + discounted 1800 + uncategorized receipt 400 */
  currentSupportedSpend: 11_098,
  currentItemCount: 16,
  /**
   * Classified merchandise via itemAmountForAnalytics (excludes uncategorized-row 400):
   * dup 198 + discounted 2000 (gross lineTotal — no effectiveLineTotal on item) +
   * cur-a 3000 + cur-b 2500 + cur-c 2200 + boundary 1000 = 10898.
   * The ¥200 gap vs (supportedSpend − uncategorized) = 10698 is the coupon on
   * discounted receipt: receipt.total is 1800 but item line analytics uses gross 2000.
   */
  categoryCompositionTotal: 10_898,
  topMerchantSpend: 3_000,
  previousSupportedReceiptCount: 4,
  previousSupportedSpend: 5_500,
  spendDelta: 5_598,
} as const;

describe('analysis truth unification (AP-1)', () => {
  describe('canonical mixed truth fixture snapshot', () => {
    it('matches fixed month constants and cross-surface equality', () => {
      const { analyticsReceipts } = buildCanonicalTruthFixture();
      const snapshot = buildAnalysisTruthSnapshot({
        receipts: analyticsReceipts,
        range: 'month',
        nowMs: NOW,
      });
      const spendSurface = buildAnalysisSpendChangeSurface(snapshot.insights);

      expect(snapshot.periodStats.supportedReceiptCount).toBe(
        CANONICAL_MONTH_TRUTH.currentSupportedReceiptCount
      );
      expect(snapshot.periodStats.supportedSpend).toBe(
        CANONICAL_MONTH_TRUTH.currentSupportedSpend
      );
      expect(snapshot.itemCount).toBe(CANONICAL_MONTH_TRUTH.currentItemCount);
      expect(snapshot.periodStats.categoryCompositionTotal).toBe(
        CANONICAL_MONTH_TRUTH.categoryCompositionTotal
      );
      expect(snapshot.periodStats.topMerchants[0]?.total).toBe(
        CANONICAL_MONTH_TRUTH.topMerchantSpend
      );

      expect(snapshot.insights.currentStats.supportedSpend).toBe(
        snapshot.periodStats.supportedSpend
      );
      expect(snapshot.insights.currentStats.supportedReceiptCount).toBe(
        snapshot.periodStats.supportedReceiptCount
      );
      expect(snapshot.insights.currentItemsCount).toBe(snapshot.itemCount);
      expect(snapshot.insights.previousStats?.supportedReceiptCount).toBe(
        CANONICAL_MONTH_TRUTH.previousSupportedReceiptCount
      );
      expect(snapshot.insights.previousStats?.supportedSpend).toBe(
        CANONICAL_MONTH_TRUTH.previousSupportedSpend
      );

      expect(
        snapshot.periodStats.categoryCompositionTotal
      ).not.toBe(snapshot.periodStats.supportedSpend);

      expect(spendSurface.status).toBe('available');
      expect(spendSurface).toMatchObject({
        status: 'available',
        direction: 'up',
        absoluteDelta: CANONICAL_MONTH_TRUTH.spendDelta,
        currentSpend: CANONICAL_MONTH_TRUTH.currentSupportedSpend,
        previousSpend: CANONICAL_MONTH_TRUTH.previousSupportedSpend,
      });

      expect(
        isAnalysisStorySufficient({
          supportedReceiptCount: snapshot.periodStats.supportedReceiptCount,
          supportedItemCount: snapshot.itemCount,
          supportedSpend: snapshot.periodStats.supportedSpend,
        })
      ).toBe(true);
      expect(snapshot.insights.story.type).toBe('full');
    });
  });

  describe('regression A — unsupported receipt excluded', () => {
    it('excludes unsupported from Overview supported metrics and Insights', () => {
      const supported = receipt('s1', {
        transaction_at: NOW - 1 * MS_DAY,
        total: 2000,
        items: Array.from({ length: 5 }, (_, i) =>
          item(`S-${i}`, 400, 'food_ingredients')
        ),
      });
      const unsupported = receipt('u1', {
        transaction_at: NOW - 2 * MS_DAY,
        total: 8000,
        merchant_type: 'other',
        items: [item('Drug', 8000, 'other')],
      });
      const rows = [supported, unsupported];
      const stats = calculateStats(rows, 'month', NOW);
      const insights = buildInsights(rows, 'month', {
        nowMs: NOW,
      });
      expect(stats.supportedReceiptCount).toBe(1);
      expect(stats.supportedSpend).toBe(2000);
      expect(insights.currentStats.supportedReceiptCount).toBe(1);
      expect(insights.currentStats.supportedSpend).toBe(2000);
    });
  });

  describe('regression B — non-JPY excluded', () => {
    it('excludes USD from Overview and Insights monetary universe', () => {
      const jpy = receipt('jpy', {
        transaction_at: NOW - 1 * MS_DAY,
        total: 1500,
      });
      const usd = receipt('usd', {
        transaction_at: NOW - 1 * MS_DAY,
        currency: 'USD',
        total: 999,
      });
      const rows = [jpy, usd];
      const stats = calculateStats(rows, 'month', NOW);
      const insights = buildInsights(rows, 'month', {
        nowMs: NOW,
      });
      expect(stats.totalSpend).toBe(1500);
      expect(stats.supportedSpend).toBe(1500);
      expect(insights.currentStats.supportedSpend).toBe(1500);
    });
  });

  describe('regression C — exact duplicate extra excluded', () => {
    it('uses canonical receipt only after analytics selection', () => {
      const a = receipt('keep', {
        transaction_at: NOW - 1 * MS_DAY,
        created_at: NOW - 2 * MS_DAY,
        total: 198,
        merchant_raw: 'イオン',
        merchant_normalized: 'イオン',
        items: [item('明治おいしい牛乳', 198, 'food_ingredients')],
      });
      const b = receipt('drop', {
        transaction_at: NOW - 1 * MS_DAY,
        created_at: NOW - 1 * MS_DAY,
        total: 198,
        merchant_raw: 'イオン',
        merchant_normalized: 'イオン',
        items: [item('明治おいしい牛乳', 198, 'food_ingredients')],
      });
      const analytics = selectAnalyticsReceipts([a, b]).analyticsReceipts;
      const eligible = selectAnalysisEligibleReceipts(analytics);
      expect(eligible.map((r) => r.id)).toEqual(['keep']);
      const stats = calculateStats(analytics, 'month', NOW);
      const insights = buildInsights(analytics, 'month', {
        nowMs: NOW,
      });
      expect(stats.supportedReceiptCount).toBe(1);
      expect(insights.currentStats.supportedReceiptCount).toBe(1);
    });
  });

  describe('regression D/E — week and month window alignment', () => {
    it('matches Overview current universe for week', () => {
      const inside = receipt('in', { transaction_at: NOW - 3 * MS_DAY, total: 1000 });
      const prior = receipt('prior', { transaction_at: NOW - 10 * MS_DAY, total: 1000 });
      const outside = receipt('out', { transaction_at: NOW - 20 * MS_DAY, total: 1000 });
      const rows = [inside, prior, outside];
      const periodSets = selectAnalysisPeriodReceiptSets(rows, 'week', NOW);
      const stats = calculateStats(rows, 'week', NOW);
      const insights = buildInsights(rows, 'week', {
        nowMs: NOW,
      });
      expect(periodSets.currentPeriodReceipts.map((r) => r.id)).toEqual(['in']);
      expect(insights.currentStats.supportedSpend).toBe(stats.supportedSpend);
      expect(periodSets.previousPeriodReceipts.map((r) => r.id)).toEqual([
        'prior',
      ]);
    });

    it('matches Overview current universe for month', () => {
      const inside = receipt('in', { transaction_at: NOW - 15 * MS_DAY, total: 1000 });
      const prior = receipt('prior', { transaction_at: NOW - 40 * MS_DAY, total: 1000 });
      const outside = receipt('out', { transaction_at: NOW - 70 * MS_DAY, total: 1000 });
      const rows = [inside, prior, outside];
      const stats = calculateStats(rows, 'month', NOW);
      const insights = buildInsights(rows, 'month', {
        nowMs: NOW,
      });
      expect(insights.currentStats.supportedReceiptCount).toBe(
        stats.supportedReceiptCount
      );
      expect(insights.currentStats.supportedSpend).toBe(stats.supportedSpend);
    });
  });

  describe('regression F — window boundary', () => {
    it('uses the same includeEnd contract at month lower bound', () => {
      const bounds = resolveAnalysisRollingWindowBounds('month', NOW);
      const atBoundary = receipt('boundary', {
        transaction_at: bounds.currentStartMs,
        total: 1000,
      });
      const rows = [atBoundary];
      const statsCurrent = filterAnalysisReceiptsByTransactionWindow(
        rows,
        bounds.currentStartMs,
        bounds.currentEndMs,
        { includeEnd: true }
      );
      const stats = calculateStats(rows, 'month', NOW);
      const insights = buildInsights(rows, 'month', {
        nowMs: NOW,
      });
      expect(statsCurrent).toHaveLength(1);
      expect(stats.supportedReceiptCount).toBe(1);
      expect(insights.currentStats.supportedReceiptCount).toBe(1);
      expect(validAnalysisTransactionAt(atBoundary)).toBe(
        bounds.currentStartMs
      );
    });
  });

  describe('regression G — sufficiency gate', () => {
    it('remains insufficient with 2 supported + 1 unsupported in period', () => {
      const s1 = receipt('s1', {
        transaction_at: NOW - 1 * MS_DAY,
        total: 1500,
        items: Array.from({ length: 5 }, (_, i) =>
          item(`A-${i}`, 300, 'food_ingredients')
        ),
      });
      const s2 = receipt('s2', {
        transaction_at: NOW - 2 * MS_DAY,
        total: 1500,
        items: Array.from({ length: 5 }, (_, i) =>
          item(`B-${i}`, 300, 'food_ingredients')
        ),
      });
      const unsupported = receipt('u1', {
        transaction_at: NOW - 2 * MS_DAY,
        total: 9000,
        merchant_type: 'other',
      });
      const insights = buildInsights([s1, s2, unsupported], 'month', {
        nowMs: NOW,
      });
      expect(insights.currentStats.supportedReceiptCount).toBe(2);
      expect(insights.story.type).toBe('fallback');
      expect(
        isAnalysisStorySufficient({
          supportedReceiptCount: insights.currentStats.supportedReceiptCount,
          supportedItemCount: insights.currentItemsCount,
          supportedSpend: insights.currentStats.supportedSpend,
        })
      ).toBe(false);
    });

    it('becomes sufficient with 3 supported meeting item/spend gates', () => {
      const mk = (id: string, dayOffset: number) =>
        receipt(id, {
          transaction_at: NOW - dayOffset * MS_DAY,
          total: 1000,
          items: Array.from({ length: 4 }, (_, i) =>
            item(`${id}-${i}`, 250, 'food_ingredients')
          ),
        });
      const rows = [mk('a', 1), mk('b', 5), mk('c', 10)];
      const insights = buildInsights(rows, 'month', {
        nowMs: NOW,
      });
      expect(insights.currentStats.supportedReceiptCount).toBe(
        ANALYSIS_STORY_MIN_SUPPORTED_RECEIPTS
      );
      expect(insights.currentItemsCount).toBeGreaterThanOrEqual(
        ANALYSIS_STORY_MIN_ITEMS
      );
      expect(insights.currentStats.supportedSpend).toBeGreaterThanOrEqual(
        ANALYSIS_STORY_MIN_SUPPORTED_SPEND_JPY
      );
      expect(insights.story.type).toBe('full');
    });
  });

  describe('regression H — category denominator semantics', () => {
    it('allows categoryCompositionTotal to differ from supportedSpend', () => {
      const row = receipt('mix', {
        transaction_at: NOW - 1 * MS_DAY,
        total: 2000,
        items: [
          item('Cat', 1200, 'food_ingredients'),
          item('Unknown', 800, 'uncategorized'),
        ],
      });
      const stats = calculateStats([row], 'month', NOW);
      expect(stats.supportedSpend).toBe(2000);
      expect(stats.categoryCompositionTotal).toBe(1200);
      expect(stats.uncategorizedTotal).toBe(800);
    });
  });

  describe('regression I — merchant universe alignment', () => {
    it('uses the same eligible receipts for merchant rows and merchant change', () => {
      const storeA = (id: string, tx: number, total: number) =>
        receipt(id, {
          transaction_at: tx,
          total,
          merchant_raw: 'Costco',
          merchant_normalized: 'costco',
          items: [item(id, total, 'food_ingredients')],
        });
      const current = [
        storeA('c1', NOW - 2 * MS_DAY, 5000),
        storeA('c2', NOW - 4 * MS_DAY, 4000),
        storeA('c3', NOW - 6 * MS_DAY, 3000),
      ];
      const previous = [
        storeA('p1', NOW - 35 * MS_DAY, 2000),
        storeA('p2', NOW - 40 * MS_DAY, 2000),
        storeA('p3', NOW - 45 * MS_DAY, 2000),
      ];
      const rows = [...current, ...previous];
      const stats = calculateStats(rows, 'month', NOW);
      const insights = buildInsights(rows, 'month', {
        nowMs: NOW,
      });
      expect(insights.currentStats.topMerchants[0]?.merchant).toBe(
        stats.topMerchants[0]?.merchant
      );
      expect(insights.currentStats.topMerchants[0]?.total).toBe(
        stats.topMerchants[0]?.total
      );
    });
  });

  describe('regression J — all range', () => {
    it('uses full eligible history for Overview and suppresses change without prior window', () => {
      const only = receipt('solo', {
        transaction_at: NOW - 100 * MS_DAY,
        total: 1500,
        items: Array.from({ length: 5 }, (_, i) =>
          item(`S-${i}`, 300, 'food_ingredients')
        ),
      });
      const snapshot = buildAnalysisTruthSnapshot({
        receipts: [only],
        range: 'all',
        nowMs: NOW,
      });
      expect(snapshot.periodStats.supportedReceiptCount).toBe(1);
      expect(snapshot.insights.previousStats).toBeNull();
      expect(snapshot.insights.changes).toHaveLength(0);
    });

    it('includes timestamp-invalid supported JPY in all WHAT universe', () => {
      const valid = receipt('valid', {
        transaction_at: NOW - 50 * MS_DAY,
        total: 1000,
      });
      const noTs = {
        ...receipt('no-ts', {
          transaction_at: NOW - 1 * MS_DAY,
          total: 500,
        }),
        transaction_at: null as unknown as number,
        created_at: NOW - 1 * MS_DAY,
      };
      const snapshot = buildAnalysisTruthSnapshot({
        receipts: [valid, noTs],
        range: 'all',
        nowMs: NOW,
      });
      const periodSets = selectAnalysisPeriodReceiptSets(
        [valid, noTs],
        'all',
        NOW
      );
      expect(periodSets.currentPeriodReceipts.map((r) => r.id).sort()).toEqual([
        'no-ts',
        'valid',
      ]);
      expect(snapshot.periodStats.supportedReceiptCount).toBe(2);
      expect(snapshot.periodStats.supportedSpend).toBe(1500);
      expect(snapshot.itemCount).toBe(2);
      expect(snapshot.insights.currentStats.supportedSpend).toBe(1500);
      expect(snapshot.insights.previousStats).toBeNull();
      expect(
        buildAnalysisSpendChangeSurface(snapshot.insights).status
      ).toBe('unavailable');
    });

    it('allows matched prior window when span history exists', () => {
      const early = receipt('early', {
        transaction_at: NOW - 120 * MS_DAY,
        total: 1000,
        items: Array.from({ length: 4 }, (_, i) =>
          item(`E-${i}`, 250, 'food_ingredients')
        ),
      });
      const mid = receipt('mid', {
        transaction_at: NOW - 90 * MS_DAY,
        total: 1000,
        items: Array.from({ length: 4 }, (_, i) =>
          item(`M-${i}`, 250, 'food_ingredients')
        ),
      });
      const late = receipt('late', {
        transaction_at: NOW - 30 * MS_DAY,
        total: 5000,
        items: Array.from({ length: 4 }, (_, i) =>
          item(`L-${i}`, 1250, 'food_ingredients')
        ),
      });
      const priorOnly = [
        receipt('p1', {
          transaction_at: NOW - 200 * MS_DAY,
          total: 1000,
          items: Array.from({ length: 4 }, (_, i) =>
            item(`P1-${i}`, 250, 'food_ingredients')
          ),
        }),
        receipt('p2', {
          transaction_at: NOW - 180 * MS_DAY,
          total: 1000,
          items: Array.from({ length: 4 }, (_, i) =>
            item(`P2-${i}`, 250, 'food_ingredients')
          ),
        }),
        receipt('p3', {
          transaction_at: NOW - 160 * MS_DAY,
          total: 1000,
          items: Array.from({ length: 4 }, (_, i) =>
            item(`P3-${i}`, 250, 'food_ingredients')
          ),
        }),
      ];
      const rows = [...priorOnly, early, mid, late];
      const overview = buildStatsSafe(rows, 'all', NOW);
      const insights = buildInsights(rows, 'all', {
        nowMs: NOW,
      });
      expect(overview.supportedReceiptCount).toBe(rows.length);
      expect(insights.currentStats.supportedSpend).toBe(overview.supportedSpend);
      if (insights.previousStats) {
        expect(insights.changes.length).toBeGreaterThan(0);
      }
    });
  });

  describe('supported item counting', () => {
    it('matches presentation helper on eligible receipts', () => {
      const rows = [
        receipt('a', {
          transaction_at: NOW,
          items: [
            item('1', 100, 'food_ingredients'),
            item('2', 100, 'food_ingredients'),
          ],
        }),
      ];
      const eligible = selectAnalysisEligibleReceipts(rows);
      expect(countSupportedItemsInEligibleReceipts(eligible)).toBe(2);
      expect(countSupportedItemsInRange(rows, 'all', NOW)).toBe(2);
    });
  });
});
