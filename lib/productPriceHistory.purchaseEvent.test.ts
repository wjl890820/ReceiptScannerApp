/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import { buildPurchaseEventDatesFromRows } from './repeatProductProfile';
import { interpretProductPriceChange } from './productPriceChangeInterpretation';
import {
  buildProductPriceHistory,
  countDistinctPurchaseEventOccurrences,
  reconcilePurchaseEventPromoContext,
  reconcilePurchaseEventPromoMarkers,
  reconcilePurchaseEventQualityLevel,
  type ProductPriceHistoryRow,
  type ReceiptEvidenceCache,
} from './productPriceHistory';
import type { ReceiptAmountBasisAssessment } from './analysisFoundation/types';
import type { ReceiptMonetaryCoherenceEvidence } from './receiptEvidenceTruth/types';

function trustedEvidenceEntry(
  receiptId: string
): ReceiptEvidenceCache {
  const amountBasisAssessment: ReceiptAmountBasisAssessment = {
    receiptId,
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
    receiptId,
    state: 'known_coherent',
    authoritativeLayer: 'ocr',
    discountOwnershipStatus: 'resolved',
    monetaryProvenanceSufficient: true,
    closureHypothesis: null,
    evidence: [],
    reasonCodes: [],
  };
  return new Map([[receiptId, { amountBasisAssessment, monetaryCoherenceEvidence }]]);
}

function buildTrustedCache(
  rows: readonly ProductPriceHistoryRow[]
): ReceiptEvidenceCache {
  const cache: ReceiptEvidenceCache = new Map();
  for (const row of rows) {
    if (cache.has(row.receiptId)) continue;
    const entry = trustedEvidenceEntry(row.receiptId);
    cache.set(row.receiptId, entry.get(row.receiptId)!);
  }
  return cache;
}

function trustedSameReceiptRows(input: {
  receiptId: string;
  occurredAt: number;
  lines: Array<{
    sourceIndex: number;
    gross: number;
    quantity?: number;
    displayName?: string;
    effective?: number | null;
    discountAllocated?: number | null;
    /** null/undefined → absent markers (none_observed path when discount absent/0). */
    promoMarkers?: string[] | null;
  }>;
}): ProductPriceHistoryRow[] {
  const { receiptId, occurredAt, lines } = input;
  const sumGross = lines.reduce((sum, line) => sum + line.gross, 0);
  const analysisItems = lines.map((line) => ({
    name: line.displayName ?? '商品',
    lineTotal: line.gross,
    quantity: line.quantity ?? 1,
  }));
  return lines.map((line) => {
    const qty = line.quantity ?? 1;
    const effective =
      line.effective === undefined ? line.gross : line.effective;
    const promoMarkersJson =
      line.promoMarkers == null
        ? null
        : JSON.stringify(line.promoMarkers);
    return {
      receiptId,
      itemId: `${receiptId}:${line.sourceIndex}`,
      sourceIndex: line.sourceIndex,
      occurredAt,
      merchantRaw: 'Store',
      merchantNormalized: 'store',
      displayName: line.displayName ?? '商品',
      currency: 'JPY',
      lineTotal: line.gross,
      purchaseQuantity: qty,
      productFamilyKey: null,
      volumeBaseMl: null,
      weightBaseG: null,
      countBase: null,
      grossLineAmount: line.gross,
      effectiveLineAmount: effective,
      discountAllocated:
        line.discountAllocated === undefined ? null : line.discountAllocated,
      promoMarkersJson,
      priceObservationVersion: 1,
      itemAmountEvidenceState: 'coherent' as const,
      amountProvenance: 'ocr_observed' as const,
      evidenceCaptureVersion: 1,
      receiptAnalysisJson: JSON.stringify({
        items: analysisItems,
        evidenceCaptureVersion: 1,
        reconciliation: { ok: true },
        amount_mismatch: false,
      }),
      receiptTaxIsKnown: 1,
      receiptTotal: sumGross,
      receiptTax: 8,
      receiptCurrency: 'JPY',
    } satisfies ProductPriceHistoryRow;
  });
}

