/**
 * R6 — personal_product Product Detail must honor caller occurrence exclusions.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ResolvedPersonalProductTarget } from './personalProductTargetResolver';
import {
  loadProductHistoryWithDb,
  selectAuthorizedPersonalProductHistoryRows,
  type ProductHistoryDatabase,
} from './productHistory';
import { buildProductDetailExcludedReceiptIds } from './productDetailOccurrenceExclusions';
import type { ReceiptRow } from './db';
import { applyOccurrenceRepresentativeUniverse } from './canonicalPurchaseOccurrence';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { loadPersonalProductDetailDataWithDb } from './productDetailPersonalLoader';

const DAY = 86_400_000;
const TX_A = Date.parse('2026-06-30T13:36:46+09:00');
const TX_B = Date.parse('2026-07-01T10:00:00+09:00');

type HistoryRow = {
  receiptId: string;
  itemId: string;
  sourceIndex: number;
  displayName: string;
  category: string | null;
  purchaseQuantity: number;
  lineTotal: number | null;
  currency: string | null;
  purchasedAt: number;
  merchantRaw: string | null;
  merchantNormalized: string | null;
  rawName: string | null;
  specSizeValue: number | null;
  specSizeUnit: string | null;
  specPackCount: number | null;
  volumeBaseMl: number | null;
  weightBaseG: number | null;
  countBase: number | null;
  specSourceText: string | null;
  receiptAnalysisJson: string;
  receiptUserItemsJson: string | null;
  receiptTotal: number;
  receiptTax: number;
  receiptTaxIsKnown: number;
  receiptFinalTotal: number | null;
  receiptUserEdited: number;
};

function trustedAnalysis(lineTotal: number): string {
  return JSON.stringify({
    merchant: 'Store',
    total: lineTotal,
    tax: 0,
    tax_is_known: true,
    currency: 'USD',
    is_grocery: true,
    merchant_type: 'supermarket',
    transactionDate: '2026-06-30 13:36:46',
    transaction_time_precision: 'second',
    items: [{ name: 'Personal Cola', quantity: 1, lineTotal }],
    reconciliation: { ok: true },
    amount_mismatch: false,
  });
}

function historyRow(
  receiptId: string,
  opts: {
    purchasedAt: number;
    quantity?: number;
    lineTotal?: number;
    currency?: string;
    merchant?: string;
    sourceIndex?: number;
  }
): HistoryRow {
  const lineTotal = opts.lineTotal ?? 10;
  return {
    receiptId,
    itemId: `${receiptId}:0`,
    sourceIndex: opts.sourceIndex ?? 0,
    displayName: 'Personal Cola',
    category: 'drinks',
    purchaseQuantity: opts.quantity ?? 1,
    lineTotal,
    currency: opts.currency ?? 'USD',
    purchasedAt: opts.purchasedAt,
    merchantRaw: opts.merchant ?? 'Store',
    merchantNormalized: opts.merchant ?? 'store',
    rawName: 'Personal Cola',
    specSizeValue: null,
    specSizeUnit: null,
    specPackCount: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    specSourceText: null,
    receiptAnalysisJson: trustedAnalysis(lineTotal),
    receiptUserItemsJson: null,
    receiptTotal: lineTotal,
    receiptTax: 0,
    receiptTaxIsKnown: 1,
    receiptFinalTotal: null,
    receiptUserEdited: 0,
  };
}

function resolvedFixture(input: {
  memberReceiptIds: string[];
  inventoryExcluded?: ReadonlySet<string>;
}): ResolvedPersonalProductTarget {
  const authorizedRowKeys = new Set(
    input.memberReceiptIds.map((id) => `${id}:0`)
  );
  const itemsByRowKey = new Map(
    input.memberReceiptIds.map((id) => [
      `${id}:0`,
      { merchantProductId: 'mp-cola' } as never,
    ])
  );
  return {
    requestedTarget: { type: 'personal_product', key: 'mp-cola' },
    canonicalTarget: { type: 'personal_product', key: 'mp-cola' },
    ownerKey: 'user:r6-owner',
    authority: {
      identityLevel: 'product_exact',
      sourceTier: 'personal_manual',
      authority: {
        kind: 'personal_product',
        anchorMerchantProductId: 'mp-cola',
        memberMerchantProductIds: ['mp-cola'],
      },
    },
    anchorMerchantProductId: 'mp-cola',
    memberMerchantProductIds: ['mp-cola'],
    authorizedRowKeys,
    inventory: {
      excludedDuplicateReceiptIds: input.inventoryExcluded ?? new Set<string>(),
      itemsByRowKey,
    } as never,
  } as ResolvedPersonalProductTarget;
}

function makeReceipt(
  id: string,
  opts: {
    createdAt: number;
    transactionAt: number;
    total?: number;
    items?: Array<{ name: string; quantity: number; lineTotal: number }>;
  }
): ReceiptRow {
  const items = opts.items ?? [
    { name: 'Personal Cola', quantity: 1, lineTotal: 10 },
  ];
  const total = opts.total ?? items.reduce((s, i) => s + i.lineTotal, 0);
  return {
    id,
    created_at: opts.createdAt,
    transaction_at: opts.transactionAt,
    transaction_time_precision: 'second',
    image_uri: '',
    merchant_raw: 'Store',
    merchant_normalized: 'store',
    merchant_type: 'supermarket',
    total,
    tax: 0,
    tax_is_known: 1,
    currency: 'USD',
    analysis_json: JSON.stringify({
      merchant: 'Store',
      total,
      tax: 0,
      tax_is_known: true,
      currency: 'USD',
      is_grocery: true,
      merchant_type: 'supermarket',
      transactionDate: '2026-06-30 13:36:46',
      transaction_time_precision: 'second',
      items,
      reconciliation: { ok: true },
      amount_mismatch: false,
    }),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  };
}

function historyDb(rows: HistoryRow[]): ProductHistoryDatabase {
  return {
    async getAllAsync(source) {
      if (/receipts\.user_id = \?/i.test(String(source))) {
        return rows as never;
      }
      return [] as never;
    },
    async getFirstAsync() {
      return null;
    },
  };
}

describe('R6 personal_product Product Detail exclusion union', () => {
  it('canonical-only duplicate: HC keeps both, occurrence excludes non-rep → count/qty/spend once', async () => {
    const receipts = [
      makeReceipt('rep-a', { createdAt: 1, transactionAt: TX_A, total: 10 }),
      makeReceipt('nonrep-b', { createdAt: 2, transactionAt: TX_A, total: 10 }),
    ];
    const selection = selectAnalyticsReceipts(receipts);
    expect(selection.analyticsReceipts.length).toBeGreaterThanOrEqual(1);
    const universe = applyOccurrenceRepresentativeUniverse(
      selection.analyticsReceipts,
      selection.excludedDuplicateReceiptIds
    );
    expect(universe.representativeReceipts).toHaveLength(1);
    const repId = universe.representativeReceipts[0]!.id;
    const nonRepId = repId === 'rep-a' ? 'nonrep-b' : 'rep-a';
    expect(universe.excludedReceiptIds.has(nonRepId)).toBe(true);

    const resolved = resolvedFixture({
      memberReceiptIds: ['rep-a', 'nonrep-b'],
      inventoryExcluded: selection.excludedDuplicateReceiptIds,
    });
    const rows = [
      historyRow('rep-a', { purchasedAt: TX_A, lineTotal: 10, currency: 'USD' }),
      historyRow('nonrep-b', {
        purchasedAt: TX_A,
        lineTotal: 10,
        currency: 'USD',
      }),
    ];

    const hcOnly = selectAuthorizedPersonalProductHistoryRows(resolved, rows as never);
    if (selection.excludedDuplicateReceiptIds.size === 0) {
      expect(hcOnly).toHaveLength(2);
    }

    const summary = await loadProductHistoryWithDb(
      historyDb(rows),
      { type: 'personal_product', key: 'mp-cola' },
      {
        personalProductContext: resolved,
        excludedReceiptIds: universe.excludedReceiptIds,
      }
    );

    expect(summary).not.toBeNull();
    expect(summary!.purchaseOccurrenceCount).toBe(1);
    expect(summary!.totalPurchaseQuantity).toBe(1);
    expect(summary!.totalSpend).toBe(10);
    expect(summary!.currency).toBe('USD');
    expect(summary!.firstPurchasedAt).toBe(TX_A);
    expect(summary!.lastPurchasedAt).toBe(TX_A);
    expect(summary!.merchantCount).toBe(1);
    expect(summary!.merchants).toHaveLength(1);
    expect(summary!.merchants[0]!.purchaseOccurrenceCount).toBe(1);
    expect(summary!.recentPurchases).toHaveLength(1);
    expect(summary!.recentPurchases[0]!.receiptId).toBe(repId);
    expect(summary!.recentPurchases.map((r) => r.receiptId)).not.toContain(
      nonRepId
    );
  });

  it('two genuine second-precision purchases remain count=2', async () => {
    const resolved = resolvedFixture({
      memberReceiptIds: ['buy-1', 'buy-2'],
      inventoryExcluded: new Set(),
    });
    const rows = [
      historyRow('buy-1', { purchasedAt: TX_A, lineTotal: 10 }),
      historyRow('buy-2', { purchasedAt: TX_B, lineTotal: 10 }),
    ];
    const summary = await loadProductHistoryWithDb(
      historyDb(rows),
      { type: 'personal_product', key: 'mp-cola' },
      {
        personalProductContext: resolved,
        excludedReceiptIds: new Set(),
      }
    );
    expect(summary).not.toBeNull();
    expect(summary!.purchaseOccurrenceCount).toBe(2);
    expect(summary!.totalPurchaseQuantity).toBe(2);
    expect(summary!.totalSpend).toBe(20);
    expect(summary!.currency).toBe('USD');
    expect(summary!.firstPurchasedAt).toBe(TX_A);
    expect(summary!.lastPurchasedAt).toBe(TX_B);
    expect(summary!.recentPurchases).toHaveLength(2);
  });

  it('>200 full-history: old canonical pair still excluded via Product Detail universe', async () => {
    const newest: ReceiptRow[] = [];
    for (let i = 0; i < 200; i += 1) {
      newest.push(
        makeReceipt(`filler-${i}`, {
          createdAt: 10_000_000 + i * DAY,
          transactionAt: 10_000_000 + i * DAY,
          total: 100 + i,
          items: [{ name: `Filler ${i}`, quantity: 1, lineTotal: 100 + i }],
        })
      );
    }
    const oldA = makeReceipt('old-pp-a', {
      createdAt: 1_000,
      transactionAt: TX_A,
      total: 10,
    });
    const oldB = makeReceipt('old-pp-b', {
      createdAt: 1_001,
      transactionAt: TX_A,
      total: 10,
    });
    const fullHistory = [...newest, oldA, oldB];

    const cappedExclusions = buildProductDetailExcludedReceiptIds(newest);
    expect(cappedExclusions.has('old-pp-a')).toBe(false);
    expect(cappedExclusions.has('old-pp-b')).toBe(false);

    const fullExclusions = buildProductDetailExcludedReceiptIds(fullHistory);
    const selection = selectAnalyticsReceipts(fullHistory);
    const universe = applyOccurrenceRepresentativeUniverse(
      selection.analyticsReceipts,
      selection.excludedDuplicateReceiptIds
    );
    const oldReps = universe.representativeReceipts.filter((r) =>
      r.id.startsWith('old-pp-')
    );
    expect(oldReps).toHaveLength(1);
    const nonRep =
      oldReps[0]!.id === 'old-pp-a' ? 'old-pp-b' : 'old-pp-a';
    expect(fullExclusions.has(nonRep)).toBe(true);

    const resolved = resolvedFixture({
      memberReceiptIds: ['old-pp-a', 'old-pp-b'],
      inventoryExcluded: new Set(),
    });
    const rows = [
      historyRow('old-pp-a', { purchasedAt: TX_A, lineTotal: 10 }),
      historyRow('old-pp-b', { purchasedAt: TX_A, lineTotal: 10 }),
    ];
    const summary = await loadProductHistoryWithDb(
      historyDb(rows),
      { type: 'personal_product', key: 'mp-cola' },
      {
        personalProductContext: resolved,
        excludedReceiptIds: fullExclusions,
      }
    );
    expect(summary).not.toBeNull();
    expect(summary!.purchaseOccurrenceCount).toBe(1);
    expect(summary!.totalPurchaseQuantity).toBe(1);
    expect(summary!.totalSpend).toBe(10);
    expect(summary!.recentPurchases).toHaveLength(1);
    expect(summary!.recentPurchases[0]!.receiptId).not.toBe(nonRep);
  });

  it('does not drop inventory HC exclusions when merging caller set', () => {
    const resolved = resolvedFixture({
      memberReceiptIds: ['keep', 'hc-drop', 'occ-drop'],
      inventoryExcluded: new Set(['hc-drop']),
    });
    const rows = [
      historyRow('keep', { purchasedAt: TX_A }),
      historyRow('hc-drop', { purchasedAt: TX_A }),
      historyRow('occ-drop', { purchasedAt: TX_A }),
    ];
    const selected = selectAuthorizedPersonalProductHistoryRows(
      resolved,
      rows as never,
      {
        excludedReceiptIds: new Set(['occ-drop']),
      }
    );
    expect(selected.map((r) => r.receiptId)).toEqual(['keep']);
  });

  it('personal Product Detail loader forwards excludedReceiptIds to history', async () => {
    const seen: Array<ReadonlySet<string> | undefined> = [];
    const resolved = resolvedFixture({
      memberReceiptIds: ['rep-a'],
      inventoryExcluded: new Set(),
    });
    const result = await loadPersonalProductDetailDataWithDb(
      'mp-cola',
      {
        locale: 'en',
        excludedReceiptIds: new Set(['nonrep-b']),
      },
      {
        getDatabase: async () => ({}) as never,
        resolveTarget: async () => ({ status: 'ready', resolved }),
        loadHistory: async (_db, _target, options) => {
          seen.push(options?.excludedReceiptIds);
          return {
            target: resolved.canonicalTarget,
            title: 'Personal Cola',
            purchaseOccurrenceCount: 1,
            totalPurchaseQuantity: 1,
            totalSpend: 10,
            currency: 'USD',
            currencyTotals: [{ currency: 'USD', totalSpend: 10 }],
            firstPurchasedAt: TX_A,
            lastPurchasedAt: TX_A,
            merchantCount: 1,
            canonicalProductCount: 0,
            skuCount: 0,
            specificationVariants: [],
            merchants: [],
            recentPurchases: [],
          };
        },
        loadPriceHistory: async (_db, _target, options) => {
          seen.push(options?.excludedReceiptIds);
          return {
            target: resolved.canonicalTarget,
            observations: [],
            series: [],
            status: 'ready',
          } as never;
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.has('nonrep-b')).toBe(true);
    expect(seen[1]!.has('nonrep-b')).toBe(true);
  });
});
