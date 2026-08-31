/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({ initIfNeeded: jest.fn(async () => undefined) }));

import * as fs from 'fs';
import * as path from 'path';

import {
  auditKnownStructuralCostco9534Case,
  buildAnalysisDDuplicateScanAudit,
} from './analysisDDuplicateAudit';
import { generateAnalysisDDiagnosticsBundle } from './analysisDDiagnosticsGenerate';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { buildAnalysisDReport } from './analysisDReport';
import {
  frequentProductGroups,
  type EngagementProductRow,
  type EngagementReceipt,
} from './engagementMilestones';
import {
  buildSkuKey,
  hasPersistedSkuIdentity,
  isPurchaseUnitPriceUsable,
  isSkuPurchaseUnitPriceHistoryUsable,
  resolveExactProductSkuKey,
  resolveProductIdentity,
} from './productIdentity';
import { buildTrustedProductPriceHistoryForTests as buildTrustedProductPriceHistory } from './productPriceHistory.testFixtures';
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


const COSTCO_AT = Date.parse('2023-07-06T11:44:00+09:00');

describe('D2-D SKU contract + diagnostics alignment', () => {
  it('A — same buildSkuKey feeds SKU price-history usability and frequent SKU fallback', () => {
    const identity = resolveProductIdentity({
      rawName: '明治 おいしい牛乳 900ml',
    });
    const sku = buildSkuKey(identity);
    expect(sku).not.toBeNull();
    expect(resolveExactProductSkuKey(identity)).toBe(sku);

    const usable = {
      skuKey: sku,
      lineTotal: 200,
      purchaseQuantity: 1,
    };
    expect(isSkuPurchaseUnitPriceHistoryUsable(usable)).toBe(true);

    const five = [1, 2, 3, 4, 5].map((n) => engagementReceipt(`r${n}`));
    const result = frequentProductGroups(five, {
      rows: [
        productRow('r1', 'a', { skuKey: sku!, displayName: '明治牛乳' }),
        productRow('r2', 'b', { skuKey: sku!, displayName: '明治牛乳' }),
      ],
      queryFailed: false,
      priceHistoryBuilder: buildTrustedProductPriceHistory,
    });
    expect(result.frequentProducts[0].groupingType).toBe('sku');
    expect(result.frequentProducts[0].key).toBe(sku);
  });

  it('B — purchase-unit usable alone cannot be SKU price-history usable / withSku', () => {
    const purchaseOnly = {
      skuKey: null as string | null,
      lineTotal: 500,
      purchaseQuantity: 2,
    };
    expect(isPurchaseUnitPriceUsable(purchaseOnly)).toBe(true);
    expect(hasPersistedSkuIdentity(purchaseOnly)).toBe(false);
    expect(isSkuPurchaseUnitPriceHistoryUsable(purchaseOnly)).toBe(false);

    const report = buildAnalysisDReport({
      receipts: [
        makeReceipt({
          id: 'pu-1',
          items: [
            {
              name: 'なぞ商品',
              category: 'food_ingredients',
              lineTotal: 500,
              quantity: 2,
            },
          ],
        }),
      ],
      nowMs: NOW,
    });
    expect(report.priceCoverage.purchaseUnitPriceUsableRows).toBeGreaterThan(0);
    expect(report.identityCoverage.withSku).toBe(0);
    expect(report.priceCoverage.skuIdentityRows).toBe(0);
    expect(report.priceCoverage.skuPriceHistoryUsableRows).toBe(0);
  });

  it('C — repeated exact SKU without canonical/family becomes frequent', () => {
    const five = [1, 2, 3, 4, 5].map((n) => engagementReceipt(`r${n}`));
    const result = frequentProductGroups(five, {
      rows: [
        productRow('r1', 'a', { skuKey: SKU_A }),
        productRow('r2', 'b', { skuKey: SKU_A }),
      ],
      queryFailed: false,
    });
    expect(result.frequentProducts).toHaveLength(1);
    expect(result.frequentProducts[0].groupingType).toBe('sku');
  });

  it('D — different explicit SKU specs remain separate', () => {
    const five = [1, 2, 3, 4, 5].map((n) => engagementReceipt(`r${n}`));
    const result = frequentProductGroups(five, {
      rows: [
        productRow('r1', 'a', { skuKey: SKU_A }),
        productRow('r2', 'b', { skuKey: SKU_A }),
        productRow('r3', 'c', { skuKey: SKU_B }),
        productRow('r4', 'd', { skuKey: SKU_B }),
      ],
      queryFailed: false,
    });
    expect(result.frequentProducts).toHaveLength(2);
  });

  it('E — duplicate extras cannot inflate SKU occurrences', () => {
    const five = [1, 2, 3, 4, 5].map((n) => engagementReceipt(`r${n}`));
    const result = frequentProductGroups(five, {
      rows: [
        productRow('r1', 'a', { skuKey: SKU_A }),
        productRow('r2', 'b', { skuKey: SKU_A }),
        productRow('r99', 'dup', { skuKey: SKU_A }),
      ],
      queryFailed: false,
    });
    expect(result.frequentProducts[0].purchaseOccurrenceCount).toBe(2);
  });

  it('F — canonical > family > sku priority remains', () => {
    const five = [1, 2, 3, 4, 5].map((n) => engagementReceipt(`r${n}`));
    const result = frequentProductGroups(five, {
      rows: [
        productRow('r1', 'a', {
          canonicalProductName: 'Canon Milk',
          productFamilyKey: 'milk',
          skuKey: SKU_A,
        }),
        productRow('r2', 'b', {
          canonicalProductName: 'Canon Milk',
          productFamilyKey: 'milk',
          skuKey: SKU_A,
        }),
      ],
      queryFailed: false,
    });
    expect(result.frequentProducts[0].groupingType).toBe('canonical');
  });

  it('G — SKU fallback does not enable family normalized comparison', () => {
    const rows = [
      productRow('r1', 'a', {
        skuKey: SKU_A,
        productFamilyKey: null,
        lineTotal: 200,
        purchaseQuantity: 1,
      }),
      productRow('r2', 'b', {
        skuKey: SKU_A,
        productFamilyKey: null,
        lineTotal: 220,
        purchaseQuantity: 1,
      }),
    ];
    const skuHistory = buildTrustedProductPriceHistory({ type: 'sku', key: SKU_A }, rows);
    expect(skuHistory.comparableOccurrenceCount).toBeGreaterThanOrEqual(2);
    expect(skuHistory.priceKind).toBe('purchase_unit');

    const familyHistory = buildTrustedProductPriceHistory(
      { type: 'family', key: 'milk' },
      rows
    );
    expect(familyHistory.comparableOccurrenceCount).toBe(0);
  });

  it('H — Home runtime analytics path uses selected receipts', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    expect(source).toContain('selectAnalyticsReceipts');
    expect(source).toContain('.analyticsReceipts');
  });

  it('I — Analysis runtime path uses selected receipts', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(source).toContain('selectAnalyticsReceipts');
    expect(source).toContain('.analyticsReceipts');
    expect(source).toContain('buildAnalysisTruthSnapshot');
  });

  it('J — merchant/trend/insight purchase paths consume Analysis selected receipts', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(source).toMatch(
      /selectAnalyticsReceipts\(allReceipts\)\.analyticsReceipts/
    );
    expect(source).toMatch(/receipts:\s*analyticsReceipts/);
    expect(source).toMatch(
      /buildAnalysisTruthSnapshot\(\{\s*receipts:\s*truthCycle\.receipts/
    );
  });

  it('K — Product Detail/history excludes duplicate scan observations', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/product/[targetType].tsx'),
      'utf8'
    );
    expect(source).toContain('selectAnalyticsReceipts');
    expect(source).toContain('excludedDuplicateReceiptIds');
  });

  it('L — diagnostic productionAnalytics uses the same selected boundary', async () => {
    const keep = makeReceipt({
      id: 'keep',
      at: COSTCO_AT,
      items: [
        {
          name: 'item',
          category: 'food_ingredients',
          lineTotal: 9534,
          quantity: 1,
        },
      ],
      total: 9534,
    });
    keep.merchant_normalized = 'Costco';
    keep.merchant_raw = 'コストコ';
    const drop = makeReceipt({
      id: 'drop',
      at: COSTCO_AT,
      items: [
        {
          name: 'item',
          category: 'food_ingredients',
          lineTotal: 9534,
          quantity: 1,
        },
      ],
      total: 9534,
    });
    drop.merchant_normalized = 'Costco';
    drop.merchant_raw = 'コストコ';

    const bundle = await generateAnalysisDDiagnosticsBundle({
      listReceiptsFn: async () => [keep, drop],
      nowMs: NOW,
    });
    const selection = selectAnalyticsReceipts([keep, drop]);
    expect(bundle.selection.analyticsPurchaseCandidateCount).toBe(
      selection.analyticsPurchaseCandidateCount
    );
    expect(bundle.productionAnalytics.dataset.totalLocalReceiptCount).toBe(
      selection.analyticsReceipts.length
    );
    expect(bundle.storedScanBaseline.dataset.totalLocalReceiptCount).toBe(2);
    expect(bundle.report).toBe(bundle.productionAnalytics);
  });

  it('M — crossSurfaceParity compares selected production data', async () => {
    const receipts = [
      makeReceipt({
        id: 'a',
        items: [
          {
            name: '牛乳',
            category: 'food_ingredients',
            lineTotal: 200,
            quantity: 1,
          },
        ],
      }),
    ];
    const bundle = await generateAnalysisDDiagnosticsBundle({
      listReceiptsFn: async () => receipts,
      nowMs: NOW,
    });
    expect(
      bundle.productionAnalytics.crossSurfaceParity.every((row) => row.identical)
    ).toBe(true);
  });

  it('N — storedScanBaseline remains available but clearly raw', async () => {
    const receipts = [
      makeReceipt({
        id: 'a',
        items: [
          {
            name: '牛乳',
            category: 'food_ingredients',
            lineTotal: 200,
            quantity: 1,
          },
        ],
      }),
    ];
    const bundle = await generateAnalysisDDiagnosticsBundle({
      listReceiptsFn: async () => receipts,
      nowMs: NOW,
    });
    expect(bundle.storedScanBaseline.dataset.totalLocalReceiptCount).toBe(
      receipts.length
    );
  });

  it('O — category gap remains 0', () => {
    const report = buildAnalysisDReport({
      receipts: [
        makeReceipt({
          id: 'cat',
          items: [
            {
              name: '牛乳',
              category: 'food_ingredients',
              lineTotal: 200,
              quantity: 1,
            },
            {
              name: '洗剤',
              category: 'household',
              lineTotal: 300,
              quantity: 1,
            },
          ],
        }),
      ],
      nowMs: NOW,
    });
    for (const window of report.categoryValue) {
      expect(window.conservation.gap).toBe(0);
      expect(window.conservation.conserved).toBe(true);
    }
  });

  it('P — no receipt mutation in diagnostics generate path', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'analysisDDiagnosticsGenerate.ts'),
      'utf8'
    );
    for (const banned of [
      'updateReceipt',
      'saveReceipt',
      'deleteReceipt',
      'rebuildAll',
      'writeReceipt',
    ]) {
      expect(source).not.toContain(banned);
    }
    expect(source).toContain('selectAnalyticsReceipts');
    expect(source).toContain('storedScanBaseline');
    expect(source).toContain('productionAnalytics');
  });

  it('Costco ¥9534 structural case is explicit and sweet-potato scope stays narrow', () => {
    const scans = [0, 1, 2].map((i) => {
      const row = makeReceipt({
        id: `costco-${i}`,
        at: COSTCO_AT, // same purchase time — re-scans differ only by created_at
        total: 9534,
        items: [
          {
            name: 'roast chicken',
            category: 'ready_to_eat',
            lineTotal: 9534,
            quantity: 1,
          },
        ],
      });
      row.created_at = COSTCO_AT + i * 30_000;
      row.merchant_normalized = 'Costco';
      row.merchant_raw = 'コストコ';
      return row;
    });
    const known = auditKnownStructuralCostco9534Case(scans);
    expect(known).not.toBeNull();
    expect(known!.storedScanCount).toBe(3);
    expect(known!.structuralPurchaseCandidateCount).toBe(1);
    expect(known!.transactionAtLabel).toContain('2023-07-06');

    const audit = buildAnalysisDDuplicateScanAudit(scans, NOW);
    expect(audit.knownStructuralDuplicateCases).toHaveLength(1);
    expect(audit.sweetPotatoAudit.scopeNote.toLowerCase()).toContain(
      'sweet-potato'
    );
  });

  it('duplicate impact price observations use purchase-unit usable (not SKU identity)', () => {
    const receipts = [
      makeReceipt({
        id: 'p1',
        items: [
          {
            name: 'なぞ商品',
            category: 'food_ingredients',
            lineTotal: 100,
            quantity: 1,
          },
        ],
      }),
    ];
    const report = buildAnalysisDReport({ receipts, nowMs: NOW });
    const audit = buildAnalysisDDuplicateScanAudit(receipts, NOW);
    expect(audit.impact.before.priceHistoryObservationCount).toBe(
      report.priceCoverage.purchaseUnitPriceUsableRows
    );
  });
});
