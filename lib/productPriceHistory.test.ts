/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
import type * as SQLite from 'expo-sqlite';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptAmountBasisAssessment } from './analysisFoundation/types';
import { resolveReceiptItemIdentity } from './productIdentityResolver';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import type { ReceiptMonetaryCoherenceEvidence } from './receiptEvidenceTruth/types';
import type { ProductDetailTarget } from './productDetailTarget';
import {
  buildObservations,
  buildProductPriceHistory,
  buildReceiptEvidenceCache,
  loadProductPriceHistoryWithDb,
  readPromoMarkersFromRow,
  resolvePromoContextFromRow,
  type ProductPriceHistoryDatabase,
  type ProductPriceHistoryRow,
  type ReceiptEvidenceCache,
} from './productPriceHistory';

function row(
  id: string,
  overrides: Partial<ProductPriceHistoryRow> = {}
): ProductPriceHistoryRow {
  return {
    receiptId: `receipt-${id}`,
    itemId: `item-${id}`,
    sourceIndex: 0,
    occurredAt: Number(id.replace(/\D/g, '')) || 1,
    merchantRaw: 'Store',
    merchantNormalized: 'store',
    displayName: `Product ${id}`,
    currency: 'JPY',
    lineTotal: 100,
    purchaseQuantity: 1,
    productFamilyKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    ...overrides,
  };
}

function trustedG3Row(
  id: string,
  overrides: Partial<ProductPriceHistoryRow> = {}
): ProductPriceHistoryRow {
  const gross = overrides.grossLineAmount ?? overrides.lineTotal ?? 100;
  return row(id, {
    grossLineAmount: gross,
    effectiveLineAmount: overrides.effectiveLineAmount ?? gross,
    lineTotal: overrides.lineTotal ?? gross,
    priceObservationVersion: 1,
    itemAmountEvidenceState: 'coherent',
    amountProvenance: 'ocr_observed',
    evidenceCaptureVersion: 1,
    currency: 'JPY',
    receiptAnalysisJson: JSON.stringify({
      items: [{ name: '商品', lineTotal: gross, quantity: 1 }],
      evidenceCaptureVersion: 1,
      reconciliation: { ok: true },
      amount_mismatch: false,
    }),
    receiptTaxIsKnown: 1,
    receiptTotal: gross,
    receiptTax: 8,
    receiptCurrency: 'JPY',
    ...overrides,
  });
}

function legacyUntrustedRow(
  id: string,
  overrides: Partial<ProductPriceHistoryRow> = {}
): ProductPriceHistoryRow {
  return row(id, {
    lineTotal: overrides.lineTotal ?? 100,
    grossLineAmount: null,
    priceObservationVersion: null,
    itemAmountEvidenceState: null,
    ...overrides,
  });
}

function trustedEvidenceEntry(
  receiptId: string,
  basis: 'tax_included' | 'tax_excluded' = 'tax_included',
  monetaryOverrides: Partial<ReceiptMonetaryCoherenceEvidence> = {}
): ReceiptEvidenceCache {
  const amountBasisAssessment: ReceiptAmountBasisAssessment = {
    receiptId,
    basis,
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
    ...monetaryOverrides,
  };
  return new Map([[receiptId, { amountBasisAssessment, monetaryCoherenceEvidence }]]);
}

function buildTrustedCache(
  rows: readonly ProductPriceHistoryRow[],
  basisByReceipt: Record<string, 'tax_included' | 'tax_excluded'> = {}
): ReceiptEvidenceCache {
  const cache: ReceiptEvidenceCache = new Map();
  for (const rowEntry of rows) {
    if (cache.has(rowEntry.receiptId)) continue;
    const basis = basisByReceipt[rowEntry.receiptId] ?? 'tax_included';
    const entry = trustedEvidenceEntry(rowEntry.receiptId, basis);
    cache.set(rowEntry.receiptId, entry.get(rowEntry.receiptId)!);
  }
  return cache;
}

function buildWithTrusted(
  target: ProductDetailTarget,
  rows: ProductPriceHistoryRow[],
  options: {
    basisByReceipt?: Record<string, 'tax_included' | 'tax_excluded'>;
    monetaryOverrides?: Record<string, Partial<ReceiptMonetaryCoherenceEvidence>>;
  } = {}
) {
  const cache = buildTrustedCache(rows, options.basisByReceipt ?? {});
  if (options.monetaryOverrides) {
    for (const [receiptId, overrides] of Object.entries(
      options.monetaryOverrides
    )) {
      const existing = cache.get(receiptId);
      if (!existing) continue;
      cache.set(receiptId, {
        ...existing,
        monetaryCoherenceEvidence: {
          ...existing.monetaryCoherenceEvidence,
          ...overrides,
        },
      });
    }
  }
  return buildProductPriceHistory(target, rows, { receiptEvidenceCache: cache });
}

const MERCHANT_FIXTURE_NAME = '横浜家系';
const MERCHANT_FIXTURE_KEY = 'ヨークベニマル';