function buildSkuHistory(
  rows: ProductPriceHistoryRow[],
  options?: { preserveQuality?: boolean }
) {
  const result = buildProductPriceHistory(
    { type: 'sku', key: 'sku-proglide' },
    rows,
    {
      receiptEvidenceCache: buildTrustedCache(rows),
      canonicalDuplicateSelectionApplied: true,
    }
  );
  return {
    ...result,
    points: result.points.map((point) => ({
      ...point,
      skuKey: 'sku-proglide',
      ...(options?.preserveQuality
        ? {}
        : { qualityLevel: 'trusted' as const }),
    })),
  };
}

function semanticSnapshot(
  point: {
    priceValue: number;
    purchaseQuantity: number;
    grossLineAmount: number;
    effectiveLineAmount?: number | null;
    discountAllocated?: number | null;
    promoContext?: string;
    promoMarkers?: string[];
    qualityLevel?: string | null;
  },
  status: string
) {
  return {
    priceValue: point.priceValue,
    purchaseQuantity: point.purchaseQuantity,
    grossLineAmount: point.grossLineAmount,
    effectiveLineAmount: point.effectiveLineAmount ?? null,
    discountAllocated: point.discountAllocated ?? null,
    promoContext: point.promoContext,
    promoMarkers: [...(point.promoMarkers ?? [])],
    qualityLevel: point.qualityLevel,
    status,
  };
}

