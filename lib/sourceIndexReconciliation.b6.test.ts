/**
 * B6 — persisted sourceIndex topology must not move discount truth onto the wrong item.
 *
 * Contiguous 0..N-1 is the writer contract and the successful reconciliation control.
 * Reordered or gapped sourceIndex values stay on the production fail-closed reasons.
 */

import { getReceiptItems } from './receiptItems';
import { itemAmountForAnalytics } from './receiptDiscountAllocation';
import {
  prepareConsumerReceiptMonetaryContext,
  projectTrustedConsumerItemAmounts,
  type ConsumerMonetaryRowFields,
} from './consumerItemMonetaryTruth';
import { enrichProductRowsWithCurrentItemMonetaryTruth } from './currentItemMonetaryTruth';
import { buildReceiptItemIndexRows } from './receiptItemIndex';

const ITEM_A = {
  name: 'B6りんごジュース',
  quantity: 1,
  lineTotal: 400,
  line_total: 400,
};
const ITEM_B = {
  name: 'B6ブレッド',
  quantity: 2,
  lineTotal: 250,
  line_total: 250,
};
const ITEM_C = {
  name: 'B6せっけん',
  quantity: 1,
  lineTotal: 180,
  line_total: 180,
};

const DISCOUNT_ON_B = {
  label: '**値引**',
  amount: -40,
  adjacentPrecedingItemIndex: 1,
};

const PAID_TOTAL = 790;

function analysisJson(): string {
  return JSON.stringify({
    merchant: 'B6-fixture',
    currency: 'JPY',
    items: [ITEM_A, ITEM_B, ITEM_C],
    discounts: [DISCOUNT_ON_B],
    tax: 0,
    tax_is_known: true,
    total: PAID_TOTAL,
    reconciliation: {
      ok: true,
      itemsPositiveSum: 830,
      discountsSum: -40,
      tax: 0,
      total: PAID_TOTAL,
      diff: 0,
    },
  });
}

function receiptShell() {
  return {
    id: 'b6-receipt',
    analysis_json: analysisJson(),
    user_items_json: null as string | null,
  };
}

function indexedRow(
  name: string,
  lineTotal: number,
  sourceIndex: number,
  purchaseQuantity: number
): ConsumerMonetaryRowFields {
  return {
    receiptId: 'b6-receipt',
    lineTotal,
    sourceIndex,
    currency: 'JPY',
    displayName: name,
    rawName: name,
    purchaseQuantity,
    receiptAnalysisJson: analysisJson(),
    receiptUserItemsJson: null,
    receiptTotal: PAID_TOTAL,
    receiptTax: 0,
    receiptTaxIsKnown: 1,
  };
}

function monetarySnapshot(
  rows: readonly {
    displayName?: string;
    sourceIndex: number;
    grossLineAmount?: number | null;
    discountAllocated?: number | null;
    effectiveLineAmount?: number | null;
  }[]
) {
  return rows.map((row) => ({
    name: row.displayName,
    sourceIndex: row.sourceIndex,
    gross: row.grossLineAmount,
    discount: row.discountAllocated,
    effective: row.effectiveLineAmount,
  }));
}

