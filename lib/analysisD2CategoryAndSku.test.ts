/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({ initIfNeeded: jest.fn(async () => undefined) }));

import * as fs from 'fs';
import * as path from 'path';

import {
  buildAnalysisCategoryBucketAmounts,
  buildAnalysisCategoryConservation,
  buildAnalysisCategoryShares,
} from './analysisPresentation';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { buildAnalysisDReport } from './analysisDReport';
import {
  buildFiveReceiptMilestone,
  frequentProductGroups,
  type EngagementProductRow,
  type EngagementReceipt,
} from './engagementMilestones';
import { resolveItemFinalCategory } from './homeMetricsHelpers';
import { normalizeProductCategory } from './productCategory';
import { buildSkuKey, resolveProductIdentity } from './productIdentity';
import { buildTrustedProductPriceHistoryForTests as buildTrustedProductPriceHistory } from './productPriceHistory.testFixtures';
import { V1_SPENDING_CATEGORIES } from './productTaxonomy';
import { calculateStats } from './statsCalculator';
import type { ReceiptRow } from './db';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-22T12:00:00+09:00');
const SKU_A = 'v1|testsku|volume:500ml|pack:1';
const SKU_B = 'v1|otherbrand|volume:500ml|pack:1';

function makeReceipt(args: {
  id: string;
  items: Array<Record<string, unknown>>;
  total?: number;
  merchantType?: string;
  userItems?: Array<Record<string, unknown>> | null;
  at?: number;
}): ReceiptRow {
  const at = args.at ?? NOW - DAY_MS;
  const itemSum = args.items.reduce(
    (sum, item) => sum + (Number(item.lineTotal) || 0),
    0
  );
  return {
    id: args.id,
    created_at: at,
    transaction_at: at,
    image_uri: '',
    total: args.total ?? itemSum,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({ items: args.items }),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: args.merchantType ?? 'supermarket',
    user_edited: args.userItems ? 1 : 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: args.userItems ? JSON.stringify(args.userItems) : null,
  } as ReceiptRow;
}

function engagementReceipt(id: string, at = Number(id.replace(/\D/g, '')) * DAY_MS): EngagementReceipt {
  return {
    id,
    created_at: at,
    transaction_at: at,
    merchant_raw: 'Store',
    merchant_normalized: 'store',
    merchant_type: 'supermarket',
    total: 100,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [{ name: 'x', category: 'food_ingredients', lineTotal: 100, quantity: 1 }],
    }),
    final_total: null,
    user_items_json: null,
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
    skuKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    ...overrides,
  };
}

