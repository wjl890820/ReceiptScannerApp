/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';

import { createEmptyStats } from './analysisHelpers';
import { buildAnalysisReleaseViewModel } from './analysisPresentation';
import {
  buildAnalysisPriceChangeRow,
  buildAnalysisPriceChangesSurface,
  buildAnalysisPriceChangesSurfaceFromRows,
} from './analysisPriceSurfaces';
import {
  ANALYSIS_MERCHANT_PRODUCT_APPROVED_IDENTITY_SOURCES,
  collectAnalysisTrustedPriceChangeCandidates,
  collectSkuCoveredPurchaseEvents,
  discoverSeededMerchantProductIds,
  isAnalysisApprovedMerchantProductHistoryPoint,
  isAnalysisApprovedMerchantProductIdentitySource,
  isMerchantProductDuplicateOfSku,
  merchantProductInterpretationPurchasePointsApproved,
  rankAnalysisTrustedPriceChangeCandidates,
  selectAnalysisTrustedPriceChangeCandidates,
} from './analysisTrustedPriceChanges';
import * as productIdentityResolver from './productIdentityResolver';
import { resolveReceiptItemIdentity } from './productIdentityResolver';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import type { ProductPriceHistoryPoint } from './productPriceHistory';
import {
  makeTrustedG3TestRow,
} from './productPriceHistory.testFixtures';

const SKU_A = 'analysis-sku-a';
const SKU_B = 'analysis-sku-b';
const MS_DAY = 86_400_000;
const MP_PRODUCT_NAME = '横浜家系';
const MP_MERCHANT_A = 'ヨークベニマル';
const MP_MERCHANT_B = 'イオン';

function trustedSkuRow(
  id: string,
  skuKey: string,
  gross: number,
  overrides: Partial<ReturnType<typeof makeTrustedG3TestRow>> = {}
) {
  return makeTrustedG3TestRow(id, {
    skuKey,
    grossLineAmount: gross,
    lineTotal: gross,
    purchaseQuantity: 1,
    displayName: overrides.displayName ?? `Product ${skuKey}`,
    receiptId: overrides.receiptId ?? `receipt-${id}`,
    occurredAt: overrides.occurredAt ?? Number(id.replace(/\D/g, '')) * MS_DAY,
    ...overrides,
  });
}

function merchantTrustedRow(
  id: string,
  gross: number,
  overrides: Partial<ReturnType<typeof makeTrustedG3TestRow>> & {
    merchantKey?: string;
  } = {}
) {
  const merchantKey = overrides.merchantKey ?? MP_MERCHANT_A;
  return makeTrustedG3TestRow(id, {
    grossLineAmount: gross,
    lineTotal: gross,
    purchaseQuantity: 1,
    displayName: overrides.displayName ?? MP_PRODUCT_NAME,
    merchantRaw: merchantKey,
    merchantNormalized: merchantKey,
    receiptId: overrides.receiptId ?? `mp-receipt-${id}`,
    occurredAt: overrides.occurredAt ?? Number(id.replace(/\D/g, '')) * MS_DAY,
    skuKey: null,
    productFamilyKey: null,
    ...overrides,
  });
}

function resolveMerchantProductId(
  displayName: string,
  merchantKey: string
): string {
  const store = createMemoryProductIdentityStore();
  const link = resolveReceiptItemIdentity(
    {
      rawName: displayName,
      merchantKey,
      receiptId: 'mp-seed',
      itemSourceIndex: 0,
    },
    store
  ).link;
  expect(link.merchantProductId).toBeTruthy();
  return link.merchantProductId!;
}

function mpTrustedHistoryPoint(
  receiptId: string,
  overrides: Partial<ProductPriceHistoryPoint> = {}
): ProductPriceHistoryPoint {
  return {
    receiptId,
    itemId: `item-${receiptId}`,
    sourceIndex: 0,
    occurredAt: 1,
    merchantRaw: MP_MERCHANT_A,
    merchantNormalized: MP_MERCHANT_A,
    displayName: MP_PRODUCT_NAME,
    currency: 'JPY',
    lineTotal: 100,
    purchaseQuantity: 1,
    priceValue: 100,
    priceKind: 'purchase_unit',
    seriesKind: 'gross',
    grossLineAmount: 100,
    amountBasis: 'tax_included',
    qualityLevel: 'trusted',
    merchantProductId: 'mp_test',
    identityLevel: 'merchant_product',
    merchantScopeKey: MP_MERCHANT_A,
    identitySource: 'normalized_exact',
    ...overrides,
  };
}