describe('B6 sourceIndex topology', () => {
  it('contiguous sourceIndex keeps the adjacent discount on B and reconciles', () => {
    const shell = receiptShell();
    const displayed = getReceiptItems(shell) as Record<string, unknown>[];
    expect(displayed.map((item) => item.name)).toEqual([
      ITEM_A.name,
      ITEM_B.name,
      ITEM_C.name,
    ]);
    expect(displayed[0].discountAllocated ?? 0).toBe(0);
    expect(displayed[1].discountAllocated).toBe(-40);
    expect(displayed[1].effectiveLineTotal).toBe(210);
    expect(displayed[2].discountAllocated ?? 0).toBe(0);
    expect(itemAmountForAnalytics(displayed[0])).toBe(400);
    expect(itemAmountForAnalytics(displayed[1])).toBe(210);
    expect(itemAmountForAnalytics(displayed[2])).toBe(180);

    const prepared = prepareConsumerReceiptMonetaryContext({
      lineTotal: 400,
      analysisJson: shell.analysis_json,
      receiptId: shell.id,
      receiptTotal: PAID_TOTAL,
      receiptTax: 0,
      receiptTaxIsKnown: 1,
      currency: 'JPY',
      sourceIndex: 0,
      displayName: ITEM_A.name,
      purchaseQuantity: 1,
    });
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') return;
    expect(prepared.bundle.coherent).toBe(true);
    expect(prepared.bundle.discountOwnershipStatus).not.toBe('unresolved');
    expect(prepared.bundle.items[1].discountAllocated).toBe(-40);
    expect(itemAmountForAnalytics(prepared.bundle.items[1])).toBe(210);
    expect(itemAmountForAnalytics(prepared.bundle.items[0])).toBe(400);
    expect(itemAmountForAnalytics(prepared.bundle.items[2])).toBe(180);

    const projected = projectTrustedConsumerItemAmounts([
      indexedRow(ITEM_A.name, 400, 0, 1),
      indexedRow(ITEM_B.name, 210, 1, 2),
      indexedRow(ITEM_C.name, 180, 2, 1),
    ]);
    expect(projected.map((row) => row.monetaryTrusted)).toEqual([
      true,
      true,
      true,
    ]);
    expect(projected.map((row) => row.monetaryTrustReason)).toEqual([
      'trusted_product_spend',
      'trusted_product_spend',
      'trusted_product_spend',
    ]);
    expect(projected.map((row) => row.lineTotal)).toEqual([400, 210, 180]);
    expect(projected[1].displayName).toBe(ITEM_B.name);
  });

  it('reordered sourceIndex fail-closes instead of moving B’s discount', () => {
    const projected = projectTrustedConsumerItemAmounts([
      indexedRow(ITEM_A.name, 400, 2, 1),
      indexedRow(ITEM_B.name, 210, 0, 2),
      indexedRow(ITEM_C.name, 180, 1, 1),
    ]);

    expect(projected.map((row) => row.monetaryTrusted)).toEqual([
      false,
      false,
      false,
    ]);
    expect(projected.map((row) => row.monetaryTrustReason)).toEqual([
      'item_correspondence_mismatch',
      'item_correspondence_mismatch',
      'item_correspondence_mismatch',
    ]);
    expect(projected.map((row) => row.lineTotal)).toEqual([null, null, null]);
    expect(projected.map((row) => row.displayName)).toEqual([
      ITEM_A.name,
      ITEM_B.name,
      ITEM_C.name,
    ]);
  });

  it('gapped sourceIndex fail-closes the rows that no longer match', () => {
    const projected = projectTrustedConsumerItemAmounts([
      indexedRow(ITEM_A.name, 400, 0, 1),
      indexedRow(ITEM_B.name, 210, 2, 2),
      indexedRow(ITEM_C.name, 180, 3, 1),
    ]);

    expect(projected[0]).toMatchObject({
      displayName: ITEM_A.name,
      lineTotal: 400,
      monetaryTrusted: true,
      monetaryTrustReason: 'trusted_product_spend',
    });
    expect(projected[1]).toMatchObject({
      displayName: ITEM_B.name,
      lineTotal: null,
      monetaryTrusted: false,
      monetaryTrustReason: 'item_correspondence_mismatch',
    });
    expect(projected[2]).toMatchObject({
      displayName: ITEM_C.name,
      lineTotal: null,
      monetaryTrusted: false,
      monetaryTrustReason: 'source_index_invalid',
    });
    expect(projected.map((row) => row.lineTotal)).not.toContain(210);
  });

  it('does not copy another item’s discount through a reordered sourceIndex', () => {
    const shell = receiptShell();
    const rows = [
      {
        receiptId: shell.id,
        sourceIndex: 2,
        displayName: ITEM_A.name,
        grossLineAmount: 400,
        effectiveLineAmount: 400,
        discountAllocated: 0,
        lineTotal: 400,
        receiptAnalysisJson: shell.analysis_json,
        receiptUserItemsJson: null,
      },
      {
        receiptId: shell.id,
        sourceIndex: 0,
        displayName: ITEM_B.name,
        grossLineAmount: 250,
        effectiveLineAmount: 210,
        discountAllocated: -40,
        lineTotal: 210,
        receiptAnalysisJson: shell.analysis_json,
        receiptUserItemsJson: null,
      },
      {
        receiptId: shell.id,
        sourceIndex: 1,
        displayName: ITEM_C.name,
        grossLineAmount: 180,
        effectiveLineAmount: 180,
        discountAllocated: 0,
        lineTotal: 180,
        receiptAnalysisJson: shell.analysis_json,
        receiptUserItemsJson: null,
      },
    ];

    const enriched = enrichProductRowsWithCurrentItemMonetaryTruth(rows);
    expect(monetarySnapshot(enriched)).toEqual([
      { name: ITEM_A.name, sourceIndex: 2, gross: 400, discount: 0, effective: 400 },
      { name: ITEM_B.name, sourceIndex: 0, gross: 250, discount: -40, effective: 210 },
      { name: ITEM_C.name, sourceIndex: 1, gross: 180, discount: 0, effective: 180 },
    ]);
  });

  it('does not copy another item’s discount through a gapped sourceIndex', () => {
    const shell = receiptShell();
    const rows = [
      {
        receiptId: shell.id,
        sourceIndex: 0,
        displayName: ITEM_A.name,
        grossLineAmount: 400,
        effectiveLineAmount: 400,
        discountAllocated: 0,
        lineTotal: 400,
        receiptAnalysisJson: shell.analysis_json,
        receiptUserItemsJson: null,
      },
      {
        receiptId: shell.id,
        sourceIndex: 2,
        displayName: ITEM_B.name,
        grossLineAmount: 250,
        effectiveLineAmount: 210,
        discountAllocated: -40,
        lineTotal: 210,
        receiptAnalysisJson: shell.analysis_json,
        receiptUserItemsJson: null,
      },
      {
        receiptId: shell.id,
        sourceIndex: 3,
        displayName: ITEM_C.name,
        grossLineAmount: 180,
        effectiveLineAmount: 180,
        discountAllocated: 0,
        lineTotal: 180,
        receiptAnalysisJson: shell.analysis_json,
        receiptUserItemsJson: null,
      },
    ];

    const enriched = enrichProductRowsWithCurrentItemMonetaryTruth(rows);
    expect(monetarySnapshot(enriched)).toEqual([
      { name: ITEM_A.name, sourceIndex: 0, gross: 400, discount: 0, effective: 400 },
      { name: ITEM_B.name, sourceIndex: 2, gross: 250, discount: -40, effective: 210 },
      { name: ITEM_C.name, sourceIndex: 3, gross: 180, discount: 0, effective: 180 },
    ]);
  });

  it('duplicate sourceIndex 0/1/1 keeps each row and does not move B’s discount', () => {
    const shell = receiptShell();
    const rowA = {
      itemId: 'row-A',
      receiptId: shell.id,
      sourceIndex: 0,
      displayName: ITEM_A.name,
      purchaseQuantity: 1,
      grossLineAmount: 400,
      effectiveLineAmount: 400,
      discountAllocated: 0,
      lineTotal: 400,
      receiptAnalysisJson: shell.analysis_json,
      receiptUserItemsJson: null,
    };
    const rowB = {
      itemId: 'row-B',
      receiptId: shell.id,
      sourceIndex: 1,
      displayName: ITEM_B.name,
      purchaseQuantity: 2,
      grossLineAmount: 250,
      effectiveLineAmount: 250,
      discountAllocated: 0,
      lineTotal: 250,
      receiptAnalysisJson: shell.analysis_json,
      receiptUserItemsJson: null,
    };
    const rowC = {
      itemId: 'row-C',
      receiptId: shell.id,
      sourceIndex: 1,
      displayName: ITEM_C.name,
      purchaseQuantity: 1,
      grossLineAmount: 180,
      effectiveLineAmount: 180,
      discountAllocated: 0,
      lineTotal: 180,
      receiptAnalysisJson: shell.analysis_json,
      receiptUserItemsJson: null,
    };
    const input = [rowA, rowB, rowC];
    const enriched = enrichProductRowsWithCurrentItemMonetaryTruth(input);

    expect(enriched).toHaveLength(3);
    expect(enriched.map((row) => row.itemId)).toEqual(['row-A', 'row-B', 'row-C']);
    expect(enriched[0]).toBe(rowA);
    expect(enriched[1]).not.toBe(rowC);
    expect(enriched[2]).toBe(rowC);
    expect(enriched[1]).toMatchObject({
      itemId: 'row-B',
      displayName: ITEM_B.name,
      grossLineAmount: 250,
      discountAllocated: -40,
      effectiveLineAmount: 210,
    });
    expect(enriched[2]).toMatchObject({
      itemId: 'row-C',
      displayName: ITEM_C.name,
      grossLineAmount: 180,
      discountAllocated: 0,
      effectiveLineAmount: 180,
    });
    expect(input[1]).toMatchObject({ discountAllocated: 0, effectiveLineAmount: 250 });
  });

  it('new index writes ignore stale sourceIndex and stay contiguous', () => {
    const rows = buildReceiptItemIndexRows({
      id: 'b6-write',
      analysis_json: JSON.stringify({
        items: [
          { ...ITEM_A, sourceIndex: 2, source_index: 9, review_source_index: 7 },
          { ...ITEM_B, sourceIndex: 0, source_index: 4 },
          { ...ITEM_C, sourceIndex: 1, source_index: 3 },
        ],
      }),
      user_items_json: null,
    });

    expect(rows.map((row) => row.source_index)).toEqual([0, 1, 2]);
    expect(rows.map((row) => row.normalized_name)).toEqual([
      ITEM_A.name.toLowerCase(),
      ITEM_B.name.toLowerCase(),
      ITEM_C.name.toLowerCase(),
    ]);
    expect(rows[0].review_source_index).toBe(7);
    expect(rows.map((row) => row.id)).toEqual([
      'b6-write:0',
      'b6-write:1',
      'b6-write:2',
    ]);
  });
});