function merchantTrustedG3Row(
  id: string,
  overrides: Partial<ProductPriceHistoryRow> & { grossLineAmount: number }
): ProductPriceHistoryRow {
  const gross = overrides.grossLineAmount;
  return trustedG3Row(id, {
    receiptId: overrides.receiptId ?? `mp-receipt-${id}`,
    itemId: overrides.itemId ?? `mp-item-${id}`,
    sourceIndex: overrides.sourceIndex ?? 0,
    occurredAt: overrides.occurredAt ?? Number(id.replace(/\D/g, '')) * 86_400_000,
    merchantRaw: MERCHANT_FIXTURE_KEY,
    merchantNormalized: MERCHANT_FIXTURE_KEY,
    displayName: MERCHANT_FIXTURE_NAME,
    purchaseQuantity: overrides.purchaseQuantity ?? 1,
    lineTotal: overrides.lineTotal ?? gross,
    ...overrides,
  });
}

function resolveFixtureMerchantProductId(): string {
  const store = createMemoryProductIdentityStore();
  const link = resolveReceiptItemIdentity(
    {
      rawName: MERCHANT_FIXTURE_NAME,
      merchantKey: MERCHANT_FIXTURE_KEY,
      receiptId: 'mp-seed-receipt',
      itemSourceIndex: 0,
    },
    store
  ).link;
  expect(link.merchantProductId).toBeTruthy();
  return link.merchantProductId!;
}

function merchantProductHistoryDb(
  rows: ProductPriceHistoryRow[]
): ProductPriceHistoryDatabase {
  return {
    async getAllAsync<T>() {
      return rows as T[];
    },
  };
}

describe('G3-2A merchant_product production path', () => {
  async function runMerchantProductPriceHistory(
    rows: ProductPriceHistoryRow[],
    merchantProductId: string
  ) {
    jest.resetModules();
    jest.doMock('./env', () => ({
      isProductIdentityPriceHistoryV1Enabled: () => true,
    }));
    const { loadProductPriceHistoryWithDb: load } = await import(
      './productPriceHistory'
    );
    const result = await load(
      merchantProductHistoryDb(rows),
      { type: 'merchant_product', key: merchantProductId }
    );
    jest.dontMock('./env');
    jest.resetModules();
    return result;
  }

  it('merchant_product uses same-target gross peers to exclude anomalies before readiness', async () => {
    const merchantProductId = resolveFixtureMerchantProductId();
    const rows = [
      merchantTrustedG3Row('1', {
        grossLineAmount: 100,
        lineTotal: 100,
        itemId: 'mp-item-a',
        receiptId: 'mp-receipt-a',
        sourceIndex: 0,
      }),
      merchantTrustedG3Row('2', {
        grossLineAmount: 100,
        lineTotal: 100,
        itemId: 'mp-item-b',
        receiptId: 'mp-receipt-b',
        sourceIndex: 0,
      }),
      merchantTrustedG3Row('3', {
        grossLineAmount: 100,
        lineTotal: 100,
        itemId: 'mp-item-c',
        receiptId: 'mp-receipt-c',
        sourceIndex: 0,
      }),
      merchantTrustedG3Row('4', {
        grossLineAmount: 200,
        lineTotal: 100,
        itemId: 'mp-item-d',
        receiptId: 'mp-receipt-d',
        sourceIndex: 1,
      }),
    ];

    expect(new Set(rows.map((row) => row.itemId)).size).toBe(4);

    jest.resetModules();
    jest.doMock('./env', () => ({
      isProductIdentityPriceHistoryV1Enabled: () => true,
    }));
    const { tryBuildIdentityPriceHistoryForRows } = await import(
      './productIdentityConsumer'
    );
    const identityView = tryBuildIdentityPriceHistoryForRows(rows, merchantProductId);
    jest.dontMock('./env');
    jest.resetModules();

    expect(identityView?.merchantProductId).toBe(merchantProductId);
    expect(identityView?.historyPoints).toHaveLength(4);

    const result = await runMerchantProductPriceHistory(rows, merchantProductId);

    expect(result.target).toEqual({
      type: 'merchant_product',
      key: merchantProductId,
    });
    expect(result.identityPresentation?.merchantProductId).toBe(merchantProductId);
    expect(result.observations).toHaveLength(4);

    const outlier = result.observations.find(
      (observation) => observation.itemId === 'mp-item-d'
    );
    expect(outlier?.qualityLevel).toBe('suspected_anomaly');
    expect(outlier?.level2Eligible).toBe(false);
    expect(outlier?.level2RejectReasons).toContain(
      'price_quality_suspected_anomaly'
    );

    expect(result.status).toBe('ready');
    expect(result.seriesKind).toBe('gross');
    expect(result.amountBasis).toBe('tax_included');
    expect(result.points).toHaveLength(3);
    expect(result.points.every((point) => point.priceValue === 100)).toBe(true);
    expect(result.points.every((point) => point.grossLineAmount === 100)).toBe(
      true
    );
    expect(result.points.every((point) => point.lineTotal === point.grossLineAmount)).toBe(
      true
    );
    expect(result.points.some((point) => point.itemId === 'mp-item-d')).toBe(
      false
    );
  });

  it('merchant_product identity cannot promote legacy line-total-only rows to comparable points', async () => {
    const merchantProductId = resolveFixtureMerchantProductId();
    const rows = [
      merchantTrustedG3Row('1', {
        grossLineAmount: 100,
        itemId: 'legacy-mp-a',
        receiptId: 'legacy-mp-receipt-a',
      }),
      merchantTrustedG3Row('2', {
        grossLineAmount: 100,
        itemId: 'legacy-mp-b',
        receiptId: 'legacy-mp-receipt-b',
      }),
      merchantTrustedG3Row('3', {
        grossLineAmount: 100,
        itemId: 'legacy-mp-c',
        receiptId: 'legacy-mp-receipt-c',
      }),
      row('legacy-only', {
        receiptId: 'legacy-mp-receipt-d',
        itemId: 'legacy-mp-d',
        sourceIndex: 0,
        occurredAt: 4 * 86_400_000,
        merchantRaw: MERCHANT_FIXTURE_KEY,
        merchantNormalized: MERCHANT_FIXTURE_KEY,
        displayName: MERCHANT_FIXTURE_NAME,
        currency: 'JPY',
        lineTotal: 100,
        purchaseQuantity: 1,
        grossLineAmount: null,
        priceObservationVersion: null,
        itemAmountEvidenceState: null,
      }),
    ];

    const result = await runMerchantProductPriceHistory(rows, merchantProductId);

    const legacy = result.observations.find(
      (observation) => observation.itemId === 'legacy-mp-d'
    );
    expect(legacy?.level2Eligible).toBe(false);
    expect(legacy?.level2RejectReasons).toContain('legacy_unbackfilled');
    expect(result.points.some((point) => point.itemId === 'legacy-mp-d')).toBe(
      false
    );
    expect(result.status).toBe('ready');
    expect(result.points).toHaveLength(3);
  });
});