describe('analysisTrustedPriceChanges', () => {
  it('surfaces trusted comparable price increase', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, {
        receiptId: 'r1',
        occurredAt: 1 * MS_DAY,
        displayName: 'Milk',
      }),
      trustedSkuRow('2', SKU_A, 150, {
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
        displayName: 'Milk',
      }),
    ];
    const surface = buildAnalysisPriceChangesSurfaceFromRows({
      rows,
      seedReceiptIds: new Set(['r2']),
    });
    expect(surface.status).toBe('available');
    if (surface.status === 'available') {
      expect(surface.items[0]).toMatchObject({
        displayName: 'Milk',
        direction: 'up',
        deltaAmount: 50,
        currency: 'JPY',
        targetType: 'sku',
        targetKey: SKU_A,
      });
    }
  });

  it('surfaces trusted comparable price decrease', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 200, {
        receiptId: 'r1',
        occurredAt: 1 * MS_DAY,
        displayName: 'Eggs',
      }),
      trustedSkuRow('2', SKU_A, 150, {
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
        displayName: 'Eggs',
      }),
    ];
    const surface = buildAnalysisPriceChangesSurfaceFromRows({
      rows,
      seedReceiptIds: new Set(['r2']),
    });
    expect(surface.status).toBe('available');
    if (surface.status === 'available') {
      expect(surface.items[0]?.direction).toBe('down');
      expect(surface.items[0]?.deltaAmount).toBe(50);
    }
  });

  it('returns unavailable with insufficient observations', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1' }),
    ];
    expect(
      buildAnalysisPriceChangesSurfaceFromRows({
        rows,
        seedReceiptIds: new Set(['r1']),
      })
    ).toEqual({ status: 'unavailable' });
  });

  it('rejects suspected anomaly observations', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1', occurredAt: MS_DAY }),
      trustedSkuRow('2', SKU_A, 500, {
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
      }),
    ];
    const surface = buildAnalysisPriceChangesSurface(
      collectAnalysisTrustedPriceChangeCandidates({
        rows,
        seedReceiptIds: new Set(['r2']),
        interpretChange: () => ({
          status: 'unavailable',
          reasonCodes: ['quality_not_trusted'],
        }),
      })
    );
    expect(surface.status).toBe('unavailable');
  });

  it('rejects currency mismatch observations', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, {
        receiptId: 'r1',
        currency: 'JPY',
        receiptCurrency: 'JPY',
      }),
      trustedSkuRow('2', SKU_A, 150, {
        receiptId: 'r2',
        currency: 'USD',
        receiptCurrency: 'USD',
      }),
    ];
    expect(
      buildAnalysisPriceChangesSurfaceFromRows({
        rows,
        seedReceiptIds: new Set(['r2']),
      }).status
    ).toBe('unavailable');
  });

  it('rejects incompatible quantity observations', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, {
        receiptId: 'r1',
        purchaseQuantity: 1,
      }),
      trustedSkuRow('2', SKU_A, 200, {
        receiptId: 'r2',
        purchaseQuantity: 0,
      }),
    ];
    expect(
      buildAnalysisPriceChangesSurfaceFromRows({
        rows,
        seedReceiptIds: new Set(['r2']),
      }).status
    ).toBe('unavailable');
  });

  it('rejects duplicate-scan observations when duplicate selection is unconfirmed', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1', occurredAt: MS_DAY }),
      trustedSkuRow('2', SKU_A, 150, { receiptId: 'r2', occurredAt: 2 * MS_DAY }),
    ];
    expect(
      buildAnalysisPriceChangesSurfaceFromRows({
        rows,
        seedReceiptIds: new Set(['r2']),
        canonicalDuplicateSelectionApplied: false,
      }).status
    ).toBe('unavailable');
  });

  it('does not claim exact price change for family-only identity rows', () => {
    const rows = [
      makeTrustedG3TestRow('1', {
        productFamilyKey: 'milk',
        grossLineAmount: 100,
        lineTotal: 100,
        receiptId: 'r1',
        occurredAt: MS_DAY,
      }),
      makeTrustedG3TestRow('2', {
        productFamilyKey: 'milk',
        grossLineAmount: 150,
        lineTotal: 150,
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
      }),
    ];
    expect(
      buildAnalysisPriceChangesSurfaceFromRows({
        rows,
        seedReceiptIds: new Set(['r2']),
      })
    ).toEqual({ status: 'unavailable' });
  });

  it('ranks by absolute delta, then recency, deterministically', () => {
    const rowsA = [
      trustedSkuRow('a1', SKU_A, 100, {
        receiptId: 'ra1',
        occurredAt: MS_DAY,
        displayName: 'Small change',
      }),
      trustedSkuRow('a2', SKU_A, 130, {
        receiptId: 'ra2',
        occurredAt: 10 * MS_DAY,
        displayName: 'Small change',
      }),
    ];
    const rowsB = [
      trustedSkuRow('b1', SKU_B, 100, {
        receiptId: 'rb1',
        occurredAt: MS_DAY,
        displayName: 'Large change',
      }),
      trustedSkuRow('b2', SKU_B, 250, {
        receiptId: 'rb2',
        occurredAt: 5 * MS_DAY,
        displayName: 'Large change',
      }),
    ];
    const surface = buildAnalysisPriceChangesSurfaceFromRows({
      rows: [...rowsA, ...rowsB],
      seedReceiptIds: new Set(['ra2', 'rb2']),
      limit: 2,
    });
    expect(surface.status).toBe('available');
    if (surface.status === 'available') {
      expect(surface.items.map((item) => item.displayName)).toEqual([
        'Large change',
        'Small change',
      ]);
    }
  });

  it('delegates comparison to interpretProductPriceChange', () => {
    const interpretChange = jest.fn(() => ({
      status: 'unavailable' as const,
      reasonCodes: ['history_not_ready' as const],
    }));
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1' }),
      trustedSkuRow('2', SKU_A, 150, { receiptId: 'r2' }),
    ];
    collectAnalysisTrustedPriceChangeCandidates({
      rows,
      seedReceiptIds: new Set(['r2']),
      interpretChange,
    });
    expect(interpretChange).toHaveBeenCalled();
  });

  it('preserves promo transition via resolveProductPriceChangePresentation', () => {
    const candidate = {
      target: { type: 'sku' as const, key: SKU_A },
      displayName: 'Milk',
      interpretation: {
        status: 'available' as const,
        grossDelta: 50,
        grossDirection: 'increased' as const,
        promoTransition: 'ended' as const,
        current: { occurredAt: 2, currency: 'JPY' },
      },
      comparableOccurrenceCount: 2,
      latestOccurredAt: 2,
    } as any;
    expect(buildAnalysisPriceChangeRow(candidate)).toMatchObject({
      direction: 'up',
      deltaAmount: 50,
      promoBodyKey: 'priceHistory.promo.ended',
    });
  });

  it('surfaces promo started alongside purchase price increase', () => {
    const interpretChange = jest.fn(() => ({
      status: 'available' as const,
      grossDelta: 20,
      grossDirection: 'increased' as const,
      promoTransition: 'started' as const,
      current: { occurredAt: 2 * MS_DAY, currency: 'JPY', receiptId: 'r2' },
      previous: { occurredAt: MS_DAY, currency: 'JPY', receiptId: 'r1' },
    }));
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1', occurredAt: MS_DAY }),
      trustedSkuRow('2', SKU_A, 120, { receiptId: 'r2', occurredAt: 2 * MS_DAY }),
    ];
    const surface = buildAnalysisPriceChangesSurface(
      collectAnalysisTrustedPriceChangeCandidates({
        rows,
        seedReceiptIds: new Set(['r2']),
        interpretChange: interpretChange as any,
      })
    );
    expect(surface.status).toBe('available');
    if (surface.status === 'available') {
      expect(surface.items[0]?.promoBodyKey).toBe('priceHistory.promo.started');
    }
  });

  it('skips SKUs when candidate construction throws', () => {
    const buildHistory = jest.fn(() => {
      throw new Error('history build failed');
    });
    const rows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'r1' }),
      trustedSkuRow('2', SKU_A, 150, { receiptId: 'r2' }),
    ];
    expect(
      collectAnalysisTrustedPriceChangeCandidates({
        rows,
        seedReceiptIds: new Set(['r2']),
        buildHistory,
      })
    ).toEqual([]);
  });

  it('excludes foreign-owner seed rows from candidate discovery', () => {
    const ownRows = [
      trustedSkuRow('1', SKU_A, 100, { receiptId: 'own-1' }),
      trustedSkuRow('2', SKU_A, 150, { receiptId: 'own-2' }),
    ];
    const foreignOnlySeed = new Set(['foreign-1']);
    expect(
      collectAnalysisTrustedPriceChangeCandidates({
        rows: ownRows,
        seedReceiptIds: foreignOnlySeed,
      })
    ).toEqual([]);
  });
});

