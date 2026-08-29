/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import {
  interpretProductPriceChange,
  type ProductPriceChangeInterpretation,
} from './productPriceChangeInterpretation';
import type { ProductIdentityLevel } from './productIdentityContract';
import {
  buildProductPriceHistory,
  type ProductPriceHistoryObservation,
  type ProductPriceHistoryPoint,
  type ProductPriceHistoryResult,
} from './productPriceHistory';
import {
  createTrustedReceiptTestCache,
  makeTrustedG3TestRow,
} from './productPriceHistory.testFixtures';

const SKU = 'test-sku-exact';

function trustedSkuRow(
  id: string,
  gross: number,
  overrides: Partial<ReturnType<typeof makeTrustedG3TestRow>> = {}
) {
  return makeTrustedG3TestRow(id, {
    skuKey: SKU,
    grossLineAmount: gross,
    lineTotal: gross,
    purchaseQuantity: 1,
    receiptId: overrides.receiptId ?? `receipt-${id}`,
    itemId: overrides.itemId ?? `item-${id}`,
    occurredAt: overrides.occurredAt ?? Number(id.replace(/\D/g, '')) * 86_400_000,
    ...overrides,
  });
}

function readySkuHistory(
  rows: ReturnType<typeof makeTrustedG3TestRow>[],
  duplicateApplied = true
): ProductPriceHistoryResult {
  const cache = createTrustedReceiptTestCache(rows);
  const result = buildProductPriceHistory(
    { type: 'sku', key: SKU },
    rows,
    {
      receiptEvidenceCache: cache,
      canonicalDuplicateSelectionApplied: duplicateApplied,
    }
  );
  return {
    ...result,
    points: result.points.map((point) => ({
      ...point,
      skuKey: SKU,
      qualityLevel: 'trusted' as const,
    })),
  };
}

function interpretSku(
  history: ProductPriceHistoryResult
): ProductPriceChangeInterpretation {
  return interpretProductPriceChange({
    history,
    targetType: 'sku',
    targetKey: SKU,
  });
}

function baseObservation(
  receiptId: string,
  occurredAt: number,
  overrides: Partial<ProductPriceHistoryObservation> = {}
): ProductPriceHistoryObservation {
  return {
    receiptId,
    itemId: overrides.itemId ?? `item-${receiptId}`,
    sourceIndex: overrides.sourceIndex ?? 0,
    occurredAt,
    level: 1,
    seriesKind: 'gross',
    grossLineAmount: overrides.grossLineAmount ?? 100,
    effectiveLineAmount: overrides.effectiveLineAmount ?? 100,
    purchaseQuantity: overrides.purchaseQuantity ?? 1,
    currency: 'JPY',
    amountProvenance: 'ocr_observed',
    itemAmountEvidenceState: 'coherent',
    priceObservationVersion: 1,
    amountBasis: 'tax_included',
    exactComparisonTrusted: overrides.exactComparisonTrusted ?? true,
    monetaryCoherenceState: 'known_coherent',
    monetaryProvenanceSufficient: true,
    discountOwnershipStatus: 'resolved',
    promoContext: 'none_observed',
    promoMarkers: [],
    level2Eligible: overrides.level2Eligible ?? true,
    level2RejectReasons: overrides.level2RejectReasons ?? [],
    qualityLevel: overrides.qualityLevel ?? 'trusted',
    discountAllocated: null,
    ...overrides,
  };
}

function readySkuHistoryAt(
  specs: Array<{
    receiptId: string;
    gross: number;
    occurredAt: number;
    rowOverrides?: Partial<ReturnType<typeof makeTrustedG3TestRow>>;
    observationOverrides?: Partial<ProductPriceHistoryObservation>;
  }>,
  duplicateApplied = true
): ProductPriceHistoryResult {
  const rows = specs.map((spec, index) =>
    trustedSkuRow(String(index + 1), spec.gross, {
      receiptId: spec.receiptId,
      occurredAt: spec.occurredAt,
      ...spec.rowOverrides,
    })
  );
  const history = readySkuHistory(rows, duplicateApplied);
  const observations = specs.map((spec, index) =>
    baseObservation(spec.receiptId, spec.occurredAt, {
      grossLineAmount: spec.gross,
      effectiveLineAmount: spec.gross,
      itemId: rows[index]!.itemId,
      sourceIndex: rows[index]!.sourceIndex,
      ...spec.observationOverrides,
    })
  );
  return { ...history, observations };
}