describe('D2-B category conservation', () => {
  it('historical keys resolve deterministically via read-time normalize', () => {
    expect(normalizeProductCategory('produce')).toBe('food_ingredients');
    expect(normalizeProductCategory('snacks_sweets')).toBe('snacks_drinks');
    expect(normalizeProductCategory('health_supplements')).toBe('personal_care');
    expect(normalizeProductCategory('prepared_food')).toBe('ready_to_eat');
    expect(normalizeProductCategory('daily_goods')).toBe('household');
  });

  it('legacy OLD_TO_NEW remains read-time only (no receipt JSON rewrite)', () => {
    const receipt = makeReceipt({
      id: 'legacy-key',
      items: [
        { name: '野菜', category: 'produce', lineTotal: 300, quantity: 1 },
        { name: '菓子', category: 'snacks_sweets', lineTotal: 200, quantity: 1 },
      ],
    });
    const before = receipt.analysis_json;
    const stats = calculateStats([receipt], 'all');
    expect(receipt.analysis_json).toBe(before);
    expect(stats.categoryBreakdown.map((r) => r.category).sort()).toEqual([
      'food_ingredients',
      'snacks_drinks',
    ]);
    expect(stats.categoryCompositionTotal).toBe(500);
  });

  it('exact conservation: breakdown sum === compositionTotal; 7-buckets conserve', () => {
    const receipt = makeReceipt({
      id: 'conserve',
      items: [
        { name: 'a', category: 'food_ingredients', lineTotal: 400, quantity: 1 },
        { name: 'b', category: 'snacks_drinks', lineTotal: 300, quantity: 1 },
        { name: 'c', category: 'ready_to_eat', lineTotal: 200, quantity: 1 },
        { name: 'd', category: 'household', lineTotal: 100, quantity: 1 },
      ],
    });
    const stats = calculateStats([receipt], 'all');
    const breakdownSum = stats.categoryBreakdown.reduce((s, r) => s + r.amount, 0);
    expect(breakdownSum).toBe(stats.categoryCompositionTotal);
    expect(stats.topCategories).toHaveLength(3);
    expect(stats.categoryBreakdown).toHaveLength(4);

    const shares = buildAnalysisCategoryShares(stats);
    expect(shares).toHaveLength(4);
    expect(shares.map((s) => s.category)).toContain('household');

    const buckets = buildAnalysisCategoryBucketAmounts(stats);
    expect(buckets.map((b) => b.category)).toEqual([...V1_SPENDING_CATEGORIES]);
    expect(buckets.reduce((s, b) => s + b.amount, 0)).toBe(1000);

    const conservation = buildAnalysisCategoryConservation(stats);
    expect(conservation.gap).toBe(0);
    expect(conservation.conserved).toBe(true);
    expect(conservation.unresolvedOrSystemAmount).toBe(0);
  });

  it('eliminates 14351-style leakage: 4th category visible; diagnostic gap 0', () => {
    const receipt = makeReceipt({
      id: 'leak',
      items: [
        { name: '1', category: 'snacks_drinks', lineTotal: 20000, quantity: 1 },
        { name: '2', category: 'food_ingredients', lineTotal: 18000, quantity: 1 },
        { name: '3', category: 'ready_to_eat', lineTotal: 15000, quantity: 1 },
        { name: '4', category: 'personal_care', lineTotal: 14351, quantity: 1 },
      ],
    });
    const stats = calculateStats([receipt], 'all');
    expect(stats.categoryCompositionTotal).toBe(67351);
    expect(stats.topCategories.map((r) => r.category)).not.toContain('personal_care');
    const shares = buildAnalysisCategoryShares(stats);
    expect(shares.find((s) => s.category === 'personal_care')?.amount).toBe(14351);

    const report = buildAnalysisDReport({ receipts: [receipt], nowMs: NOW });
    const allWindow = report.categoryValue.find((w) => w.window === 'all')!;
    expect(allWindow.conservation.gap).toBe(0);
    expect(
      allWindow.categories.find((c) => c.category === 'personal_care')?.amount
    ).toBe(14351);
  });

  it('user override is authoritative over analysis_json category', () => {
    const receipt = makeReceipt({
      id: 'override',
      items: [
        {
          name: '牛乳',
          category: 'snacks_drinks',
          lineTotal: 250,
          quantity: 1,
          classification_source: 'rules',
        },
      ],
      userItems: [
        {
          name: '牛乳',
          category: 'food_ingredients',
          lineTotal: 250,
          quantity: 1,
          classification_source: 'user',
        },
      ],
    });
    expect(resolveItemFinalCategory(receipt.user_items_json ? JSON.parse(receipt.user_items_json!)[0] : {})).toBe(
      'food_ingredients'
    );
    const stats = calculateStats([receipt], 'all');
    expect(stats.categoryBreakdown).toEqual([
      { category: 'food_ingredients', amount: 250 },
    ]);
    expect(stats.categoryBreakdown.find((r) => r.category === 'snacks_drinks')).toBeUndefined();
  });

  it('uncategorized stays a review bucket outside compositionTotal', () => {
    const receipt = makeReceipt({
      id: 'uncat',
      items: [
        { name: 'ok', category: 'household', lineTotal: 100, quantity: 1 },
        { name: '??', category: 'uncategorized', lineTotal: 50, quantity: 1 },
      ],
    });
    const stats = calculateStats([receipt], 'all');
    expect(stats.categoryCompositionTotal).toBe(100);
    expect(stats.uncategorizedCount).toBe(1);
    expect(stats.uncategorizedTotal).toBe(50);
    const conservation = buildAnalysisCategoryConservation(stats);
    expect(conservation.conserved).toBe(true);
    expect(conservation.unresolvedOrSystemAmount).toBe(50);
    expect(
      buildAnalysisCategoryShares(stats).find((s) => s.category === 'uncategorized')
    ).toBeUndefined();
  });

  it('seven active spending categories remain the valid V1 set', () => {
    expect([...V1_SPENDING_CATEGORIES]).toEqual([
      'food_ingredients',
      'ready_to_eat',
      'snacks_drinks',
      'household',
      'personal_care',
      'pet_care',
      'other',
    ]);
  });

  it('selectAnalyticsReceipts is respected for category analytics inputs', () => {
    const keep = {
      ...makeReceipt({
        id: 'keep',
        at: NOW,
        items: [
          {
            name: '明治おいしい牛乳',
            category: 'food_ingredients',
            lineTotal: 198,
            quantity: 1,
          },
        ],
        total: 198,
      }),
      created_at: NOW,
      transaction_at: NOW,
    } as ReceiptRow;
    const drop = {
      ...makeReceipt({
        id: 'drop',
        at: NOW,
        items: [
          {
            name: '明治おいしい牛乳',
            category: 'food_ingredients',
            lineTotal: 198,
            quantity: 1,
          },
        ],
        total: 198,
      }),
      created_at: NOW + 1,
      transaction_at: NOW,
    } as ReceiptRow;
    const selection = selectAnalyticsReceipts([keep, drop]);
    expect([...selection.excludedDuplicateReceiptIds]).toEqual(['drop']);
    const analyticsStats = calculateStats(selection.analyticsReceipts, 'all');
    const allStats = calculateStats([keep, drop], 'all');
    expect(analyticsStats.categoryCompositionTotal).toBe(198);
    expect(allStats.categoryCompositionTotal).toBe(396);
  });
});