describe('SKU price history', () => {
  it('uses purchase-unit gross prices for the exact SKU', () => {
    const rows = [
      trustedG3Row('1', { lineTotal: 238, grossLineAmount: 238 }),
      trustedG3Row('2', { lineTotal: 248, grossLineAmount: 248 }),
    ];
    const result = buildWithTrusted({ type: 'sku', key: 'meiji-900' }, rows);

    expect(result.status).toBe('ready');
    expect(result.seriesKind).toBe('gross');
    expect(result.priceKind).toBe('purchase_unit');
    expect(result.points.map((point) => point.priceValue)).toEqual([238, 248]);
    expect(result.points.every((point) => point.lineTotal === point.grossLineAmount)).toBe(
      true
    );
  });

  it('divides gross amount by purchase quantity defensively', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'meiji-900' },
      [
        trustedG3Row('1', {
          grossLineAmount: 476,
          lineTotal: 388,
          purchaseQuantity: 2,
        }),
        trustedG3Row('2', { grossLineAmount: 238, lineTotal: 238 }),
      ]
    );

    expect(result.points.map((point) => point.priceValue)).toEqual([238, 238]);
  });
});

describe('canonical normalized price history', () => {
  it('normalizes compatible volume variants to price per liter', () => {
    const result = buildWithTrusted(
      { type: 'canonical', key: '明治 おいしい牛乳' },
      [
        trustedG3Row('1', {
          grossLineAmount: 238,
          volumeBaseMl: 900,
          productFamilyKey: 'milk',
        }),
        trustedG3Row('2', {
          grossLineAmount: 138,
          volumeBaseMl: 450,
          productFamilyKey: 'milk',
        }),
      ]
    );

    expect(result.status).toBe('ready');
    expect(result.priceKind).toBe('per_liter');
    expect(result.points[0].priceValue).toBeCloseTo(264.44, 2);
    expect(result.points[1].priceValue).toBeCloseTo(306.67, 2);
  });

  it('refuses to combine conflicting dimensions', () => {
    const result = buildWithTrusted(
      { type: 'canonical', key: 'ambiguous product' },
      [
        trustedG3Row('1', { volumeBaseMl: 900 }),
        trustedG3Row('2', { weightBaseG: 450 }),
      ]
    );

    expect(result.status).toBe('ambiguous_dimension');
    expect(result.points).toEqual([]);
    expect(result.excludedOccurrenceCount).toBe(2);
  });

  it('does not treat an unvalidated numeric name fragment as specification', () => {
    const result = buildWithTrusted(
      { type: 'canonical', key: '午後の紅茶' },
      [
        trustedG3Row('1', { displayName: '午後の紅茶 500' }),
        trustedG3Row('2', { displayName: '午後の紅茶 500' }),
      ]
    );

    expect(result.status).toBe('no_comparable_spec');
  });
});