describe('G3-2B-1 product price change interpretation', () => {
  it('SKU 439 -> 439 is available unchanged', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 439),
      trustedSkuRow('2', 439),
    ]);
    const result = interpretSku(history);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.grossDirection).toBe('unchanged');
      expect(result.grossDelta).toBe(0);
    }
  });

  it('SKU 397 -> 298 is available decreased with grossDelta -99', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 397),
      trustedSkuRow('2', 298),
    ]);
    const result = interpretSku(history);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.grossDirection).toBe('decreased');
      expect(result.grossDelta).toBe(-99);
    }
  });

  it('SKU 298 -> 397 is available increased with grossDelta +99', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 298),
      trustedSkuRow('2', 397),
    ]);
    const result = interpretSku(history);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.grossDirection).toBe('increased');
      expect(result.grossDelta).toBe(99);
    }
  });

  it('usable_with_caution blocks exact interpretation', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 397),
      trustedSkuRow('2', 298),
    ]);
    history.points[1] = {
      ...history.points[1]!,
      qualityLevel: 'usable_with_caution',
    };
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('quality_not_trusted');
    }
  });

  it('canonical duplicate provenance false blocks Level 3', () => {
    const history = readySkuHistory(
      [trustedSkuRow('1', 397), trustedSkuRow('2', 298)],
      false
    );
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('duplicate_selection_unconfirmed');
    }
  });

  it('explicit empty duplicate exclusion set may establish provenance', () => {
    const history = readySkuHistory(
      [trustedSkuRow('1', 397), trustedSkuRow('2', 298)],
      true
    );
    expect(history.canonicalDuplicateSelectionApplied).toBe(true);
    expect(interpretSku(history).status).toBe('available');
  });

  it('canonical target rejects exact interpretation', () => {
    const canonicalName = '明治牛乳';
    const rows = [
      makeTrustedG3TestRow('1', {
        displayName: canonicalName,
        grossLineAmount: 397,
        volumeBaseMl: 1000,
        productFamilyKey: 'milk',
      }),
      makeTrustedG3TestRow('2', {
        displayName: canonicalName,
        grossLineAmount: 298,
        volumeBaseMl: 1000,
        productFamilyKey: 'milk',
      }),
    ];
    const cache = createTrustedReceiptTestCache(rows);
    const history = buildProductPriceHistory(
      { type: 'canonical', key: canonicalName },
      rows,
      {
        receiptEvidenceCache: cache,
        canonicalDuplicateSelectionApplied: true,
      }
    );
    const result = interpretProductPriceChange({
      history: {
        ...history,
        points: history.points.map((point) => ({
          ...point,
          qualityLevel: 'trusted' as const,
        })),
      },
      targetType: 'canonical',
      targetKey: canonicalName,
    });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('identity_not_exact');
    }
  });

  it('CASE A promo ended while gross unchanged', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 439, {
        effectiveLineAmount: 406,
        discountAllocated: -33,
      }),
      trustedSkuRow('2', 439, {
        effectiveLineAmount: 439,
        discountAllocated: 0,
      }),
    ]);
    history.points[0] = {
      ...history.points[0]!,
      promoContext: 'explicit_discount',
      effectiveLineAmount: 406,
      discountAllocated: -33,
    };
    history.points[1] = {
      ...history.points[1]!,
      promoContext: 'none_observed',
      effectiveLineAmount: 439,
      discountAllocated: 0,
    };
    const result = interpretSku(history);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.grossDirection).toBe('unchanged');
      expect(result.grossDelta).toBe(0);
      expect(result.promoTransition).toBe('ended');
    }
  });

  it('CASE B promo started while gross unchanged', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 439),
      trustedSkuRow('2', 439),
    ]);
    history.points[0] = {
      ...history.points[0]!,
      promoContext: 'none_observed',
      effectiveLineAmount: 439,
    };
    history.points[1] = {
      ...history.points[1]!,
      promoContext: 'explicit_discount',
      effectiveLineAmount: 388,
      discountAllocated: -51,
    };
    const result = interpretSku(history);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.grossDirection).toBe('unchanged');
      expect(result.promoTransition).toBe('started');
    }
  });

  it('CASE C gross decrease remains available when promo unknown', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 397),
      trustedSkuRow('2', 298),
    ]);
    history.points.forEach((point) => {
      point.promoContext = 'unknown';
    });
    const result = interpretSku(history);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.grossDirection).toBe('decreased');
      expect(result.promoTransition).toBe('unknown');
    }
  });

  it('CASE D qualitative marker does not infer numeric discount', () => {
    const history = readySkuHistory([trustedSkuRow('1', 439), trustedSkuRow('2', 439)]);
    history.points[1] = {
      ...history.points[1]!,
      promoContext: 'qualitative_marker',
      promoMarkers: ['特'],
      discountAllocated: null,
    };
    const result = interpretSku(history);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.currentPromo).toBe('qualitative_marker');
      expect(result.currentDiscountAllocated).toBeNull();
    }
  });

  it('collapses same-receipt split SKU rows into one purchase event', () => {
    const receiptATime = 1 * 86_400_000;
    const receiptBTime = 2 * 86_400_000;
    const history = readySkuHistory([
      trustedSkuRow('a1', 100, {
        receiptId: 'receipt-a',
        itemId: 'item-a1',
        sourceIndex: 0,
        purchaseQuantity: 1,
        occurredAt: receiptATime,
      }),
      trustedSkuRow('a2', 200, {
        receiptId: 'receipt-a',
        itemId: 'item-a2',
        sourceIndex: 1,
        purchaseQuantity: 2,
        occurredAt: receiptATime,
      }),
      trustedSkuRow('b1', 240, {
        receiptId: 'receipt-b',
        itemId: 'item-b1',
        sourceIndex: 0,
        purchaseQuantity: 2,
        occurredAt: receiptBTime,
      }),
    ]);
    const result = interpretSku(history);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.previous.priceValue).toBe(100);
      expect(result.current.priceValue).toBe(120);
      expect(result.previous.purchaseQuantity).toBe(3);
      expect(result.previous.grossLineAmount).toBe(300);
    }
  });

  it('qty=3 on one receipt is one purchase event not three', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 300, {
        receiptId: 'receipt-a',
        purchaseQuantity: 3,
      }),
      trustedSkuRow('2', 240, {
        receiptId: 'receipt-b',
        purchaseQuantity: 2,
        occurredAt: 2 * 86_400_000,
      }),
    ]);
    const result = interpretSku(history);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.previous.priceValue).toBe(100);
      expect(result.current.priceValue).toBe(120);
    }
  });

  it('same exact occurredAt across distinct receipts is ambiguous', () => {
    const ts = 1_700_000_000_000;
    const history = readySkuHistory([
      trustedSkuRow('1', 397, { receiptId: 'receipt-a', occurredAt: ts }),
      trustedSkuRow('2', 298, { receiptId: 'receipt-b', occurredAt: ts }),
    ]);
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('ambiguous_same_timestamp');
    }
  });

  it('merchant_product exact identity authorizes when identityLevel is merchant_product', () => {
    const mpId = 'mp_test_exact';
    const scope = 'merchant-a';
    const history: ProductPriceHistoryResult = {
      target: { type: 'merchant_product', key: mpId },
      status: 'ready',
      priceKind: 'purchase_unit',
      currency: 'JPY',
      seriesKind: 'gross',
      amountBasis: 'tax_included',
      canonicalDuplicateSelectionApplied: true,
      totalOccurrenceCount: 2,
      comparableOccurrenceCount: 2,
      excludedOccurrenceCount: 0,
      observations: [
        baseObservation('receipt-a', 1 * 86_400_000, { grossLineAmount: 397 }),
        baseObservation('receipt-b', 2 * 86_400_000, { grossLineAmount: 298 }),
      ],
      points: [
        merchantPoint('receipt-a', 397, mpId, scope, 1),
        merchantPoint('receipt-b', 298, mpId, scope, 2),
      ],
    };
    const result = interpretProductPriceChange({
      history,
      targetType: 'merchant_product',
      targetKey: mpId,
    });
    expect(result.status).toBe('available');
  });

  it('merchant_product with family_spec identityLevel is unavailable', () => {
    const mpId = 'mp_test_exact';
    const scope = 'merchant-a';
    const history: ProductPriceHistoryResult = {
      target: { type: 'merchant_product', key: mpId },
      status: 'ready',
      priceKind: 'purchase_unit',
      currency: 'JPY',
      seriesKind: 'gross',
      amountBasis: 'tax_included',
      canonicalDuplicateSelectionApplied: true,
      totalOccurrenceCount: 2,
      comparableOccurrenceCount: 2,
      excludedOccurrenceCount: 0,
      observations: [
        baseObservation('receipt-a', 1 * 86_400_000, { grossLineAmount: 397 }),
        baseObservation('receipt-b', 2 * 86_400_000, { grossLineAmount: 298 }),
      ],
      points: [
        merchantPoint('receipt-a', 397, mpId, scope, 1, 'merchant_product'),
        merchantPoint('receipt-b', 298, mpId, scope, 2, 'family_spec'),
      ],
    };
    const result = interpretProductPriceChange({
      history,
      targetType: 'merchant_product',
      targetKey: mpId,
    });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('identity_not_exact');
    }
  });
});