describe('analysisTrustedPriceChanges merchant_product bridge', () => {
  it('surfaces merchant_product candidate when sku keys are absent', () => {
    const rows = [
      merchantTrustedRow('1', 100, {
        receiptId: 'r1',
        occurredAt: MS_DAY,
      }),
      merchantTrustedRow('2', 120, {
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
      }),
    ];
    const surface = buildAnalysisPriceChangesSurfaceFromRows({
      rows,
      seedReceiptIds: new Set(['r2']),
    });
    expect(surface.status).toBe('available');
    if (surface.status === 'available') {
      expect(surface.items[0]).toMatchObject({
        direction: 'up',
        deltaAmount: 20,
        targetType: 'merchant_product',
      });
    }
  });

  it('rejects merchant_product candidate when interpretation is unavailable', () => {
    const interpretChange = jest.fn(() => ({
      status: 'unavailable' as const,
      reasonCodes: ['quality_not_trusted' as const],
    }));
    const rows = [
      merchantTrustedRow('1', 100, { receiptId: 'r1', occurredAt: MS_DAY }),
      merchantTrustedRow('2', 100, { receiptId: 'r2', occurredAt: MS_DAY }),
      merchantTrustedRow('3', 100, { receiptId: 'r3', occurredAt: MS_DAY }),
      merchantTrustedRow('4', 150, { receiptId: 'r4', occurredAt: 2 * MS_DAY }),
    ];
    expect(
      buildAnalysisPriceChangesSurface(
        collectAnalysisTrustedPriceChangeCandidates({
          rows,
          seedReceiptIds: new Set(['r4']),
          interpretChange: interpretChange as any,
        })
      ).status
    ).toBe('unavailable');
  });

  it('rejects merchant_product candidate when history quality gate fails', () => {
    const rows = [
      merchantTrustedRow('1', 100, { receiptId: 'r1', occurredAt: MS_DAY }),
      makeTrustedG3TestRow('2', {
        lineTotal: 100,
        purchaseQuantity: 1,
        displayName: MP_PRODUCT_NAME,
        merchantRaw: MP_MERCHANT_A,
        merchantNormalized: MP_MERCHANT_A,
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
        skuKey: null,
        grossLineAmount: null,
        priceObservationVersion: null,
        itemAmountEvidenceState: null,
      }),
    ];
    expect(
      buildAnalysisPriceChangesSurfaceFromRows({
        rows,
        seedReceiptIds: new Set(['r2']),
      }).status
    ).toBe('unavailable');
  });

  it('prefers sku candidate over duplicate merchant_product representation', () => {
    const rows = [
      trustedSkuRow('1', SKU_A, 100, {
        receiptId: 'r1',
        occurredAt: MS_DAY,
        displayName: MP_PRODUCT_NAME,
        merchantRaw: MP_MERCHANT_A,
        merchantNormalized: MP_MERCHANT_A,
      }),
      trustedSkuRow('2', SKU_A, 150, {
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
        displayName: MP_PRODUCT_NAME,
        merchantRaw: MP_MERCHANT_A,
        merchantNormalized: MP_MERCHANT_A,
      }),
    ];
    const candidates = collectAnalysisTrustedPriceChangeCandidates({
      rows,
      seedReceiptIds: new Set(['r2']),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.target).toEqual({ type: 'sku', key: SKU_A });
  });

  it('does not merge same-looking names across different merchants', () => {
    const rows = [
      merchantTrustedRow('a1', 100, {
        receiptId: 'ra1',
        occurredAt: MS_DAY,
        merchantKey: MP_MERCHANT_A,
        displayName: 'Milk',
      }),
      merchantTrustedRow('a2', 120, {
        receiptId: 'ra2',
        occurredAt: 2 * MS_DAY,
        merchantKey: MP_MERCHANT_A,
        displayName: 'Milk',
      }),
      merchantTrustedRow('b1', 100, {
        receiptId: 'rb1',
        occurredAt: MS_DAY,
        merchantKey: MP_MERCHANT_B,
        displayName: 'Milk',
      }),
      merchantTrustedRow('b2', 200, {
        receiptId: 'rb2',
        occurredAt: 2 * MS_DAY,
        merchantKey: MP_MERCHANT_B,
        displayName: 'Milk',
      }),
    ];
    const mpA = resolveMerchantProductId('Milk', MP_MERCHANT_A);
    const mpB = resolveMerchantProductId('Milk', MP_MERCHANT_B);
    expect(mpA).not.toBe(mpB);
    const candidates = collectAnalysisTrustedPriceChangeCandidates({
      rows,
      seedReceiptIds: new Set(['ra2', 'rb2']),
    });
    expect(candidates.map((candidate) => candidate.target.key).sort()).toEqual(
      [mpA, mpB].sort()
    );
  });

  it('ranks mixed sku and merchant_product candidates deterministically with limit 3', () => {
    const rows = [
      trustedSkuRow('s1', SKU_A, 100, {
        receiptId: 's-r1',
        occurredAt: MS_DAY,
        displayName: 'Small SKU',
      }),
      trustedSkuRow('s2', SKU_A, 130, {
        receiptId: 's-r2',
        occurredAt: 2 * MS_DAY,
        displayName: 'Small SKU',
      }),
      merchantTrustedRow('m1', 100, {
        receiptId: 'm-r1',
        occurredAt: MS_DAY,
        displayName: 'Large MP',
      }),
      merchantTrustedRow('m4', 250, {
        receiptId: 'm-r4',
        occurredAt: 3 * MS_DAY,
        displayName: 'Large MP',
      }),
    ];
    const surface = buildAnalysisPriceChangesSurfaceFromRows({
      rows,
      seedReceiptIds: new Set(['s-r2', 'm-r4']),
      limit: 3,
    });
    expect(surface.status).toBe('available');
    if (surface.status === 'available') {
      expect(surface.items).toHaveLength(2);
      expect(surface.items[0]?.displayName).toBe('Large MP');
      expect(surface.items[0]?.deltaAmount).toBe(150);
      expect(surface.items[1]?.displayName).toBe('Small SKU');
    }
  });

  it('discovers merchant_product ids only from authoritative identity observations', () => {
    const rows = [
      merchantTrustedRow('1', 100, { receiptId: 'seed-1' }),
      merchantTrustedRow('2', 100, { receiptId: 'other-1' }),
    ];
    const ids = discoverSeededMerchantProductIds(rows, new Set(['seed-1']));
    expect(ids.size).toBe(1);
    expect(ids.has(resolveMerchantProductId(MP_PRODUCT_NAME, MP_MERCHANT_A))).toBe(
      true
    );
  });

  it('does not introduce family or fuzzy fallback helpers in adapter source', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'analysisTrustedPriceChanges.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/productFamilyKey|comparisonKey|fuzzy|normalizeProductForIdentity/);
    expect(source).toContain('resolveIdentityConsumerObservations');
    expect(source).toContain('resolveMerchantProductTargetMembershipRowKeys');
  });

  it('dedup helpers skip merchant_product when sku already covers purchase events', () => {
    const skuCandidate = {
      target: { type: 'sku' as const, key: SKU_A },
      displayName: 'Milk',
      interpretation: {
        status: 'available' as const,
        grossDelta: 20,
        grossDirection: 'increased' as const,
        current: { receiptId: 'r2', occurredAt: 2, currency: 'JPY', skuKey: SKU_A },
        previous: { receiptId: 'r1', occurredAt: 1, currency: 'JPY', skuKey: SKU_A },
      },
      comparableOccurrenceCount: 2,
      latestOccurredAt: 2,
    } as any;
    const mpCandidate = {
      target: { type: 'merchant_product' as const, key: 'mp_test' },
      displayName: 'Milk',
      interpretation: {
        status: 'available' as const,
        grossDelta: 20,
        grossDirection: 'increased' as const,
        current: { receiptId: 'r2', occurredAt: 2, currency: 'JPY', skuKey: SKU_A },
        previous: { receiptId: 'r1', occurredAt: 1, currency: 'JPY', skuKey: SKU_A },
      },
      comparableOccurrenceCount: 2,
      latestOccurredAt: 2,
    } as any;
    const covered = collectSkuCoveredPurchaseEvents([skuCandidate]);
    expect(isMerchantProductDuplicateOfSku(mpCandidate, covered)).toBe(true);
  });

  it('rejects fuzzy_exact merchant_product identity for AP-3', () => {
    const { resolveReceiptItemIdentity: realResolve } = jest.requireActual<
      typeof import('./productIdentityResolver')
    >('./productIdentityResolver');
    const spy = jest
      .spyOn(productIdentityResolver, 'resolveReceiptItemIdentity')
      .mockImplementation((input, store) => {
        const result = realResolve(input, store);
        return {
          ...result,
          link: {
            ...result.link,
            identitySource: 'fuzzy_exact',
            identityLevel: 'merchant_product',
          },
        };
      });
    try {
      const rows = [
        merchantTrustedRow('1', 100, { receiptId: 'r1', occurredAt: MS_DAY }),
        merchantTrustedRow('2', 120, {
          receiptId: 'r2',
          occurredAt: 2 * MS_DAY,
        }),
      ];
      expect(
        buildAnalysisPriceChangesSurfaceFromRows({
          rows,
          seedReceiptIds: new Set(['r2']),
        })
      ).toEqual({ status: 'unavailable' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('analysisTrustedPriceChanges merchant_product provenance gate', () => {
  const availableInterpretation = {
    status: 'available' as const,
    grossDelta: 20,
    grossDirection: 'increased' as const,
    current: { receiptId: 'r2', occurredAt: 2, currency: 'JPY' },
    previous: { receiptId: 'r1', occurredAt: 1, currency: 'JPY' },
  };

  const readyHistory = {
    status: 'ready' as const,
    points: [
      mpTrustedHistoryPoint('r1'),
      mpTrustedHistoryPoint('r2', {
        priceValue: 120,
        grossLineAmount: 120,
        lineTotal: 120,
      }),
    ],
  };

  it('whitelists exact resolver merchant_product sources only', () => {
    for (const source of ANALYSIS_MERCHANT_PRODUCT_APPROVED_IDENTITY_SOURCES) {
      expect(isAnalysisApprovedMerchantProductIdentitySource(source)).toBe(true);
      expect(
        isAnalysisApprovedMerchantProductHistoryPoint(
          mpTrustedHistoryPoint('r1', { identitySource: source })
        )
      ).toBe(true);
    }
  });

  it('approves identity-stem merchant_product via normalized_exact source', () => {
    expect(
      isAnalysisApprovedMerchantProductHistoryPoint(
        mpTrustedHistoryPoint('r1', { identitySource: 'normalized_exact' })
      )
    ).toBe(true);
  });

  it('rejects fuzzy_exact, cache, unresolved, and family identity provenance', () => {
    for (const source of [
      'fuzzy_exact',
      'cache',
      'unresolved',
      'family_only',
      'family_spec',
      null,
      undefined,
    ]) {
      expect(
        isAnalysisApprovedMerchantProductHistoryPoint(
          mpTrustedHistoryPoint('r1', { identitySource: source })
        )
      ).toBe(false);
    }
  });

  it('rejects mixed exact and fuzzy purchase-event history', () => {
    expect(
      merchantProductInterpretationPurchasePointsApproved(
        {
          ...readyHistory,
          points: [
            mpTrustedHistoryPoint('r1', { identitySource: 'normalized_exact' }),
            mpTrustedHistoryPoint('r2', {
              identitySource: 'fuzzy_exact',
              priceValue: 120,
              grossLineAmount: 120,
              lineTotal: 120,
            }),
          ],
        } as any,
        availableInterpretation as any
      )
    ).toBe(false);
  });

  it('accepts both purchase events when provenance is exact-approved', () => {
    expect(
      merchantProductInterpretationPurchasePointsApproved(
        readyHistory as any,
        availableInterpretation as any
      )
    ).toBe(true);
  });

  it('rejects family_only identity level even with normalized_exact source', () => {
    expect(
      isAnalysisApprovedMerchantProductHistoryPoint(
        mpTrustedHistoryPoint('r1', {
          identityLevel: 'family_only',
          identitySource: 'normalized_exact',
        })
      )
    ).toBe(false);
  });

  it('documents AP-3 provenance gate in adapter source', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'analysisTrustedPriceChanges.ts'),
      'utf8'
    );
    expect(source).toContain('merchantProductInterpretationPurchasePointsApproved');
    expect(source).toContain('ANALYSIS_MERCHANT_PRODUCT_APPROVED_IDENTITY_SOURCES');
    expect(source).toContain('isAnalysisApprovedMerchantProductHistoryPoint');
  });
});

describe('analysis release price change visibility', () => {
  const availableSurface = {
    status: 'available' as const,
    items: [
      {
        displayName: 'Milk',
        direction: 'up' as const,
        deltaAmount: 20,
        currency: 'JPY',
        targetType: 'sku' as const,
        targetKey: SKU_A,
        promoBodyKey: null,
      },
    ],
  };

  it('shows price changes only on ready stage', () => {
    const ready = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 5000,
        supportedReceiptCount: 5,
      },
      allSupportedCount: 5,
      itemCount: 10,
      insights: null,
      priceChanges: availableSurface,
    });
    expect(ready.stage).toBe('ready');
    expect(ready.priceChanges.status).toBe('available');

    const low = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 1000,
        supportedReceiptCount: 2,
      },
      allSupportedCount: 5,
      itemCount: 4,
      insights: null,
      priceChanges: availableSurface,
    });
    expect(low.priceChanges).toEqual({ status: 'unavailable' });

    const empty = buildAnalysisReleaseViewModel({
      periodStats: createEmptyStats(),
      allSupportedCount: 0,
      itemCount: 0,
      insights: null,
      priceChanges: availableSurface,
    });
    expect(empty.priceChanges).toEqual({ status: 'unavailable' });
  });

  it('keeps price changes available independent of period change surfaces', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 5000,
        supportedReceiptCount: 5,
      },
      allSupportedCount: 5,
      itemCount: 10,
      insights: null,
      priceChanges: availableSurface,
    });
    expect(vm.spendChange).toEqual({ status: 'unavailable' });
    expect(vm.priceChanges.status).toBe('available');
  });

  it('keeps legacy Price Radar and Category Index gated off', () => {
    const vm = buildAnalysisReleaseViewModel({
      periodStats: {
        ...createEmptyStats(),
        supportedSpend: 5000,
        supportedReceiptCount: 5,
      },
      allSupportedCount: 5,
      itemCount: 10,
      insights: null,
      priceChanges: availableSurface,
      priceRadarMigrated: false,
    });
    expect(vm.showLegacyPriceRadar).toBe(false);
    expect(vm.showLegacyCategoryIndex).toBe(false);
  });
});

