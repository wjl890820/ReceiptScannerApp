/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import { getReceiptItems } from './receiptItems';
import {
  applyCurrentItemMonetaryTruthToAnalysisItems,
  enrichProductRowsWithCurrentItemMonetaryTruth,
  resolveCurrentAnalysisItemMonetaryTruth,
} from './currentItemMonetaryTruth';
import { buildProductPriceHistory } from './productPriceHistory';
import type {
  ProductPriceHistoryRow,
  ReceiptEvidenceCache,
} from './productPriceHistory';
import { interpretProductPriceChange } from './productPriceChangeInterpretation';
import { resolveProductPriceChangePresentation } from './productPricePresentation';
import { buildExperimentSnapshot } from './experimentSnapshotExport';
import type { ReceiptRow } from './db';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import type { ReceiptAmountBasisAssessment } from './analysisFoundation/types';
import type { ReceiptMonetaryCoherenceEvidence } from './receiptEvidenceTruth/types';

function trustedCacheForRows(
  rows: readonly ProductPriceHistoryRow[]
): ReceiptEvidenceCache {
  const cache: ReceiptEvidenceCache = new Map();
  for (const row of rows) {
    if (cache.has(row.receiptId)) continue;
    const amountBasisAssessment: ReceiptAmountBasisAssessment = {
      receiptId: row.receiptId,
      basis: 'tax_included',
      receiptTotal: 0,
      receiptTax: 0,
      analyticsItemSum: 0,
      unallocatedDiscountTotal: 0,
      expectedTotalIfTaxIncluded: null,
      expectedTotalIfTaxExcluded: null,
      confidence: 'high',
      taxProvenance: 'trusted',
      exactComparisonTrusted: true,
      evidence: [],
      reasonCodes: [],
    };
    const monetaryCoherenceEvidence: ReceiptMonetaryCoherenceEvidence = {
      receiptId: row.receiptId,
      state: 'known_coherent',
      authoritativeLayer: 'ocr',
      discountOwnershipStatus: 'resolved',
      monetaryProvenanceSufficient: true,
      closureHypothesis: null,
      evidence: [],
      reasonCodes: [],
    };
    cache.set(row.receiptId, {
      amountBasisAssessment,
      monetaryCoherenceEvidence,
    });
  }
  return cache;
}

function analysisJson(input: {
  items: Array<Record<string, unknown>>;
  discounts?: Array<Record<string, unknown>>;
  total?: number;
  tax?: number;
}): string {
  return JSON.stringify({
    merchant: 'セブン-イレブン',
    currency: 'JPY',
    total: input.total ?? 1262,
    tax: input.tax ?? 93,
    tax_is_known: true,
    items: input.items,
    discounts: input.discounts ?? [],
    reconciliation: {
      ok: true,
      itemsPositiveSum: input.items.reduce(
        (s, it) => s + Number(it.lineTotal ?? 0),
        0
      ),
      discountsSum: (input.discounts ?? []).reduce(
        (s, d) => s + Number(d.amount ?? 0),
        0
      ),
      tax: input.tax ?? 93,
      total: input.total ?? 1262,
      diff: 0,
    },
  });
}

function legacySandwichAnalysis(allocated: boolean): string {
  return analysisJson({
    items: [
      {
        name: 'チキンカツサンド',
        quantity: 1,
        lineTotal: 390,
        line_total: 390,
        effectiveLineTotal: allocated ? 340 : 390,
        discountAllocated: allocated ? -50 : 0,
      },
      {
        name: 'サントリークラフトボスチャイラテ600ml',
        quantity: 1,
        lineTotal: 159,
        effectiveLineTotal: 159,
        discountAllocated: 0,
      },
      {
        name: '7Pひとくちクレープチョコ',
        quantity: 1,
        lineTotal: 178,
        effectiveLineTotal: 178,
        discountAllocated: 0,
      },
      {
        name: '和クレープ おもちきなこ',
        quantity: 1,
        lineTotal: 260,
        effectiveLineTotal: 260,
        discountAllocated: 0,
      },
      {
        name: 'ななチキ',
        quantity: 1,
        lineTotal: 232,
        effectiveLineTotal: 232,
        discountAllocated: 0,
      },
    ],
    discounts: [
      {
        label: '**値引**',
        amount: -50,
        adjacentPrecedingItemIndex: 0,
      },
    ],
  });
}