describe('family allowlist and formulas', () => {
  it('normalizes milk brands by volume only', () => {
    const result = buildWithTrusted(
      { type: 'family', key: 'milk' },
      [
        trustedG3Row('1', { grossLineAmount: 238, volumeBaseMl: 900, productFamilyKey: 'milk' }),
        trustedG3Row('2', { grossLineAmount: 248, volumeBaseMl: 1000, productFamilyKey: 'milk' }),
        trustedG3Row('3', { grossLineAmount: 218, volumeBaseMl: 1000, productFamilyKey: 'milk' }),
      ]
    );

    expect(result.status).toBe('ready');
    expect(result.points.map((point) => point.priceValue)).toEqual([
      expect.closeTo(264.44, 2),
      248,
      218,
    ]);
  });

  it('uses total multipack volume and purchase quantity', () => {
    const result = buildWithTrusted(
      { type: 'family', key: 'water' },
      [
        trustedG3Row('1', {
          grossLineAmount: 1200,
          purchaseQuantity: 2,
          volumeBaseMl: 3000,
          productFamilyKey: 'water',
        }),
        trustedG3Row('2', {
          grossLineAmount: 600,
          volumeBaseMl: 3000,
          productFamilyKey: 'water',
        }),
      ]
    );

    expect(result.points.map((point) => point.priceValue)).toEqual([200, 200]);
  });

  it('normalizes eggs per individual item across multiple boxes', () => {
    const result = buildWithTrusted(
      { type: 'family', key: 'eggs' },
      [
        trustedG3Row('1', {
          grossLineAmount: 250,
          countBase: 10,
          productFamilyKey: 'eggs',
        }),
        trustedG3Row('2', {
          grossLineAmount: 500,
          purchaseQuantity: 2,
          countBase: 10,
          productFamilyKey: 'eggs',
        }),
      ]
    );

    expect(result.priceKind).toBe('per_item');
    expect(result.points.map((point) => point.priceValue)).toEqual([25, 25]);
  });

  it('normalizes rice per 100 grams', () => {
    const result = buildWithTrusted(
      { type: 'family', key: 'rice' },
      [
        trustedG3Row('1', {
          grossLineAmount: 2000,
          weightBaseG: 5000,
          productFamilyKey: 'rice',
        }),
        trustedG3Row('2', {
          grossLineAmount: 4000,
          purchaseQuantity: 2,
          weightBaseG: 5000,
          productFamilyKey: 'rice',
        }),
      ]
    );

    expect(result.priceKind).toBe('per_100g');
    expect(result.points.map((point) => point.priceValue)).toEqual([40, 40]);
  });

  it.each(['tofu', 'yogurt', 'bread', 'onigiri', 'bento'])(
    'does not compare unsupported family %s',
    (family) => {
      const result = buildWithTrusted(
        { type: 'family', key: family },
        [trustedG3Row('1', { weightBaseG: 100 }), trustedG3Row('2', { weightBaseG: 100 })]
      );
      expect(result.status).toBe('unsupported_family');
      expect(result.points).toEqual([]);
    }
  );

  it('accepts coffee volume and excludes coffee weight', () => {
    const result = buildWithTrusted(
      { type: 'family', key: 'coffee' },
      [
        trustedG3Row('1', {
          grossLineAmount: 120,
          volumeBaseMl: 185,
          productFamilyKey: 'coffee',
        }),
        trustedG3Row('2', {
          grossLineAmount: 130,
          volumeBaseMl: 185,
          productFamilyKey: 'coffee',
        }),
        trustedG3Row('3', {
          grossLineAmount: 140,
          weightBaseG: 185,
          productFamilyKey: 'coffee',
        }),
      ]
    );

    expect(result.status).toBe('ready');
    expect(result.comparableOccurrenceCount).toBe(2);
    expect(result.excludedOccurrenceCount).toBe(1);
    expect(result.points.every((point) => point.priceKind === 'per_liter')).toBe(
      true
    );
  });
});

describe('currency, validity, coverage, and ordering', () => {
  it('never combines multiple currencies', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        trustedG3Row('1', { currency: 'JPY' }),
        trustedG3Row('2', { currency: 'USD' }),
      ]
    );

    expect(result.status).toBe('not_enough_points');
    expect(result.points.length).toBeLessThan(2);
  });

  it('does not default missing or unknown currency to JPY', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        trustedG3Row('1', { currency: null }),
        trustedG3Row('2', { currency: 'unknown' }),
      ]
    );

    expect(result.status).toBe('unknown_currency');
    expect(result.currency).toBeNull();
    expect(result.points).toEqual([]);
  });

  it('requires two comparable points and reports excluded occurrences', () => {
    const result = buildWithTrusted(
      { type: 'family', key: 'milk' },
      [
        trustedG3Row('5', { occurredAt: 500, volumeBaseMl: 1000, grossLineAmount: 200 }),
        trustedG3Row('1', { occurredAt: 100, volumeBaseMl: 0 }),
        trustedG3Row('2', { occurredAt: 200, grossLineAmount: 0, volumeBaseMl: 1000 }),
      ]
    );

    expect(result.status).toBe('not_enough_points');
    expect(result.comparableOccurrenceCount).toBe(1);
    expect(result.excludedOccurrenceCount).toBe(2);
  });

  it('excludes zero, negative, and non-finite gross amounts and quantities', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        trustedG3Row('1', { grossLineAmount: 238 }),
        trustedG3Row('2', { grossLineAmount: 248 }),
        trustedG3Row('3', { grossLineAmount: -1 }),
        trustedG3Row('4', { grossLineAmount: Number.NaN }),
        trustedG3Row('5', { purchaseQuantity: 0 }),
      ]
    );

    expect(result.status).toBe('ready');
    expect(result.comparableOccurrenceCount).toBe(2);
    expect(result.excludedOccurrenceCount).toBe(3);
  });

  it('orders every occurrence chronologically without daily aggregation', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        trustedG3Row('3', { occurredAt: 300 }),
        trustedG3Row('2', { occurredAt: 100, receiptId: 'receipt-b' }),
        trustedG3Row('1', { occurredAt: 100, receiptId: 'receipt-a' }),
      ]
    );

    expect(result.points.map((point) => point.receiptId)).toEqual([
      'receipt-a',
      'receipt-b',
      'receipt-3',
    ]);
  });
});