describe('analysis price surfaces module boundaries', () => {
  it('does not import legacy priceRadar or unsafe comparison helpers', () => {
    for (const file of [
      'analysisPriceSurfaces.ts',
      'analysisTrustedPriceChanges.ts',
    ]) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source).not.toMatch(/from '\.\/priceRadar'/);
      expect(source).not.toMatch(/computeCheapestMerchants|compareWithMinPrice/);
    }
  });

  it('analysis screen keeps AP-3 disabled for Build 80 release gate', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(source).toContain('ANALYSIS_PRICE_CHANGES_ENABLED = false');
    expect(source).not.toContain('loadAnalysisTrustedPriceChangesSurface');
    expect(source).not.toContain('buildPriceRadarData');
    expect(source).not.toContain('buildCategoryIndexData');
    expect(source).toContain('priceRadarMigrated: false');
    expect(source).not.toMatch(
      /Promise\.all\([\s\S]*loadAnalysisTrustedPriceChangesSurface/
    );
    expect(source).toContain('priceChangesContext');
    expect(source).toContain('promoBodyKey');
    expect(source).toContain("timeRange !== 'all'");
    expect(source).toContain('showPeriodChangesSection');
    expect(source).toContain('loadCycleRef');
  });
});

describe('analysis price change i18n', () => {
  const localesDir = path.join(__dirname, '../locales');

  function releaseString(locale: string, key: string): string {
    const data = JSON.parse(
      fs.readFileSync(path.join(localesDir, `${locale}.json`), 'utf8')
    ) as Record<string, unknown>;
    const release = (data.analysis as Record<string, unknown>).release as Record<
      string,
      string
    >;
    return release[key];
  }

  it('defines zh / ja / en purchase-event price change copy without recommendation tone', () => {
    const expected = {
      zh: {
        priceChangesTitle: '购买价格变化',
        priceChangesContext: '基于最近两次可比购买记录',
        priceChangeUp: '最近一次购买价比上次高 {amount}',
        priceChangeDown: '最近一次购买价比上次低 {amount}',
      },
      ja: {
        priceChangesTitle: '購入価格の変化',
        priceChangesContext: '直近2回の比較可能な購入記録に基づきます',
        priceChangeUp: '直近の購入価格は前回より{amount}高い',
        priceChangeDown: '直近の購入価格は前回より{amount}安い',
      },
      en: {
        priceChangesTitle: 'Purchase price changes',
        priceChangesContext:
          'Based on the two most recent comparable purchases',
        priceChangeUp:
          'Latest purchase was {amount} higher than the previous one',
        priceChangeDown:
          'Latest purchase was {amount} lower than the previous one',
      },
    } as const;

    for (const locale of ['zh', 'ja', 'en'] as const) {
      for (const key of [
        'priceChangesTitle',
        'priceChangesContext',
        'priceChangeUp',
        'priceChangeDown',
      ] as const) {
        const copy = releaseString(locale, key);
        expect(copy).toBe(expected[locale][key]);
        expect(copy).not.toMatch(/建议|推荐|囤货|预测|recommend|predict|stock up/i);
        expect(copy).not.toMatch(
          /近期价格上涨|最近の価格が.*上昇|Recent price increased/i
        );
      }
    }
  });
});

describe('analysisTrustedPriceChanges ranking helpers', () => {
  it('selectAnalysisTrustedPriceChangeCandidates respects limit', () => {
    const candidates = [
      {
        target: { type: 'sku' as const, key: 'a' },
        displayName: 'A',
        interpretation: {
          status: 'available' as const,
          grossDelta: 10,
          grossDirection: 'increased' as const,
          current: { occurredAt: 1, currency: 'JPY' },
        },
        comparableOccurrenceCount: 2,
        latestOccurredAt: 1,
      },
      {
        target: { type: 'sku' as const, key: 'b' },
        displayName: 'B',
        interpretation: {
          status: 'available' as const,
          grossDelta: 30,
          grossDirection: 'increased' as const,
          current: { occurredAt: 2, currency: 'JPY' },
        },
        comparableOccurrenceCount: 2,
        latestOccurredAt: 2,
      },
    ] as any;
    expect(
      selectAnalysisTrustedPriceChangeCandidates(candidates, 1).map(
        (row) => row.displayName
      )
    ).toEqual(['B']);
    expect(rankAnalysisTrustedPriceChangeCandidates(candidates)[0]?.displayName).toBe(
      'B'
    );
  });
});