describe('G3-2B-1 observation completeness', () => {
  const june = Date.parse('2026-06-01');
  const july = Date.parse('2026-07-01');

  it('CASE K empty observations fail closed', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 397),
      trustedSkuRow('2', 298),
    ]);
    history.observations = [];
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('purchase_observation_history_incomplete');
    }
  });

  it('CASE L comparable receipt missing from observations fails closed', () => {
    const history = readySkuHistoryAt([
      { receiptId: 'receipt-a', gross: 397, occurredAt: june },
      { receiptId: 'receipt-b', gross: 298, occurredAt: july },
    ]);
    history.observations = history.observations.filter(
      (observation) => observation.receiptId !== 'receipt-a'
    );
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('purchase_observation_history_incomplete');
    }
  });

  it('CASE M complete normal history remains available', () => {
    const history = readySkuHistoryAt([
      { receiptId: 'receipt-a', gross: 397, occurredAt: june },
      { receiptId: 'receipt-b', gross: 298, occurredAt: july },
    ]);
    const result = interpretSku(history);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.grossDirection).toBe('decreased');
      expect(result.grossDelta).toBe(-99);
    }
  });
});

describe('G3-2B-1 latest purchase safety and temporal validation', () => {
  const june = Date.parse('2026-06-01');
  const july = Date.parse('2026-07-01');
  const august = Date.parse('2026-08-01');

  it('A blocks when newer Level-1-only observation exists outside points', () => {
    const history = readySkuHistoryAt([
      { receiptId: 'receipt-a', gross: 397, occurredAt: june },
      { receiptId: 'receipt-b', gross: 298, occurredAt: july },
    ]);
    history.observations.push(
      baseObservation('receipt-c', august, {
        grossLineAmount: 250,
        level2Eligible: false,
        level2RejectReasons: ['legacy_unbackfilled'],
        qualityLevel: 'invalid',
      })
    );
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('latest_purchase_not_comparable');
    }
  });

  it('B blocks when latest purchase is usable_with_caution in observations only', () => {
    const history = readySkuHistoryAt([
      { receiptId: 'receipt-a', gross: 397, occurredAt: june },
      { receiptId: 'receipt-b', gross: 298, occurredAt: july },
    ]);
    history.observations.push(
      baseObservation('receipt-c', august, {
        grossLineAmount: 250,
        level2Eligible: false,
        level2RejectReasons: ['quality_not_trusted'],
        qualityLevel: 'usable_with_caution',
      })
    );
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('latest_purchase_not_comparable');
    }
  });

  it('B blocks when latest purchase is usable_with_caution in points', () => {
    const history = readySkuHistoryAt([
      { receiptId: 'receipt-a', gross: 397, occurredAt: june },
      { receiptId: 'receipt-b', gross: 298, occurredAt: july },
    ]);
    history.points.push({
      ...history.points[1]!,
      receiptId: 'receipt-c',
      itemId: 'item-c',
      sourceIndex: 0,
      occurredAt: august,
      grossLineAmount: 250,
      lineTotal: 250,
      priceValue: 250,
      qualityLevel: 'usable_with_caution',
      skuKey: SKU,
    });
    history.observations.push(
      baseObservation('receipt-c', august, {
        grossLineAmount: 250,
        qualityLevel: 'usable_with_caution',
        level2Eligible: false,
        level2RejectReasons: ['quality_not_trusted'],
      })
    );
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('quality_not_trusted');
    }
  });

  it('C blocks when newest observation is excluded for suspected anomaly', () => {
    const history = readySkuHistoryAt([
      { receiptId: 'receipt-a', gross: 397, occurredAt: june },
      { receiptId: 'receipt-b', gross: 298, occurredAt: july },
    ]);
    history.observations.push(
      baseObservation('receipt-c', august, {
        grossLineAmount: 250,
        level2Eligible: false,
        level2RejectReasons: ['suspected_anomaly'],
        qualityLevel: 'invalid',
        exactComparisonTrusted: false,
      })
    );
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('latest_purchase_not_comparable');
    }
  });

  it('D rejects comparable point with NaN occurredAt', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 397),
      trustedSkuRow('2', 298),
    ]);
    history.points[1] = { ...history.points[1]!, occurredAt: Number.NaN };
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('invalid_timestamp');
    }
  });

  it('E rejects comparable point with Infinity occurredAt', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 397),
      trustedSkuRow('2', 298),
    ]);
    history.points[0] = { ...history.points[0]!, occurredAt: Number.POSITIVE_INFINITY };
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('invalid_timestamp');
    }
  });

  it('F rejects negative comparable point occurredAt', () => {
    const history = readySkuHistory([
      trustedSkuRow('1', 397),
      trustedSkuRow('2', 298),
    ]);
    history.points[1] = { ...history.points[1]!, occurredAt: -1 };
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('invalid_timestamp');
    }
  });

  it('G rejects malformed latest observation timestamp', () => {
    const history = readySkuHistoryAt([
      { receiptId: 'receipt-a', gross: 397, occurredAt: june },
      { receiptId: 'receipt-b', gross: 298, occurredAt: july },
    ]);
    history.observations.push(
      baseObservation('receipt-c', Number.NaN, {
        level2Eligible: false,
        level2RejectReasons: ['invalid_timestamp'],
      })
    );
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('invalid_timestamp');
    }
  });

  it('H blocks when latest Level-1 observation shares timestamp with latest comparable', () => {
    const ten = Date.parse('2026-06-01T10:00:00Z');
    const eleven = Date.parse('2026-06-01T11:00:00Z');
    const history = readySkuHistoryAt([
      { receiptId: 'receipt-a', gross: 397, occurredAt: ten },
      { receiptId: 'receipt-b', gross: 298, occurredAt: eleven },
    ]);
    history.observations.push(
      baseObservation('receipt-c', eleven, {
        grossLineAmount: 250,
        level2Eligible: false,
        level2RejectReasons: ['legacy_unbackfilled'],
      })
    );
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('ambiguous_same_timestamp');
    }
  });

  it('I keeps valid A/B available when no newer observation exists', () => {
    const history = readySkuHistoryAt([
      { receiptId: 'receipt-a', gross: 397, occurredAt: june },
      { receiptId: 'receipt-b', gross: 298, occurredAt: july },
    ]);
    const result = interpretSku(history);
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.grossDirection).toBe('decreased');
      expect(result.grossDelta).toBe(-99);
    }
  });

  it('J ignores extra same-receipt observation row as distinct newer purchase', () => {
    const history = readySkuHistoryAt([
      { receiptId: 'receipt-a', gross: 397, occurredAt: june },
      { receiptId: 'receipt-b', gross: 298, occurredAt: july },
    ]);
    history.observations.push(
      baseObservation('receipt-b', july, {
        itemId: 'item-b-extra',
        sourceIndex: 1,
        grossLineAmount: 298,
        level2Eligible: false,
        level2RejectReasons: ['suspected_anomaly'],
        qualityLevel: 'invalid',
      })
    );
    const result = interpretSku(history);
    expect(result.status).toBe('available');
  });

  it('blocks when latest non-comparable observation is later than latest comparable', () => {
    const ten = Date.parse('2026-06-01T10:00:00Z');
    const eleven = Date.parse('2026-06-01T11:00:00Z');
    const twelve = Date.parse('2026-06-01T12:00:00Z');
    const history = readySkuHistoryAt([
      { receiptId: 'receipt-a', gross: 397, occurredAt: ten },
      { receiptId: 'receipt-b', gross: 298, occurredAt: eleven },
    ]);
    history.observations.push(
      baseObservation('receipt-c', twelve, {
        grossLineAmount: 250,
        level2Eligible: false,
        level2RejectReasons: ['legacy_unbackfilled'],
      })
    );
    const result = interpretSku(history);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reasonCodes).toContain('latest_purchase_not_comparable');
    }
  });
});