describe('Price History query safety', () => {
  it('uses the exact target filter, bound params, INNER JOIN, and G3 SQL aliases', async () => {
    const calls: { source: string; params: SQLite.SQLiteBindParams }[] = [];
    const db: ProductPriceHistoryDatabase = {
      async getAllAsync<T>(source: string, params: SQLite.SQLiteBindParams) {
        calls.push({ source, params });
        return [
          trustedG3Row('1', { grossLineAmount: 238 }),
          trustedG3Row('2', { grossLineAmount: 248 }),
        ] as T[];
      },
    };

    const result = await loadProductPriceHistoryWithDb(db, {
      type: 'sku',
      key: 'meiji-900',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].source).toMatch(
      /FROM receipt_items\s+INNER JOIN receipts/i
    );
    expect(calls[0].source).toMatch(/receipt_items\.sku_key = \?/i);
    expect(calls[0].source).toMatch(
      /receipt_items\.gross_line_amount AS grossLineAmount/i
    );
    expect(calls[0].source).toMatch(
      /receipt_items\.effective_line_amount AS effectiveLineAmount/i
    );
    expect(calls[0].source).toMatch(
      /receipt_items\.discount_allocated AS discountAllocated/i
    );
    expect(calls[0].source).toMatch(
      /receipt_items\.amount_provenance AS amountProvenance/i
    );
    expect(calls[0].source).toMatch(
      /receipt_items\.item_amount_evidence_state AS itemAmountEvidenceState/i
    );
    expect(calls[0].source).toMatch(
      /receipt_items\.promo_markers_json AS promoMarkersJson/i
    );
    expect(calls[0].source).toMatch(
      /receipt_items\.evidence_capture_version AS evidenceCaptureVersion/i
    );
    expect(calls[0].source).toMatch(
      /receipt_items\.price_observation_version AS priceObservationVersion/i
    );
    expect(calls[0].source).toMatch(/receipts\.analysis_json AS receiptAnalysisJson/i);
    expect(calls[0].source).toMatch(
      /receipts\.user_items_json AS receiptUserItemsJson/i
    );
    expect(calls[0].source).not.toMatch(/purchase_unit_price/i);
    expect(calls[0].params).toEqual(['meiji-900']);
    expect(result.observations.length).toBe(2);
  });

  it.each([
    ['canonical', '明治 おいしい牛乳', /canonical_product_name = \?/i],
    ['family', 'milk', /product_family_key = \?/i],
  ] as const)(
    'uses a bound exact filter for %s targets',
    async (type, key, expectedFilter) => {
      const calls: { source: string; params: SQLite.SQLiteBindParams }[] = [];
      const db: ProductPriceHistoryDatabase = {
        async getAllAsync<T>(source: string, params: SQLite.SQLiteBindParams) {
          calls.push({ source, params });
          return [] as T[];
        },
      };

      await loadProductPriceHistoryWithDb(db, { type, key });
      expect(calls[0].source).toMatch(expectedFilter);
      expect(calls[0].params).toEqual([key]);
    }
  );

  it('models orphan exclusion at the INNER JOIN boundary', async () => {
    const joinedReceiptIds = new Set(['receipt-1', 'receipt-2']);
    const indexedRows = [
      trustedG3Row('1', { grossLineAmount: 238 }),
      trustedG3Row('2', { grossLineAmount: 248 }),
      trustedG3Row('orphan', {
        receiptId: 'missing-receipt',
        grossLineAmount: 9999,
      }),
    ];
    const db: ProductPriceHistoryDatabase = {
      async getAllAsync<T>(source: string) {
        expect(source).toMatch(/INNER JOIN receipts/i);
        return indexedRows.filter((item) =>
          joinedReceiptIds.has(item.receiptId)
        ) as T[];
      },
    };

    const result = await loadProductPriceHistoryWithDb(db, {
      type: 'sku',
      key: 'sku',
    });
    expect(result.totalOccurrenceCount).toBe(2);
    expect(result.observations).toHaveLength(2);
  });

  it('memoizes receipt monetary evidence once per receipt', () => {
    const rows = [
      trustedG3Row('1', { receiptId: 'shared', sourceIndex: 0 }),
      trustedG3Row('2', { receiptId: 'shared', sourceIndex: 1, grossLineAmount: 120 }),
    ];
    const cache = buildReceiptEvidenceCache(rows);
    expect(cache.size).toBe(1);
    expect(cache.has('shared')).toBe(true);
  });
});

describe('M1-B multipack unit price contract', () => {
  it('500ml×6 ¥600 → ¥200/L (M)', () => {
    const result = buildWithTrusted(
      { type: 'family', key: 'water' },
      [
        trustedG3Row('1', {
          grossLineAmount: 600,
          purchaseQuantity: 1,
          volumeBaseMl: 3000,
          productFamilyKey: 'water',
        }),
        trustedG3Row('2', {
          grossLineAmount: 600,
          purchaseQuantity: 1,
          volumeBaseMl: 3000,
          productFamilyKey: 'water',
        }),
      ]
    );
    expect(result.status).toBe('ready');
    expect(result.points.map((point) => point.priceValue)).toEqual([200, 200]);
  });

  it('qty=2 with gross for both units is not double-divided (L)', () => {
    const result = buildWithTrusted(
      { type: 'family', key: 'water' },
      [
        trustedG3Row('1', {
          grossLineAmount: 200,
          purchaseQuantity: 2,
          volumeBaseMl: 500,
          productFamilyKey: 'water',
        }),
        trustedG3Row('2', {
          grossLineAmount: 100,
          purchaseQuantity: 1,
          volumeBaseMl: 500,
          productFamilyKey: 'water',
        }),
      ]
    );
    expect(result.points.map((point) => point.priceValue)).toEqual([200, 200]);
  });
});