describe('PPH purchase-event aggregation (Receipt 046 repair)', () => {
  it('CASE A — first purchase with two identical same-receipt rows → not_enough_points', () => {
    const rows = trustedSameReceiptRows({
      receiptId: '9nJQ6-RfRER3mjQKXwYOI',
      occurredAt: 1775352414000,
      lines: [
        { sourceIndex: 5, gross: 4780, displayName: 'proglide 12b' },
        { sourceIndex: 6, gross: 4780, displayName: 'proglide 12b' },
      ],
    });
    const result = buildSkuHistory(rows);
    expect(countDistinctPurchaseEventOccurrences(rows)).toBe(1);
    expect(result.totalOccurrenceCount).toBe(1);
    expect(result.comparableOccurrenceCount).toBe(1);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]!.purchaseQuantity).toBe(2);
    expect(result.points[0]!.grossLineAmount).toBe(9560);
    expect(result.points[0]!.priceValue).toBe(4780);
    expect(result.points[0]!.sourceIndex).toBe(5);
    expect(result.status).toBe('not_enough_points');
    expect(result.observations).toHaveLength(2);
  });

  it('CASE B — same-receipt two rows + later second receipt → ready with 2 event points', () => {
    const first = trustedSameReceiptRows({
      receiptId: 'r-first',
      occurredAt: 1_000,
      lines: [
        { sourceIndex: 0, gross: 4780 },
        { sourceIndex: 1, gross: 4780 },
      ],
    });
    const second = trustedSameReceiptRows({
      receiptId: 'r-second',
      occurredAt: 2_000,
      lines: [{ sourceIndex: 0, gross: 4980 }],
    });
    const rows = [...first, ...second];
    const result = buildSkuHistory(rows);
    expect(result.totalOccurrenceCount).toBe(2);
    expect(result.comparableOccurrenceCount).toBe(2);
    expect(result.points).toHaveLength(2);
    expect(result.status).toBe('ready');
    expect(result.points.map((p) => p.receiptId)).toEqual([
      'r-first',
      'r-second',
    ]);
    expect(result.points[0]!.purchaseQuantity).toBe(2);
    expect(result.points[0]!.priceValue).toBe(4780);
    expect(result.points[1]!.purchaseQuantity).toBe(1);
    expect(result.points[1]!.priceValue).toBe(4980);
    expect(result.observations).toHaveLength(3);
  });

  it('CASE C — quantity aggregation yields correct per-unit comparable price', () => {
    const rows = trustedSameReceiptRows({
      receiptId: 'r-qty',
      occurredAt: 3_000,
      lines: [
        { sourceIndex: 0, gross: 600, quantity: 2 },
        { sourceIndex: 1, gross: 300, quantity: 1 },
      ],
    });
    const result = buildSkuHistory(rows);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]!.purchaseQuantity).toBe(3);
    expect(result.points[0]!.grossLineAmount).toBe(900);
    expect(result.points[0]!.priceValue).toBe(300);
    expect(result.status).toBe('not_enough_points');
  });

  it('CASE D — incompatible same-receipt unit prices fail-close comparable event', () => {
    const rows = trustedSameReceiptRows({
      receiptId: 'r-split',
      occurredAt: 4_000,
      lines: [
        { sourceIndex: 0, gross: 400 },
        { sourceIndex: 1, gross: 460 },
      ],
    });
    const result = buildSkuHistory(rows);
    expect(result.totalOccurrenceCount).toBe(1);
    expect(result.comparableOccurrenceCount).toBe(0);
    expect(result.points).toHaveLength(0);
    expect(result.status).toBe('not_enough_points');
    expect(result.observations).toHaveLength(2);
  });

  it('CASE E — Repeat purchase-event count SSOT agrees with PPH totalOccurrenceCount', () => {
    const first = trustedSameReceiptRows({
      receiptId: 'r-a',
      occurredAt: 10_000,
      lines: [
        { sourceIndex: 0, gross: 100 },
        { sourceIndex: 1, gross: 100 },
      ],
    });
    const second = trustedSameReceiptRows({
      receiptId: 'r-b',
      occurredAt: 20_000,
      lines: [{ sourceIndex: 0, gross: 110 }],
    });
    const rows = [...first, ...second];
    const history = buildSkuHistory(rows);
    const repeatTimeline = buildPurchaseEventDatesFromRows(rows);
    expect(repeatTimeline.purchaseOccurrenceCount).toBe(2);
    expect(history.totalOccurrenceCount).toBe(2);
    expect(history.totalOccurrenceCount).toBe(
      repeatTimeline.purchaseOccurrenceCount
    );
    expect(countDistinctPurchaseEventOccurrences(rows)).toBe(
      repeatTimeline.purchaseOccurrenceCount
    );
  });

  it('untrusted second row cannot mint a second point on the same receipt', () => {
    const trusted = trustedSameReceiptRows({
      receiptId: 'r-mix',
      occurredAt: 5_000,
      lines: [{ sourceIndex: 0, gross: 4780 }],
    });
    const untrusted: ProductPriceHistoryRow = {
      ...trusted[0]!,
      itemId: 'r-mix:1',
      sourceIndex: 1,
      priceObservationVersion: null,
      itemAmountEvidenceState: null,
      amountProvenance: null,
      grossLineAmount: null,
      lineTotal: 4780,
    };
    const result = buildSkuHistory([...trusted, untrusted]);
    expect(result.totalOccurrenceCount).toBe(1);
    expect(result.comparableOccurrenceCount).toBe(1);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]!.purchaseQuantity).toBe(1);
    expect(result.status).toBe('not_enough_points');
  });

  it('trusted price-change still collapses same-receipt multi-row history to one event', () => {
    const first = trustedSameReceiptRows({
      receiptId: 'r-early',
      occurredAt: 1_000,
      lines: [
        { sourceIndex: 0, gross: 100 },
        { sourceIndex: 1, gross: 100 },
      ],
    });
    const second = trustedSameReceiptRows({
      receiptId: 'r-late',
      occurredAt: 2_000,
      lines: [{ sourceIndex: 0, gross: 120 }],
    });
    const history = buildSkuHistory([...first, ...second]);
    expect(history.status).toBe('ready');
    expect(history.points).toHaveLength(2);

    const interpretation = interpretProductPriceChange({
      history,
      targetType: 'sku',
      targetKey: 'sku-proglide',
    });
    expect(interpretation.status).toBe('available');
    if (interpretation.status !== 'available') return;
    expect(interpretation.previous.receiptId).toBe('r-early');
    expect(interpretation.previous.purchaseQuantity).toBe(2);
    expect(interpretation.previous.priceValue).toBe(100);
    expect(interpretation.current.receiptId).toBe('r-late');
    expect(interpretation.current.priceValue).toBe(120);
    expect(interpretation.grossDelta).toBe(20);
  });

  it('A1 — event metadata aggregates effective/discount; never leaks representative row', () => {
    const rows = trustedSameReceiptRows({
      receiptId: 'r-a1-meta',
      occurredAt: 7_000,
      lines: [
        {
          sourceIndex: 0,
          gross: 100,
          effective: 90,
          discountAllocated: -10,
        },
        {
          sourceIndex: 1,
          gross: 100,
          effective: 80,
          discountAllocated: -20,
        },
      ],
    });
    const result = buildSkuHistory(rows);
    expect(result.status).toBe('not_enough_points');
    expect(result.totalOccurrenceCount).toBe(1);
    expect(result.comparableOccurrenceCount).toBe(1);
    expect(result.points).toHaveLength(1);
    const point = result.points[0]!;
    expect(point.purchaseQuantity).toBe(2);
    expect(point.grossLineAmount).toBe(200);
    expect(point.effectiveLineAmount).toBe(170);
    expect(point.discountAllocated).toBe(-30);
    expect(point.priceValue).toBe(100);
    expect(point.priceKind).toBe('purchase_unit');
    // Locator may stay at representative sourceIndex, but monetary fields must
    // not equal either sibling alone.
    expect(point.sourceIndex).toBe(0);
    expect(point.effectiveLineAmount).not.toBe(90);
    expect(point.effectiveLineAmount).not.toBe(80);
    expect(point.discountAllocated).not.toBe(-10);
    expect(point.discountAllocated).not.toBe(-20);
  });

  it('A1 follow-up — second receipt keeps aggregated event metadata and becomes ready', () => {
    const first = trustedSameReceiptRows({
      receiptId: 'r-a1-first',
      occurredAt: 8_000,
      lines: [
        {
          sourceIndex: 0,
          gross: 100,
          effective: 90,
          discountAllocated: -10,
        },
        {
          sourceIndex: 1,
          gross: 100,
          effective: 80,
          discountAllocated: -20,
        },
      ],
    });
    const second = trustedSameReceiptRows({
      receiptId: 'r-a1-second',
      occurredAt: 9_000,
      lines: [
        {
          sourceIndex: 0,
          gross: 110,
          effective: 110,
          discountAllocated: 0,
        },
      ],
    });
    const result = buildSkuHistory([...first, ...second]);
    expect(result.status).toBe('ready');
    expect(result.totalOccurrenceCount).toBe(2);
    expect(result.comparableOccurrenceCount).toBe(2);
    expect(result.points).toHaveLength(2);
    expect(result.points[0]!).toMatchObject({
      receiptId: 'r-a1-first',
      purchaseQuantity: 2,
      grossLineAmount: 200,
      effectiveLineAmount: 170,
      discountAllocated: -30,
      priceValue: 100,
    });
    expect(result.points[1]!).toMatchObject({
      receiptId: 'r-a1-second',
      purchaseQuantity: 1,
      grossLineAmount: 110,
      effectiveLineAmount: 110,
      discountAllocated: 0,
      priceValue: 110,
    });
  });

  it('ambiguous effective metadata → null auxiliary fields; gross event still comparable', () => {
    const rows = trustedSameReceiptRows({
      receiptId: 'r-eff-partial',
      occurredAt: 10_500,
      lines: [
        {
          sourceIndex: 0,
          gross: 100,
          effective: 90,
          discountAllocated: -10,
        },
        {
          sourceIndex: 1,
          gross: 100,
          effective: null,
          discountAllocated: -5,
        },
      ],
    });
    const result = buildSkuHistory(rows);
    expect(result.totalOccurrenceCount).toBe(1);
    expect(result.comparableOccurrenceCount).toBe(1);
    expect(result.points).toHaveLength(1);
    const point = result.points[0]!;
    expect(point.grossLineAmount).toBe(200);
    expect(point.purchaseQuantity).toBe(2);
    expect(point.priceValue).toBe(100);
    // Incomplete sibling effective → explicit null (never representative 90).
    expect(point.effectiveLineAmount).toBeNull();
    // Discount still fully evidenced on both rows → event sum.
    expect(point.discountAllocated).toBe(-15);
  });

  it('ambiguous discount metadata → null discount; does not copy representative', () => {
    const rows = trustedSameReceiptRows({
      receiptId: 'r-disc-partial',
      occurredAt: 10_750,
      lines: [
        {
          sourceIndex: 0,
          gross: 100,
          effective: 90,
          discountAllocated: -10,
        },
        {
          sourceIndex: 1,
          gross: 100,
          effective: 95,
          discountAllocated: null,
        },
      ],
    });
    const result = buildSkuHistory(rows);
    expect(result.points).toHaveLength(1);
    const point = result.points[0]!;
    expect(point.effectiveLineAmount).toBe(185);
    expect(point.discountAllocated).toBeNull();
    expect(point.discountAllocated).not.toBe(-10);
  });

  it('incompatible currency siblings are not silently merged into one event', () => {
    const rows = trustedSameReceiptRows({
      receiptId: 'r-fx-mix',
      occurredAt: 11_000,
      lines: [
        { sourceIndex: 0, gross: 100 },
        { sourceIndex: 1, gross: 100 },
      ],
    });
    rows[1] = { ...rows[1]!, currency: 'USD', receiptCurrency: 'USD' };
    const result = buildSkuHistory(rows);
    // USD sibling fails structural JPY gate; JPY sibling may remain as a
    // single-row event. Must not emit qty=2 hybrid merging both currencies.
    expect(result.totalOccurrenceCount).toBe(1);
    expect(result.points.every((point) => point.purchaseQuantity === 1)).toBe(
      true
    );
    expect(result.points.every((point) => point.currency === 'JPY')).toBe(true);
    expect(result.points.some((point) => point.purchaseQuantity === 2)).toBe(
      false
    );
  });

  it('order-invariance — swapping sibling sourceIndexes keeps event semantics', () => {
    const buildWithOrder = (
      noneIndex: number,
      promoIndex: number
    ) => {
      const rows = trustedSameReceiptRows({
        receiptId: 'r-order-inv',
        occurredAt: 12_000,
        lines: [
          {
            sourceIndex: noneIndex,
            gross: 100,
            effective: 100,
            discountAllocated: 0,
            promoMarkers: null,
          },
          {
            sourceIndex: promoIndex,
            gross: 100,
            effective: 80,
            discountAllocated: -20,
            promoMarkers: ['特'],
          },
        ],
      });
      return buildSkuHistory(rows, { preserveQuality: true });
    };

    const forward = buildWithOrder(0, 1);
    const reverse = buildWithOrder(5, 2);
    expect(forward.points).toHaveLength(1);
    expect(reverse.points).toHaveLength(1);
    expect(semanticSnapshot(forward.points[0]!, forward.status)).toEqual(
      semanticSnapshot(reverse.points[0]!, reverse.status)
    );
    // Locator follows min sourceIndex and may differ across orderings.
    expect(forward.points[0]!.sourceIndex).toBe(0);
    expect(reverse.points[0]!.sourceIndex).toBe(2);
    expect(forward.points[0]!.sourceIndex).not.toBe(
      reverse.points[0]!.sourceIndex
    );
    // Explicit promotion must survive regardless of which row is representative.
    expect(forward.points[0]!.promoContext).toBe(
      'explicit_discount_and_marker'
    );
    expect(forward.points[0]!.promoMarkers).toEqual(['特']);
    expect(forward.points[0]!.discountAllocated).toBe(-20);
  });

  it('explicit promotion on non-representative sibling is not lost', () => {
    const build = (noneFirst: boolean) => {
      const noneLine = {
        sourceIndex: noneFirst ? 0 : 1,
        gross: 100,
        effective: 100,
        discountAllocated: 0 as number | null,
        promoMarkers: null as string[] | null,
      };
      const promoLine = {
        sourceIndex: noneFirst ? 1 : 0,
        gross: 100,
        effective: 90,
        discountAllocated: -10 as number | null,
        promoMarkers: ['特'] as string[],
      };
      const rows = trustedSameReceiptRows({
        receiptId: 'r-explicit-promo',
        occurredAt: 13_000,
        lines: noneFirst ? [noneLine, promoLine] : [promoLine, noneLine],
      });
      return buildSkuHistory(rows);
    };

    for (const noneFirst of [true, false]) {
      const result = build(noneFirst);
      expect(result.points).toHaveLength(1);
      const point = result.points[0]!;
      expect(point.promoContext).not.toBe('none_observed');
      expect(point.promoContext).toBe('explicit_discount_and_marker');
      expect(point.promoMarkers).toEqual(['特']);
      expect(point.discountAllocated).toBe(-10);
      expect(point.effectiveLineAmount).toBe(190);
    }
  });

  it('promoMarkers union is deduped and order-stable across sourceIndex swap', () => {
    const build = (aIndex: number, bIndex: number) =>
      buildSkuHistory(
        trustedSameReceiptRows({
          receiptId: 'r-marker-union',
          occurredAt: 14_000,
          lines: [
            {
              sourceIndex: aIndex,
              gross: 100,
              discountAllocated: 0,
              promoMarkers: ['特価'],
            },
            {
              sourceIndex: bIndex,
              gross: 100,
              discountAllocated: 0,
              promoMarkers: ['特', '特価'],
            },
          ],
        })
      );

    const forward = build(0, 1);
    const reverse = build(5, 2);
    expect(forward.points[0]!.promoMarkers).toEqual(['特', '特価']);
    expect(reverse.points[0]!.promoMarkers).toEqual(['特', '特価']);
    expect(forward.points[0]!.promoContext).toBe('qualitative_marker');
    expect(reverse.points[0]!.promoContext).toBe('qualitative_marker');
  });

  it('CASE Q1 — all trusted siblings → event quality remains trusted', () => {
    const rows = trustedSameReceiptRows({
      receiptId: 'r-q1',
      occurredAt: 15_000,
      lines: [
        { sourceIndex: 0, gross: 100 },
        { sourceIndex: 1, gross: 100 },
      ],
    });
    const result = buildSkuHistory(rows, { preserveQuality: true });
    expect(result.points).toHaveLength(1);
    expect(result.points[0]!.qualityLevel).toBe('trusted');
  });

  it('CASE Q2 — quality reconcile is conservative and order-invariant', () => {
    expect(
      reconcilePurchaseEventQualityLevel(['trusted', 'trusted'])
    ).toBe('trusted');
    expect(
      reconcilePurchaseEventQualityLevel([
        'trusted',
        'usable_with_caution',
      ])
    ).toBe('usable_with_caution');
    expect(
      reconcilePurchaseEventQualityLevel([
        'usable_with_caution',
        'trusted',
      ])
    ).toBe('usable_with_caution');
    expect(
      reconcilePurchaseEventQualityLevel([
        'trusted',
        'suspected_anomaly',
        'usable_with_caution',
      ])
    ).toBe('suspected_anomaly');
  });

  it('reconcile helpers — promo context/markers ignore input order', () => {
    expect(
      reconcilePurchaseEventPromoContext([
        'none_observed',
        'explicit_discount',
      ])
    ).toBe('explicit_discount');
    expect(
      reconcilePurchaseEventPromoContext([
        'explicit_discount',
        'none_observed',
      ])
    ).toBe('explicit_discount');
    expect(
      reconcilePurchaseEventPromoMarkers([[], ['特'], ['特価', '特']])
    ).toEqual(['特', '特価']);
    expect(
      reconcilePurchaseEventPromoMarkers([['特価', '特'], ['特'], []])
    ).toEqual(['特', '特価']);
  });

  it('ProductPriceChangeInterpretation sees event-level promo from non-representative sibling', () => {
    const first = trustedSameReceiptRows({
      receiptId: 'r-interp-promo',
      occurredAt: 16_000,
      lines: [
        {
          sourceIndex: 0,
          gross: 100,
          effective: 100,
          discountAllocated: 0,
          promoMarkers: null,
        },
        {
          sourceIndex: 1,
          gross: 100,
          effective: 80,
          discountAllocated: -20,
          promoMarkers: ['特'],
        },
      ],
    });
    const second = trustedSameReceiptRows({
      receiptId: 'r-interp-later',
      occurredAt: 17_000,
      lines: [
        {
          sourceIndex: 0,
          gross: 120,
          effective: 120,
          discountAllocated: 0,
        },
      ],
    });
    const history = buildSkuHistory([...first, ...second]);
    expect(history.status).toBe('ready');
    expect(history.points[0]!.promoContext).toBe(
      'explicit_discount_and_marker'
    );
    expect(history.points[0]!.discountAllocated).toBe(-20);

    const interpretation = interpretProductPriceChange({
      history,
      targetType: 'sku',
      targetKey: 'sku-proglide',
    });
    expect(interpretation.status).toBe('available');
    if (interpretation.status !== 'available') return;
    expect(interpretation.previous.promoContext).toBe(
      'explicit_discount_and_marker'
    );
    expect(interpretation.previous.promoState).toBe(
      'explicit_discount_and_marker'
    );
    expect(interpretation.previous.discountAllocated).toBe(-20);
    expect(interpretation.previous.purchaseQuantity).toBe(2);
  });
});