function makeRow(
  partial: Partial<ProductPriceHistoryRow> &
    Pick<ProductPriceHistoryRow, 'receiptId' | 'sourceIndex' | 'displayName'>
): ProductPriceHistoryRow {
  return {
    itemId: `${partial.receiptId}:${partial.sourceIndex}`,
    occurredAt: partial.occurredAt ?? 1_000,
    merchantRaw: 'セブン-イレブン',
    merchantNormalized: 'セブン-イレブン',
    currency: 'JPY',
    lineTotal: partial.grossLineAmount ?? 390,
    purchaseQuantity: 1,
    productFamilyKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    skuKey: 'sku-sandwich',
    grossLineAmount: 390,
    effectiveLineAmount: 390,
    discountAllocated: 0,
    amountProvenance: 'ocr_observed',
    itemAmountEvidenceState: 'coherent',
    evidenceCaptureVersion: 1,
    priceObservationVersion: 1,
    receiptAnalysisJson: legacySandwichAnalysis(false),
    receiptUserItemsJson: null,
    receiptUserEdited: 1,
    receiptTotal: 1262,
    receiptTax: 93,
    receiptTaxIsKnown: 1,
    receiptCurrency: 'JPY',
    ...partial,
  };
}

describe('Legacy adjacent discount recovery (Receipt 051)', () => {
  it('CASE A — legacy 390/390/0 + adjacent -50 → 390/340/-50', () => {
    const aj = legacySandwichAnalysis(false);
    const items = getReceiptItems({
      analysis_json: aj,
      user_items_json: null,
    }) as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      lineTotal: 390,
      discountAllocated: -50,
      effectiveLineTotal: 340,
    });
    const resolved = resolveCurrentAnalysisItemMonetaryTruth(aj);
    expect(resolved.recovered).toBe(true);
    expect(resolved.ownershipStatus).toBe('reallocated_with_evidence');
  });

  it('CASE B — already-correct item does not double-apply', () => {
    const aj = legacySandwichAnalysis(true);
    const items = getReceiptItems({
      analysis_json: aj,
      user_items_json: null,
    }) as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      lineTotal: 390,
      discountAllocated: -50,
      effectiveLineTotal: 340,
    });
    const again = applyCurrentItemMonetaryTruthToAnalysisItems(aj, items);
    expect(again[0]).toMatchObject({
      discountAllocated: -50,
      effectiveLineTotal: 340,
    });
  });

  it('CASE C — ambiguous receipt-level coupon stays unbound', () => {
    const aj = analysisJson({
      items: [
        {
          name: 'SNACK A',
          lineTotal: 1128,
          effectiveLineTotal: 1128,
          discountAllocated: 0,
        },
        {
          name: 'SNACK B',
          lineTotal: 1128,
          effectiveLineTotal: 1128,
          discountAllocated: 0,
        },
      ],
      discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
      total: 1656,
      tax: 0,
    });
    const items = getReceiptItems({
      analysis_json: aj,
      user_items_json: null,
    }) as Array<Record<string, unknown>>;
    expect(items[0]?.discountAllocated ?? 0).toBe(0);
    expect(items[1]?.discountAllocated ?? 0).toBe(0);
  });

  it('CASE D — invalid adjacency fail-close', () => {
    const aj = analysisJson({
      items: [
        {
          name: 'チキンカツサンド',
          lineTotal: 390,
          effectiveLineTotal: 390,
          discountAllocated: 0,
        },
      ],
      discounts: [
        {
          label: '**値引**',
          amount: -50,
          adjacentPrecedingItemIndex: 9,
        },
      ],
    });
    const items = getReceiptItems({
      analysis_json: aj,
      user_items_json: null,
    }) as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      discountAllocated: 0,
      effectiveLineTotal: 390,
    });
  });

  it('CASE E — discount magnitude invalid for target item fail-close', () => {
    const aj = analysisJson({
      items: [
        {
          name: 'チキンカツサンド',
          lineTotal: 40,
          effectiveLineTotal: 40,
          discountAllocated: 0,
        },
      ],
      discounts: [
        {
          label: '**値引**',
          amount: -50,
          adjacentPrecedingItemIndex: 0,
        },
      ],
    });
    const items = getReceiptItems({
      analysis_json: aj,
      user_items_json: null,
    }) as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      discountAllocated: 0,
      effectiveLineTotal: 40,
    });
  });

  it('CASE F — multiple deterministic adjacent discounts each bind once', () => {
    const aj = analysisJson({
      items: [
        {
          name: '鶏肉A',
          lineTotal: 372,
          effectiveLineTotal: 372,
          discountAllocated: 0,
        },
        {
          name: '鶏肉B',
          lineTotal: 378,
          effectiveLineTotal: 378,
          discountAllocated: 0,
        },
      ],
      discounts: [
        {
          label: '割引 10%',
          amount: -38,
          adjacentPrecedingItemIndex: 0,
        },
        {
          label: '割引 10%',
          amount: -38,
          adjacentPrecedingItemIndex: 1,
        },
      ],
      total: 674,
      tax: 0,
    });
    const items = getReceiptItems({
      analysis_json: aj,
      user_items_json: null,
    }) as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      discountAllocated: -38,
      effectiveLineTotal: 334,
    });
    expect(items[1]).toMatchObject({
      discountAllocated: -38,
      effectiveLineTotal: 340,
    });
  });

  it('CASE G — PPH gross stays 390; auxiliary effective/discount recovered', () => {
    const rows = [
      makeRow({
        receiptId: 'r-050',
        sourceIndex: 0,
        displayName: 'チキンカツサンド',
        occurredAt: 1,
        grossLineAmount: 390,
        effectiveLineAmount: 390,
        discountAllocated: 0,
        receiptAnalysisJson: analysisJson({
          items: [
            {
              name: 'チキンカツサンド',
              lineTotal: 390,
              effectiveLineTotal: 390,
              discountAllocated: 0,
            },
          ],
          discounts: [],
          total: 390,
          tax: 0,
        }),
      }),
      makeRow({
        receiptId: 'Jrmoz8sIT4KNv1W4TuUgv',
        sourceIndex: 0,
        displayName: 'チキンカツサンド',
        occurredAt: 2,
        grossLineAmount: 390,
        effectiveLineAmount: 390,
        discountAllocated: 0,
        receiptAnalysisJson: legacySandwichAnalysis(false),
      }),
    ];
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'sku-sandwich' },
      rows.map((row) => ({ ...row, skuKey: 'sku-sandwich' })),
      {
        canonicalDuplicateSelectionApplied: true,
        receiptEvidenceCache: trustedCacheForRows(rows),
      }
    );
    expect(history.points).toHaveLength(2);
    expect(history.points[0]!.priceValue).toBe(390);
    expect(history.points[1]!.priceValue).toBe(390);
    expect(history.points[1]!.grossLineAmount).toBe(390);
    expect(history.points[1]!.effectiveLineAmount).toBe(340);
    expect(history.points[1]!.discountAllocated).toBe(-50);
    expect(history.points[1]!.promoContext).toBe('explicit_discount');
  });

  it('CASE H — interpretation sees promo without fabricating gross drop', () => {
    const rows = [
      makeRow({
        receiptId: 'r-050',
        sourceIndex: 0,
        displayName: 'チキンカツサンド',
        occurredAt: 1,
        grossLineAmount: 390,
        effectiveLineAmount: 390,
        discountAllocated: 0,
        receiptAnalysisJson: analysisJson({
          items: [
            {
              name: 'チキンカツサンド',
              lineTotal: 390,
              effectiveLineTotal: 390,
              discountAllocated: 0,
            },
          ],
          discounts: [],
          total: 390,
          tax: 0,
        }),
      }),
      makeRow({
        receiptId: 'Jrmoz8sIT4KNv1W4TuUgv',
        sourceIndex: 0,
        displayName: 'チキンカツサンド',
        occurredAt: 2,
        receiptAnalysisJson: legacySandwichAnalysis(false),
      }),
    ];
    const built = buildProductPriceHistory(
      { type: 'sku', key: 'sku-sandwich' },
      rows.map((row) => ({ ...row, skuKey: 'sku-sandwich' })),
      {
        canonicalDuplicateSelectionApplied: true,
        receiptEvidenceCache: trustedCacheForRows(rows),
      }
    );
    const history = {
      ...built,
      status: 'ready' as const,
      points: built.points.map((point) => ({
        ...point,
        skuKey: 'sku-sandwich',
        qualityLevel: 'trusted' as const,
      })),
      comparableOccurrenceCount: 2,
    };
    expect(history.points).toHaveLength(2);
    const interpretation = interpretProductPriceChange({
      history,
      targetType: 'sku',
      targetKey: 'sku-sandwich',
    });
    expect(interpretation.status).toBe('available');
    if (interpretation.status !== 'available') return;
    expect(interpretation.grossDelta).toBe(0);
    expect(interpretation.grossDirection).toBe('unchanged');
    expect(interpretation.current.discountAllocated).toBe(-50);
    expect(interpretation.current.effectiveLineAmount).toBe(340);
    expect(
      interpretation.current.promoState === 'explicit_discount' ||
        interpretation.current.promoState === 'explicit_discount_and_marker'
    ).toBe(true);
    const presentation = resolveProductPriceChangePresentation(interpretation);
    expect(presentation.change?.key).toBe('priceHistory.change.unchanged');
    expect(presentation.promo?.key).toBe('priceHistory.promo.started');
  });

  it('CASE I — Experiment Snapshot receiptItems uses same recovered truth', () => {
    const row = makeRow({
      receiptId: 'Jrmoz8sIT4KNv1W4TuUgv',
      sourceIndex: 0,
      displayName: 'チキンカツサンド',
      receiptAnalysisJson: legacySandwichAnalysis(false),
    });
    const receipt = {
      id: 'Jrmoz8sIT4KNv1W4TuUgv',
      created_at: 1,
      transaction_at: 1,
      image_uri: 'x',
      merchant_raw: 'セブン-イレブン',
      merchant_normalized: 'セブン-イレブン',
      total: 1262,
      tax: 93,
      currency: 'JPY',
      analysis_json: legacySandwichAnalysis(false),
      source: 'self',
      user_edited: 1,
      user_items_json: null,
      tax_is_known: 1,
      transaction_source: 'receipt_ocr',
    } as ReceiptRow;
    const snapshot = buildExperimentSnapshot({
      experiment: {
        phase: 2,
        completedReceiptSequence: 1,
      },
      storedReceipts: [receipt],
      productRows: [row],
      nowMs: 1,
    });
    const item = snapshot.receiptItems.find(
      (entry) => entry.receiptId === 'Jrmoz8sIT4KNv1W4TuUgv'
    );
    expect(item).toMatchObject({
      grossLineAmount: 390,
      effectiveLineAmount: 340,
      discountAllocated: -50,
    });
  });

  it('CASE J — fresh normalize output remains unchanged through recovery', () => {
    const fresh = normalizeOcrAnalysis({
      merchant: 'セブン-イレブン',
      currency: 'JPY',
      total: 1262,
      tax: 93,
      items: [
        { name: 'チキンカツサンド', quantity: 1, unitPrice: 390, lineTotal: 390 },
        {
          name: 'サントリークラフトボスチャイラテ600ml',
          quantity: 1,
          unitPrice: 159,
          lineTotal: 159,
        },
        {
          name: '7Pひとくちクレープチョコ',
          quantity: 1,
          unitPrice: 178,
          lineTotal: 178,
        },
        {
          name: '和クレープ おもちきなこ',
          quantity: 1,
          unitPrice: 260,
          lineTotal: 260,
        },
        { name: 'ななチキ', quantity: 1, unitPrice: 232, lineTotal: 232 },
      ],
      discounts: [
        {
          label: '**値引**',
          amount: -50,
          adjacentPrecedingItemIndex: 0,
        },
      ],
    } as any);
    expect(fresh.items[0]).toMatchObject({
      discountAllocated: -50,
      effectiveLineTotal: 340,
    });
    const throughGet = getReceiptItems({
      analysis_json: JSON.stringify(fresh),
      user_items_json: null,
    }) as Array<Record<string, unknown>>;
    expect(throughGet[0]).toMatchObject({
      discountAllocated: -50,
      effectiveLineTotal: 340,
    });
  });

  it('indexed stale rows are observationally overridden without DB writes', () => {
    const enriched = enrichProductRowsWithCurrentItemMonetaryTruth([
      makeRow({
        receiptId: 'Jrmoz8sIT4KNv1W4TuUgv',
        sourceIndex: 0,
        displayName: 'チキンカツサンド',
        grossLineAmount: 390,
        effectiveLineAmount: 390,
        discountAllocated: 0,
        receiptAnalysisJson: legacySandwichAnalysis(false),
      }),
    ]);
    expect(enriched[0]).toMatchObject({
      grossLineAmount: 390,
      effectiveLineAmount: 340,
      discountAllocated: -50,
    });
  });

  it('user_items authority skips analysis discount recovery', () => {
    const items = getReceiptItems({
      analysis_json: legacySandwichAnalysis(false),
      user_items_json: JSON.stringify([
        {
          name: 'チキンカツサンド',
          lineTotal: 390,
          effectiveLineTotal: 390,
          discountAllocated: 0,
        },
      ]),
    }) as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      discountAllocated: 0,
      effectiveLineTotal: 390,
    });
  });
});