describe('G3-2A comparable gross gates', () => {
  it('CASE 1 — coherent gross observation becomes Level-2 gross point', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        trustedG3Row('1', {
          grossLineAmount: 439,
          effectiveLineAmount: 439,
        }),
      ]
    );
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].level2Eligible).toBe(true);
    expect(result.status).not.toBe('ready');
    const two = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        trustedG3Row('1', { grossLineAmount: 439, effectiveLineAmount: 439 }),
        trustedG3Row('2', { grossLineAmount: 439, effectiveLineAmount: 439 }),
      ]
    );
    expect(two.status).toBe('ready');
    expect(two.points[0].priceValue).toBe(439);
    expect(two.points[0].grossLineAmount).toBe(439);
  });

  it('CASE 2 — explicit discount charts gross not effective', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        trustedG3Row('1', {
          grossLineAmount: 439,
          effectiveLineAmount: 388,
          discountAllocated: -51,
        }),
        trustedG3Row('2', {
          grossLineAmount: 439,
          effectiveLineAmount: 388,
          discountAllocated: -51,
        }),
      ]
    );
    expect(result.points.map((point) => point.priceValue)).toEqual([439, 439]);
    expect(result.points[0].promoContext).toBe('explicit_discount');
    expect(result.observations[0].effectiveLineAmount).toBe(388);
  });

  it('CASE 3 — qualitative marker without inferred discount', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        trustedG3Row('1', {
          grossLineAmount: 388,
          effectiveLineAmount: 388,
          promoMarkersJson: JSON.stringify(['特']),
        }),
        trustedG3Row('2', {
          grossLineAmount: 388,
          effectiveLineAmount: 388,
          promoMarkersJson: JSON.stringify(['特']),
        }),
      ]
    );
    expect(result.points.map((point) => point.priceValue)).toEqual([388, 388]);
    expect(result.points[0].promoContext).toBe('qualitative_marker');
    expect(result.points[0].promoMarkers).toEqual(['特']);
  });

  it('CASE 4 — promotion ended compares gross 439 -> 439 not effective 406 -> 439', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        trustedG3Row('1', {
          grossLineAmount: 439,
          effectiveLineAmount: 406,
          discountAllocated: -33,
        }),
        trustedG3Row('2', {
          grossLineAmount: 439,
          effectiveLineAmount: 439,
        }),
      ]
    );
    expect(result.points.map((point) => point.priceValue)).toEqual([439, 439]);
  });

  it('CASE 5 — distinct gross observations 397 and 298', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        trustedG3Row('1', { grossLineAmount: 397 }),
        trustedG3Row('2', { grossLineAmount: 298 }),
      ]
    );
    expect(result.points.map((point) => point.priceValue)).toEqual([397, 298]);
  });

  it('CASE 6 — mixed trusted amount bases fail closed', () => {
    const rows = [
      trustedG3Row('1', { receiptId: 'receipt-a', grossLineAmount: 439 }),
      trustedG3Row('2', { receiptId: 'receipt-b', grossLineAmount: 439 }),
    ];
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      rows,
      {
        basisByReceipt: {
          'receipt-a': 'tax_included',
          'receipt-b': 'tax_excluded',
        },
      }
    );
    expect(result.status).not.toBe('ready');
    expect(result.points).toEqual([]);
  });

  it('CASE 7 — untrusted amount basis stays Level-1 only', () => {
    const rows = [
      trustedG3Row('1', { grossLineAmount: 439 }),
      trustedG3Row('2', { grossLineAmount: 298 }),
    ];
    const cache = buildTrustedCache(rows);
    for (const entry of cache.values()) {
      entry.amountBasisAssessment.exactComparisonTrusted = false;
      entry.amountBasisAssessment.basis = 'unknown';
    }
    const result = buildProductPriceHistory(
      { type: 'sku', key: 'sku' },
      rows,
      { receiptEvidenceCache: cache }
    );
    expect(result.status).not.toBe('ready');
    expect(result.points).toEqual([]);
    expect(result.observations.every((obs) => !obs.level2Eligible)).toBe(true);
  });

  it('CASE 8 — gross/qty normalization 525/5 and 508/4', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        trustedG3Row('1', { grossLineAmount: 525, purchaseQuantity: 5 }),
        trustedG3Row('2', { grossLineAmount: 508, purchaseQuantity: 4 }),
      ]
    );
    expect(result.points.map((point) => point.priceValue)).toEqual([105, 127]);
  });

  it('CASE 9 — unresolved receipt coupon excludes Level-2', () => {
    const rows = [
      trustedG3Row('1', { grossLineAmount: 439 }),
      trustedG3Row('2', { grossLineAmount: 298 }),
    ];
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      rows,
      {
        monetaryOverrides: {
          'receipt-1': { discountOwnershipStatus: 'unresolved', state: 'known_incoherent', monetaryProvenanceSufficient: false },
          'receipt-2': { discountOwnershipStatus: 'unresolved', state: 'known_incoherent', monetaryProvenanceSufficient: false },
        },
      }
    );
    expect(result.status).not.toBe('ready');
    expect(result.points).toEqual([]);
    expect(result.observations.some((obs) => obs.grossLineAmount === 439)).toBe(
      true
    );
  });

  it('CASE 10 — user corrected gross-null stays Level-1 only', () => {
    const rows = [
      trustedG3Row('1', {
        grossLineAmount: null,
        effectiveLineAmount: 388,
        lineTotal: 388,
        amountProvenance: 'user_corrected',
        itemAmountEvidenceState: 'selected_only',
      }),
      trustedG3Row('2', {
        grossLineAmount: null,
        effectiveLineAmount: 388,
        lineTotal: 388,
        amountProvenance: 'user_corrected',
        itemAmountEvidenceState: 'selected_only',
      }),
    ];
    const result = buildWithTrusted({ type: 'sku', key: 'sku' }, rows);
    expect(result.status).not.toBe('ready');
    expect(result.points).toEqual([]);
    expect(result.observations[0].effectiveLineAmount).toBe(388);
  });

  it('legacy line_total without G3 truth does not become ready', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'sku' },
      [
        legacyUntrustedRow('1', { lineTotal: 238 }),
        legacyUntrustedRow('2', { lineTotal: 248 }),
      ]
    );
    expect(result.status).not.toBe('ready');
    expect(result.points).toEqual([]);
  });

  it('excludes duplicate receipts before building history', async () => {
    const rows = [
      trustedG3Row('1', { grossLineAmount: 238 }),
      trustedG3Row('2', { grossLineAmount: 248 }),
      trustedG3Row('3', { grossLineAmount: 999, receiptId: 'receipt-dup' }),
    ];
    const db: ProductPriceHistoryDatabase = {
      async getAllAsync<T>() {
        return rows as T[];
      },
    };
    const result = await loadProductPriceHistoryWithDb(
      db,
      { type: 'sku', key: 'sku' },
      { excludedReceiptIds: new Set(['receipt-dup']) }
    );
    expect(result.totalOccurrenceCount).toBe(2);
    expect(result.points.every((point) => point.receiptId !== 'receipt-dup')).toBe(
      true
    );
  });
});

