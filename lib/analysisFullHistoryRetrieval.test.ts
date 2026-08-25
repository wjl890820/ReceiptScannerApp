jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({ initIfNeeded: jest.fn(async () => undefined) }));

import * as fs from 'fs';
import * as path from 'path';

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import {
  countSupportedItemsInRange,
} from './analysisPresentation';
import type { ReceiptRow } from './db';
import { calculateStats } from './statsCalculator';

const APP_SOURCE = path.join(__dirname, '../app/(tabs)/analysis.tsx');
const DB_SOURCE = path.join(__dirname, './db.ts');
const REFERENCE_NOW = Date.parse('2026-08-25T03:00:00.000Z');

const EXPECTED = {
  storedReceipts: 206,
  duplicateExtras: 1,
  purchaseCandidates: 205,
  supportedPurchases: 205,
  supportedSpend: 21_000,
  itemRows: 205,
  foodAmount: 20_000,
  householdAmount: 1_000,
  recentMerchantCount: 200,
  recentMerchantSpend: 20_000,
  legacyMerchantCount: 5,
  legacyMerchantSpend: 1_000,
  formerCutoffCandidates: 199,
  formerCutoffSpend: 19_900,
} as const;

function receipt(args: {
  id: string;
  transactionAt: number;
  createdAt?: number;
  merchant: string;
  category: string;
  total: number;
  itemName: string;
}): ReceiptRow {
  return {
    id: args.id,
    created_at: args.createdAt ?? args.transactionAt + 1_000,
    transaction_at: args.transactionAt,
    image_uri: '',
    merchant_raw: args.merchant,
    merchant_normalized: args.merchant,
    merchant_type: 'supermarket',
    store_raw: args.merchant,
    store_normalized: args.merchant,
    total: args.total,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      merchant: args.merchant,
      merchant_type: 'supermarket',
      total: args.total,
      items: [
        {
          name: args.itemName,
          category: args.category,
          classification_status: 'ok',
          lineTotal: args.total,
          quantity: 1,
        },
      ],
    }),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  };
}

function largeHistoryFixture(): ReceiptRow[] {
  const recent = Array.from({ length: 200 }, (_, index) =>
    receipt({
      id: `recent-${index}`,
      transactionAt: REFERENCE_NOW - (index + 1) * 60_000,
      merchant: 'Recent Store',
      category: 'food_ingredients',
      total: 100,
      itemName: `Recent item ${index}`,
    })
  );
  const duplicate = {
    ...recent[0],
    id: 'recent-0-duplicate',
    created_at: recent[0]!.created_at + 1,
  };
  const older = Array.from({ length: 5 }, (_, index) =>
    receipt({
      id: `legacy-${index}`,
      transactionAt: REFERENCE_NOW - (201 + index) * 60_000,
      merchant: 'Legacy Store',
      category: 'household',
      total: 200,
      itemName: `Legacy item ${index}`,
    })
  );

  return [recent[0]!, duplicate, ...recent.slice(1), ...older];
}

describe('Analysis full-history retrieval contract', () => {
  it('uses an explicit unbounded Analysis reader while preserving the generic default', () => {
    const appSource = fs.readFileSync(APP_SOURCE, 'utf8');
    const dbSource = fs.readFileSync(DB_SOURCE, 'utf8');

    expect(appSource).toContain('await listReceiptsForAnalysis()');
    expect(appSource).not.toContain('await listReceipts()');
    expect(dbSource).toContain('export async function listReceipts(limit = 200)');
    expect(dbSource).toContain('return listReceiptRows(limit);');
    expect(dbSource).toContain('export async function listReceiptsForAnalysis()');
    expect(dbSource).toContain('return listReceiptRows(null);');
  });

  it('includes purchases beyond the former 200-row cutoff without counting duplicate scans', () => {
    const storedReceipts = largeHistoryFixture();
    const selection = selectAnalyticsReceipts(storedReceipts);
    const stats = calculateStats(selection.analyticsReceipts, 'all');

    expect(storedReceipts).toHaveLength(EXPECTED.storedReceipts);
    expect(selection.highConfidenceDuplicateExtras).toBe(
      EXPECTED.duplicateExtras
    );
    expect(selection.analyticsReceipts).toHaveLength(
      EXPECTED.purchaseCandidates
    );
    expect(stats.supportedReceiptCount).toBe(EXPECTED.supportedPurchases);
    expect(stats.supportedSpend).toBe(EXPECTED.supportedSpend);
    expect(
      countSupportedItemsInRange(
        selection.analyticsReceipts,
        'all',
        REFERENCE_NOW
      )
    ).toBe(EXPECTED.itemRows);
    expect(stats.categoryBreakdown).toEqual([
      { category: 'food_ingredients', amount: EXPECTED.foodAmount },
      { category: 'household', amount: EXPECTED.householdAmount },
    ]);
    expect(stats.topMerchants).toEqual([
      {
        merchant: 'recent store',
        count: EXPECTED.recentMerchantCount,
        total: EXPECTED.recentMerchantSpend,
      },
      {
        merchant: 'legacy store',
        count: EXPECTED.legacyMerchantCount,
        total: EXPECTED.legacyMerchantSpend,
      },
    ]);

    const formerCutoffSelection = selectAnalyticsReceipts(
      storedReceipts.slice(0, 200)
    );
    const formerCutoffStats = calculateStats(
      formerCutoffSelection.analyticsReceipts,
      'all'
    );
    expect(formerCutoffSelection.analyticsReceipts).toHaveLength(
      EXPECTED.formerCutoffCandidates
    );
    expect(formerCutoffStats.supportedSpend).toBe(EXPECTED.formerCutoffSpend);
    expect(formerCutoffStats.categoryBreakdown).toEqual([
      { category: 'food_ingredients', amount: EXPECTED.formerCutoffSpend },
    ]);
    expect(
      formerCutoffStats.topMerchants.some(
        (row) => row.merchant === 'legacy store'
      )
    ).toBe(false);
  });
});