function merchantPoint(
  receiptId: string,
  gross: number,
  merchantProductId: string,
  merchantScopeKey: string,
  seq: number,
  identityLevel: ProductIdentityLevel = 'merchant_product'
): ProductPriceHistoryPoint {
  return {
    receiptId,
    itemId: `item-${receiptId}`,
    sourceIndex: 0,
    occurredAt: seq * 86_400_000,
    merchantRaw: 'Store',
    merchantNormalized: merchantScopeKey,
    displayName: 'Product',
    currency: 'JPY',
    lineTotal: gross,
    purchaseQuantity: 1,
    priceValue: gross,
    priceKind: 'purchase_unit',
    seriesKind: 'gross',
    grossLineAmount: gross,
    amountBasis: 'tax_included',
    qualityLevel: 'trusted',
    merchantProductId,
    identityLevel,
    merchantScopeKey,
    promoContext: 'none_observed',
  };
}

describe('G4-2B personal_product interpretation authority', () => {
  const ANCHOR = 'mp_aeon';
  const MEMBER = 'mp_york';
  const OUTSIDE = 'mp_outside';

  function personalCertificate(
    rows: Array<{
      receiptId: string;
      itemId: string;
      sourceIndex: number;
      merchantProductId: string;
    }>,
    overrides: Partial<{
      anchorMerchantProductId: string;
      memberMerchantProductIds: string[];
    }> = {}
  ) {
    return {
      kind: 'personal_product' as const,
      identityLevel: 'product_exact' as const,
      sourceTier: 'personal_manual' as const,
      anchorMerchantProductId: overrides.anchorMerchantProductId ?? ANCHOR,
      memberMerchantProductIds:
        overrides.memberMerchantProductIds ?? [ANCHOR, MEMBER],
      authorizedRows: rows,
    };
  }

  function readyPersonalHistory(
    rows: ReturnType<typeof trustedSkuRow>[],
    certificateRows: Array<{
      receiptId: string;
      itemId: string;
      sourceIndex: number;
      merchantProductId: string;
    }>,
    certificateOverrides: Partial<{
      anchorMerchantProductId: string;
      memberMerchantProductIds: string[];
    }> = {}
  ): ProductPriceHistoryResult {
    const cache = createTrustedReceiptTestCache(rows);
    const base = buildProductPriceHistory(
      { type: 'sku', key: SKU },
      rows,
      {
        receiptEvidenceCache: cache,
        canonicalDuplicateSelectionApplied: true,
      }
    );
    const certificate = personalCertificate(certificateRows, certificateOverrides);
    return {
      ...base,
      target: { type: 'personal_product', key: ANCHOR },
      points: base.points.map((point) => {
        const cert = certificateRows.find(
          (row) =>
            row.receiptId === point.receiptId &&
            row.sourceIndex === point.sourceIndex
        );
        return {
          ...point,
          qualityLevel: 'trusted' as const,
          itemId: cert?.itemId ?? point.itemId,
          merchantProductId: cert?.merchantProductId ?? point.merchantProductId,
        };
      }),
      personalProductPriceAuthority: certificate,
    };
  }

  function interpretPersonal(
    history: ProductPriceHistoryResult,
    targetKey = ANCHOR
  ) {
    return interpretProductPriceChange({
      history,
      targetType: 'personal_product',
      targetKey,
    });
  }

  const twoEventRows = [
    trustedSkuRow('1', 100, {
      receiptId: 'r-aeon',
      itemId: 'item-aeon',
      occurredAt: 86_400_000,
      merchantNormalized: 'aeon',
    }),
    trustedSkuRow('2', 120, {
      receiptId: 'r-york',
      itemId: 'item-york',
      occurredAt: 172_800_000,
      merchantNormalized: 'york',
    }),
  ];

  const fullCertificateRows = [
    {
      receiptId: 'r-aeon',
      itemId: 'item-aeon',
      sourceIndex: 0,
      merchantProductId: ANCHOR,
    },
    {
      receiptId: 'r-york',
      itemId: 'item-york',
      sourceIndex: 0,
      merchantProductId: MEMBER,
    },
  ];

  it('requires personal certificate for personal_product target', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    const withoutCertificate = { ...history, personalProductPriceAuthority: null };
    expect(interpretPersonal(withoutCertificate)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('accepts valid cross-store personal certificate when G3 gates pass', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    const result = interpretPersonal(history, MEMBER);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.identityAuthority).toEqual({
      kind: 'personal_product',
      anchorMerchantProductId: ANCHOR,
      memberMerchantProductIds: [ANCHOR, MEMBER],
    });
  });

  it('rejects targetKey outside member list', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    expect(interpretPersonal(history, OUTSIDE)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects anchor outside member list', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows, {
      anchorMerchantProductId: OUTSIDE,
      memberMerchantProductIds: [ANCHOR, MEMBER],
    });
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects certificate authorizedRows with MP outside component even if unused', () => {
    const history = readyPersonalHistory(twoEventRows, [
      ...fullCertificateRows,
      {
        receiptId: 'r-unused',
        itemId: 'item-unused',
        sourceIndex: 0,
        merchantProductId: OUTSIDE,
      },
    ]);
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects observation outside authorizedRows', () => {
    const history = readyPersonalHistory(twoEventRows, [fullCertificateRows[0]!]);
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects point outside authorizedRows', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    history.points = history.points.map((point) =>
      point.receiptId === 'r-york'
        ? { ...point, sourceIndex: 99 }
        : point
    );
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects point merchantProductId differing from certificate row', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    history.points = history.points.map((point) =>
      point.receiptId === 'r-york'
        ? { ...point, merchantProductId: OUTSIDE }
        : point
    );
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects point itemId differing from certificate row', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    history.points = history.points.map((point) =>
      point.receiptId === 'r-york'
        ? { ...point, itemId: 'different-item' }
        : point
    );
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects blank point itemId', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    history.points = history.points.map((point) => ({ ...point, itemId: '  ' }));
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects blank certificate itemId', () => {
    const history = readyPersonalHistory(twoEventRows, [
      {
        receiptId: 'r-aeon',
        itemId: '   ',
        sourceIndex: 0,
        merchantProductId: ANCHOR,
      },
      fullCertificateRows[1]!,
    ]);
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects duplicate certificate row key with conflicting merchantProductId', () => {
    const history = readyPersonalHistory(twoEventRows, [
      fullCertificateRows[0]!,
      {
        receiptId: 'r-aeon',
        itemId: 'item-aeon',
        sourceIndex: 0,
        merchantProductId: OUTSIDE,
      },
      fullCertificateRows[1]!,
    ]);
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('allows valid old member locator targetKey', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    expect(interpretPersonal(history, MEMBER).status).toBe('available');
  });

  it('keeps canonical and family targets identity_not_exact', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    expect(
      interpretProductPriceChange({
        history,
        targetType: 'canonical',
        targetKey: 'Product',
      }).status
    ).toBe('unavailable');
    expect(
      interpretProductPriceChange({
        history,
        targetType: 'family',
        targetKey: 'milk',
      }).status
    ).toBe('unavailable');
  });

  it('same-receipt multi-row aggregation succeeds when every row is authorized', () => {
    const rows = [
      trustedSkuRow('1', 60, {
        receiptId: 'r-shared',
        itemId: 'item-shared-a',
        sourceIndex: 0,
        occurredAt: 86_400_000,
      }),
      trustedSkuRow('2', 40, {
        receiptId: 'r-shared',
        itemId: 'item-shared-b',
        sourceIndex: 1,
        occurredAt: 86_400_000,
      }),
      trustedSkuRow('3', 120, {
        receiptId: 'r-york',
        itemId: 'item-york',
        sourceIndex: 0,
        occurredAt: 172_800_000,
      }),
    ];
    const history = readyPersonalHistory(rows, [
      {
        receiptId: 'r-shared',
        itemId: 'item-shared-a',
        sourceIndex: 0,
        merchantProductId: ANCHOR,
      },
      {
        receiptId: 'r-shared',
        itemId: 'item-shared-b',
        sourceIndex: 1,
        merchantProductId: ANCHOR,
      },
      {
        receiptId: 'r-york',
        itemId: 'item-york',
        sourceIndex: 0,
        merchantProductId: MEMBER,
      },
    ]);
    expect(interpretPersonal(history).status).toBe('available');
  });

  it('same-receipt multi-row aggregation fails when one row is unauthorized', () => {
    const rows = [
      trustedSkuRow('1', 60, {
        receiptId: 'r-shared',
        itemId: 'item-shared-a',
        sourceIndex: 0,
        occurredAt: 86_400_000,
      }),
      trustedSkuRow('2', 40, {
        receiptId: 'r-shared',
        itemId: 'item-shared-b',
        sourceIndex: 1,
        occurredAt: 86_400_000,
      }),
      trustedSkuRow('3', 120, {
        receiptId: 'r-york',
        itemId: 'item-york',
        sourceIndex: 0,
        occurredAt: 172_800_000,
      }),
    ];
    const history = readyPersonalHistory(rows, [
      {
        receiptId: 'r-shared',
        itemId: 'item-shared-a',
        sourceIndex: 0,
        merchantProductId: ANCHOR,
      },
      {
        receiptId: 'r-york',
        itemId: 'item-york',
        sourceIndex: 0,
        merchantProductId: MEMBER,
      },
    ]);
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('latest Level-1 observation noncomparable blocks exact interpretation', () => {
    const rows = [
      trustedSkuRow('1', 100, {
        receiptId: 'r-aeon',
        itemId: 'item-aeon',
        occurredAt: 86_400_000,
      }),
      trustedSkuRow('2', 120, {
        receiptId: 'r-york',
        itemId: 'item-york',
        occurredAt: 172_800_000,
        itemAmountEvidenceState: 'conflict',
      }),
    ];
    const history = readyPersonalHistory(rows, fullCertificateRows);
    history.observations = history.observations.map((observation) =>
      observation.receiptId === 'r-york'
        ? {
            ...observation,
            level2Eligible: false,
            level2RejectReasons: ['item_amount_evidence_state'],
          }
        : observation
    );
    history.points = history.points.filter((point) => point.receiptId !== 'r-york');
    expect(interpretPersonal(history).status).toBe('unavailable');
  });

  it('rejects padded point itemId against unpadded certificate itemId', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    history.points = history.points.map((point) =>
      point.receiptId === 'r-aeon'
        ? { ...point, itemId: ' item-aeon' }
        : point
    );
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects padded certificate itemId as invalid certificate', () => {
    const history = readyPersonalHistory(twoEventRows, [
      {
        ...fullCertificateRows[0]!,
        itemId: ' item-aeon',
      },
      fullCertificateRows[1]!,
    ]);
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects padded point merchantProductId against unpadded certificate row', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    history.points = history.points.map((point) =>
      point.receiptId === 'r-aeon'
        ? { ...point, merchantProductId: ' mp_aeon' }
        : point
    );
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('rejects padded certificate merchantProductId outside exact member list', () => {
    const history = readyPersonalHistory(
      twoEventRows,
      [
        {
          ...fullCertificateRows[0]!,
          merchantProductId: ' mp_aeon',
        },
        fullCertificateRows[1]!,
      ],
      { memberMerchantProductIds: [ANCHOR, MEMBER] }
    );
    expect(interpretPersonal(history)).toMatchObject({
      status: 'unavailable',
      reasonCodes: ['identity_not_exact'],
    });
  });

  it('accepts exact unpadded identifiers for personal authorization', () => {
    const history = readyPersonalHistory(twoEventRows, fullCertificateRows);
    expect(interpretPersonal(history, ANCHOR).status).toBe('available');
  });
});