describe('G3-2A Codex blocker regressions', () => {
  it('A: 2 included + 1 excluded fails closed without subset selection', () => {
    const rows = [
      trustedG3Row('1', { receiptId: 'r1', grossLineAmount: 100 }),
      trustedG3Row('2', { receiptId: 'r2', grossLineAmount: 100 }),
      trustedG3Row('3', { receiptId: 'r3', grossLineAmount: 100 }),
    ];
    const result = buildWithTrusted(
      { type: 'sku', key: 'mixed-a' },
      rows,
      {
        basisByReceipt: {
          r1: 'tax_included',
          r2: 'tax_included',
          r3: 'tax_excluded',
        },
      }
    );
    expect(result.status).not.toBe('ready');
    expect(result.points).toEqual([]);
    expect(result.seriesKind).toBeNull();
    expect(result.amountBasis).toBeNull();
  });

  it('B: 2 included + 2 excluded fails closed', () => {
    const rows = [
      trustedG3Row('1', { receiptId: 'r1', grossLineAmount: 100 }),
      trustedG3Row('2', { receiptId: 'r2', grossLineAmount: 100 }),
      trustedG3Row('3', { receiptId: 'r3', grossLineAmount: 100 }),
      trustedG3Row('4', { receiptId: 'r4', grossLineAmount: 100 }),
    ];
    const result = buildWithTrusted(
      { type: 'sku', key: 'mixed-b' },
      rows,
      {
        basisByReceipt: {
          r1: 'tax_included',
          r2: 'tax_included',
          r3: 'tax_excluded',
          r4: 'tax_excluded',
        },
      }
    );
    expect(result.status).not.toBe('ready');
    expect(result.points).toEqual([]);
  });

  it('C: 1 included + 1 excluded fails closed', () => {
    const result = buildWithTrusted(
      { type: 'sku', key: 'mixed-c' },
      [
        trustedG3Row('1', { receiptId: 'r1', grossLineAmount: 100 }),
        trustedG3Row('2', { receiptId: 'r2', grossLineAmount: 100 }),
      ],
      { basisByReceipt: { r1: 'tax_included', r2: 'tax_excluded' } }
    );
    expect(result.status).not.toBe('ready');
    expect(result.points).toEqual([]);
  });

  it('D/E: homogeneous included or excluded basis may become ready', () => {
    const included = buildWithTrusted(
      { type: 'sku', key: 'included-only' },
      [
        trustedG3Row('1', { receiptId: 'r1', grossLineAmount: 100 }),
        trustedG3Row('2', { receiptId: 'r2', grossLineAmount: 110 }),
      ],
      { basisByReceipt: { r1: 'tax_included', r2: 'tax_included' } }
    );
    expect(included.status).toBe('ready');
    expect(included.amountBasis).toBe('tax_included');

    const excluded = buildWithTrusted(
      { type: 'sku', key: 'excluded-only' },
      [
        trustedG3Row('1', { receiptId: 'r1', grossLineAmount: 100 }),
        trustedG3Row('2', { receiptId: 'r2', grossLineAmount: 110 }),
      ],
      { basisByReceipt: { r1: 'tax_excluded', r2: 'tax_excluded' } }
    );
    expect(excluded.status).toBe('ready');
    expect(excluded.amountBasis).toBe('tax_excluded');
  });

  it('trusted G3 rows without injected cache reach ready via real receipt evidence', () => {
    const rows = [
      trustedG3Row('1', {
        receiptId: 'r1',
        displayName: '明治牛乳',
        productFamilyKey: 'milk',
        volumeBaseMl: 1000,
        grossLineAmount: 238,
      }),
      trustedG3Row('2', {
        receiptId: 'r2',
        displayName: '明治牛乳',
        productFamilyKey: 'milk',
        volumeBaseMl: 1000,
        grossLineAmount: 248,
      }),
    ];
    const cache = buildReceiptEvidenceCache(rows);
    const observations = buildObservations(rows, cache);
    const result = buildProductPriceHistory(
      { type: 'canonical', key: '明治牛乳' },
      rows
    );
    expect(result.status).toBe('ready');
    expect(
      observations.every((observation) => observation.level2Eligible)
    ).toBe(true);
  });

  it('legacy line_total-only direct builder fails closed without injected cache', () => {
    const result = buildProductPriceHistory(
      { type: 'sku', key: 'legacy-direct' },
      [
        legacyUntrustedRow('1', { lineTotal: 388, purchaseQuantity: 1 }),
        legacyUntrustedRow('2', { lineTotal: 388, purchaseQuantity: 1 }),
      ]
    );
    expect(result.status).not.toBe('ready');
    expect(result.points).toEqual([]);
  });

  it('E: distinct itemIds in same cohort get real quality peers and exclude outlier', () => {
    const rows = [
      trustedG3Row('1', {
        itemId: 'item-a',
        receiptId: 'r1',
        grossLineAmount: 100,
        purchaseQuantity: 1,
      }),
      trustedG3Row('2', {
        itemId: 'item-b',
        receiptId: 'r2',
        grossLineAmount: 100,
        purchaseQuantity: 1,
      }),
      trustedG3Row('3', {
        itemId: 'item-c',
        receiptId: 'r3',
        grossLineAmount: 100,
        purchaseQuantity: 1,
      }),
      trustedG3Row('4', {
        itemId: 'item-d',
        receiptId: 'r4',
        grossLineAmount: 200,
        purchaseQuantity: 1,
      }),
    ];
    const result = buildWithTrusted({ type: 'sku', key: 'peer-anomaly' }, rows);
    expect(result.points).toHaveLength(3);
    expect(result.points.every((point) => point.priceValue === 100)).toBe(true);
    const outlier = result.observations.find(
      (observation) => observation.grossLineAmount === 200
    );
    expect(outlier?.level2Eligible).toBe(false);
    expect(outlier?.qualityLevel).toBe('suspected_anomaly');
  });

  describe('promo marker read states', () => {
    const baseRow = (): ProductPriceHistoryRow =>
      trustedG3Row('1', {
        evidenceCaptureVersion: 1,
        discountAllocated: 0,
      });

    it.each([
      [null, 'absent'],
      ['', 'invalid'],
      ['   ', 'invalid'],
      ['{bad', 'invalid'],
      ['{}', 'invalid'],
      ['[]', 'invalid'],
      ['[1]', 'invalid'],
      ['[""]', 'invalid'],
      ['["   "]', 'invalid'],
      ['["特", 1]', 'invalid'],
    ] as const)('promoMarkersJson=%s → read state=%s', (promoMarkersJson, expected) => {
      const row = baseRow();
      row.promoMarkersJson = promoMarkersJson;
      expect(readPromoMarkersFromRow(row).state).toBe(expected);
    });

    it('valid marker array resolves to valid read state', () => {
      const row = baseRow();
      row.promoMarkersJson = '["特"]';
      const read = readPromoMarkersFromRow(row);
      expect(read.state).toBe('valid');
      if (read.state === 'valid') {
        expect(read.markers).toEqual(['特']);
      }
      expect(resolvePromoContextFromRow(row)).toBe('qualitative_marker');
    });

    it('duplicate valid markers sanitize normally', () => {
      const row = baseRow();
      row.promoMarkersJson = '["特","特"]';
      expect(readPromoMarkersFromRow(row).state).toBe('valid');
      expect(resolvePromoContextFromRow(row)).toBe('qualitative_marker');
    });

    it('null promo JSON + capture v1 may become none_observed', () => {
      const row = baseRow();
      row.promoMarkersJson = null;
      expect(readPromoMarkersFromRow(row).state).toBe('absent');
      expect(resolvePromoContextFromRow(row)).toBe('none_observed');
    });

    it('malformed present promo JSON resolves promoContext to unknown', () => {
      const row = baseRow();
      row.promoMarkersJson = '[]';
      expect(resolvePromoContextFromRow(row)).toBe('unknown');
    });
  });
});