describe('D2-C frequent SKU fallback', () => {
  const fiveReceipts = [1, 2, 3, 4, 5].map((n) => engagementReceipt(`r${n}`));

  it('repeated same sku without family/canonical becomes frequent', () => {
    const rows = [
      productRow('r1', 'a', {
        skuKey: SKU_A,
        displayName: 'ミネラルウォーター 500ml',
        purchaseQuantity: 2,
      }),
      productRow('r2', 'b', {
        skuKey: SKU_A,
        displayName: 'ミネラルウォーター 500ml',
        purchaseQuantity: 5,
      }),
      productRow('r3', 'c', {
        skuKey: SKU_A,
        displayName: 'ミネラルウォーター 500ml',
        purchaseQuantity: 1,
      }),
    ];
    const result = frequentProductGroups(fiveReceipts, {
      rows,
      queryFailed: false,
      priceHistoryBuilder: buildTrustedProductPriceHistory,
    });
    expect(result.frequentProducts).toHaveLength(1);
    expect(result.frequentProducts[0].groupingType).toBe('sku');
    expect(result.frequentProducts[0].key).toBe(SKU_A);
    expect(result.frequentProducts[0].displayLabel).toBe('ミネラルウォーター 500ml');
    expect(result.frequentProducts[0].displayLabel).not.toContain('v1|');
  });

  it('occurrence is distinct receipt count, not quantity', () => {
    const rows = [
      productRow('r1', 'a', { skuKey: SKU_A, purchaseQuantity: 10 }),
      productRow('r2', 'b', { skuKey: SKU_A, purchaseQuantity: 10 }),
    ];
    const result = frequentProductGroups(fiveReceipts, {
      rows,
      queryFailed: false,
    });
    expect(result.frequentProducts[0].purchaseOccurrenceCount).toBe(2);
    expect(result.frequentProducts[0].totalPurchaseQuantity).toBe(20);
  });

  it('duplicate extras do not inflate when filtered from product rows', () => {
    const rows = [
      productRow('r1', 'a', { skuKey: SKU_A }),
      productRow('r2', 'b', { skuKey: SKU_A }),
      productRow('r99', 'dup', { skuKey: SKU_A }), // not in selected receipts
    ];
    const result = frequentProductGroups(fiveReceipts, {
      rows,
      queryFailed: false,
    });
    expect(result.frequentProducts[0].purchaseOccurrenceCount).toBe(2);
  });

  it('different specs/brands do not merge when sku differs', () => {
    const rows = [
      productRow('r1', 'a', { skuKey: SKU_A, displayName: 'Brand A' }),
      productRow('r2', 'b', { skuKey: SKU_A, displayName: 'Brand A' }),
      productRow('r3', 'c', { skuKey: SKU_B, displayName: 'Brand B' }),
      productRow('r4', 'd', { skuKey: SKU_B, displayName: 'Brand B' }),
    ];
    const result = frequentProductGroups(fiveReceipts, {
      rows,
      queryFailed: false,
    });
    expect(result.frequentProducts).toHaveLength(2);
    expect(new Set(result.frequentProducts.map((p) => p.key))).toEqual(
      new Set([SKU_A, SKU_B])
    );
  });

  it('canonical > family > sku hierarchy', () => {
    const rows = [
      productRow('r1', 'a', {
        canonicalProductName: '明治牛乳',
        productFamilyKey: 'milk',
        skuKey: SKU_A,
      }),
      productRow('r2', 'b', {
        canonicalProductName: '明治牛乳',
        productFamilyKey: 'milk',
        skuKey: SKU_A,
      }),
      productRow('r3', 'c', {
        productFamilyKey: 'water',
        skuKey: SKU_B,
      }),
      productRow('r4', 'd', {
        productFamilyKey: 'water',
        skuKey: SKU_B,
      }),
    ];
    const result = frequentProductGroups(fiveReceipts, {
      rows,
      queryFailed: false,
      priceHistoryBuilder: buildTrustedProductPriceHistory,
    });
    expect(
      result.frequentProducts.map((p) => ({ type: p.groupingType, key: p.key }))
    ).toEqual(
      expect.arrayContaining([
        { type: 'canonical', key: '明治牛乳' },
        { type: 'family', key: 'water' },
      ])
    );
    expect(result.frequentProducts).toHaveLength(2);
    expect(
      result.frequentProducts.every((p) => p.groupingType !== 'sku')
    ).toBe(true);
  });

  it('uses existing buildSkuKey identity contract (no bare normalized_name key)', () => {
    const identity = resolveProductIdentity({
      rawName: '明治おいしい牛乳 1000ml',
      category: 'food_ingredients',
    });
    const sku = buildSkuKey(identity);
    expect(sku).toMatch(/^v1\|/);
    expect(sku).toContain('volume:');
    // Bare normalized name must never be a grouping key in source
    const source = fs.readFileSync(
      path.join(__dirname, 'engagementMilestones.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/levenshtein|string.?similarity/i);
    expect(source).toContain('skuKey');
    expect(source).toContain('canonical > family > existing sku_key');
    expect(source).toContain('Never fuzzy-merge bare normalized names');
  });

  it('sku target uses purchase_unit only — does not unlock family normalized price', () => {
    const rows = [
      productRow('r1', 'a', {
        skuKey: SKU_A,
        volumeBaseMl: 1000,
        lineTotal: 250,
        purchaseQuantity: 1,
        displayName: 'Water 1000ml',
      }),
      productRow('r2', 'b', {
        skuKey: SKU_A,
        volumeBaseMl: 1000,
        lineTotal: 240,
        purchaseQuantity: 1,
        displayName: 'Water 1000ml',
      }),
    ];
    const skuHistory = buildTrustedProductPriceHistory({ type: 'sku', key: SKU_A }, rows);
    expect(skuHistory.priceKind).toBe('purchase_unit');
    expect(skuHistory.points.every((p) => p.priceKind === 'purchase_unit')).toBe(
      true
    );

    const milestone = buildFiveReceiptMilestone(fiveReceipts, {
      rows,
      queryFailed: false,
      priceHistoryBuilder: buildTrustedProductPriceHistory,
    });
    const skuGroup = milestone?.frequentProducts.find((p) => p.groupingType === 'sku');
    expect(skuGroup).toBeTruthy();
    expect(skuGroup?.priceSummary?.priceKind).toBe('purchase_unit');
  });

  it('diagnostics distinguish sku vs higher-semantic unresolved', () => {
    const receiptA = makeReceipt({
      id: 'diag-a',
      items: [{ name: '謎の商品XYZ', category: 'other', lineTotal: 80, quantity: 1 }],
    });
    const productRows: EngagementProductRow[] = [
      productRow('diag-a', 'i1', {
        displayName: '謎の商品XYZ',
        skuKey: SKU_A,
        merchant_type: 'supermarket',
        analysis_json: receiptA.analysis_json,
      }),
      productRow('diag-a', 'i2', {
        displayName: '別の謎',
        skuKey: null,
        sourceIndex: 1,
        merchant_type: 'supermarket',
        analysis_json: receiptA.analysis_json,
      }),
    ];
    // Second item on same receipt for unresolved without sku
    const receipt = makeReceipt({
      id: 'diag-a',
      items: [
        { name: '謎の商品XYZ', category: 'other', lineTotal: 80, quantity: 1 },
        { name: '別の謎', category: 'other', lineTotal: 40, quantity: 1 },
      ],
    });
    const report = buildAnalysisDReport({
      receipts: [receipt],
      productRows,
      nowMs: NOW,
    });
    const allFreq = report.frequentProducts.find((w) => w.window === 'all')!;
    expect(allFreq.skuIdentityAvailable).toBeGreaterThanOrEqual(1);
    expect(allFreq.higherSemanticIdentityUnresolved).toBeGreaterThanOrEqual(1);
    // Fully unresolved excludes rows that still have sku_key
    expect(allFreq.unresolvedIdentityItemRows).toBeLessThan(
      allFreq.higherSemanticIdentityUnresolved
    );
    expect(report.identityCoverage.higherSemanticIdentityUnresolved).toBeGreaterThanOrEqual(
      0
    );
  });
});
