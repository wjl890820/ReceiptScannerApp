/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';

import {
  beginAnalysisPriceWorkCounting,
  endAnalysisPriceWorkCounting,
  merchantProductBucketMatchesLegacyMembership,
  prepareAnalysisPriceInsightContext,
} from './analysisPricePreparedContext';
import {
  buildAnalysisPriceChangesSurfaceFromRows,
} from './analysisPriceSurfaces';
import { collectAnalysisTrustedPriceChangeCandidates } from './analysisTrustedPriceChanges';
import * as productIdentityConsumer from './productIdentityConsumer';
import {
  resolveMerchantProductTargetMembershipRowKeys,
} from './productIdentityConsumer';
import { makeTrustedG3TestRow } from './productPriceHistory.testFixtures';
import * as productPriceHistory from './productPriceHistory';

const MS_DAY = 86_400_000;
const MP_NAME = '横浜家系';
const MERCHANT_A = 'ヨークベニマル';
const MERCHANT_B = 'イオン';

function mpRow(
  id: string,
  gross: number,
  overrides: Partial<ReturnType<typeof makeTrustedG3TestRow>> & {
    merchantKey?: string;
  } = {}
) {
  const merchantKey = overrides.merchantKey ?? MERCHANT_A;
  return makeTrustedG3TestRow(id, {
    grossLineAmount: gross,
    lineTotal: gross,
    purchaseQuantity: overrides.purchaseQuantity ?? 1,
    displayName: overrides.displayName ?? MP_NAME,
    merchantRaw: merchantKey,
    merchantNormalized: merchantKey,
    receiptId: overrides.receiptId ?? `mp-r-${id}`,
    occurredAt: overrides.occurredAt ?? Number(id.replace(/\D/g, '') || 1) * MS_DAY,
    skuKey: null,
    productFamilyKey: null,
    ...overrides,
  });
}

function skuRow(
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
    displayName: overrides.displayName ?? `SKU ${skuKey}`,
    receiptId: overrides.receiptId ?? `sku-r-${id}`,
    occurredAt: overrides.occurredAt ?? Number(id.replace(/\D/g, '') || 1) * MS_DAY,
    ...overrides,
  });
}

/** Deterministic synthetic universe: R receipts × ~3 items, repeated MPs. */
function buildScaleFixture(receiptCount: number) {
  const rows: ReturnType<typeof makeTrustedG3TestRow>[] = [];
  const seedReceiptIds = new Set<string>();
  const merchants = [MERCHANT_A, MERCHANT_B, 'ライフ', '西友'];
  const products = [MP_NAME, '牛乳', '卵', '豆腐', '納豆'];

  for (let r = 0; r < receiptCount; r += 1) {
    const receiptId = `scale-r-${r}`;
    seedReceiptIds.add(receiptId);
    const merchantKey = merchants[r % merchants.length]!;
    for (let i = 0; i < 3; i += 1) {
      const product = products[(r + i) % products.length]!;
      const id = `${r}-${i}`;
      rows.push(
        mpRow(id, 100 + (r % 7) * 10 + i, {
          receiptId,
          sourceIndex: i,
          itemId: `item-${id}`,
          displayName: product,
          merchantKey,
          occurredAt: (r + 1) * MS_DAY,
          // Alternate unit-price comparable history across receipts.
          purchaseQuantity: i === 0 && r % 5 === 0 ? 2 : 1,
          grossLineAmount:
            i === 0 && r % 5 === 0
              ? 2 * (100 + (r % 7) * 10)
              : 100 + (r % 7) * 10 + i,
          lineTotal:
            i === 0 && r % 5 === 0
              ? 2 * (100 + (r % 7) * 10)
              : 100 + (r % 7) * 10 + i,
        })
      );
    }
    // Noise: non-comparable / malformed-ish rows that should not crash.
    if (r % 11 === 0) {
      rows.push(
        mpRow(`noise-${r}`, 0, {
          receiptId,
          sourceIndex: 9,
          itemId: `noise-${r}`,
          displayName: '値引',
          merchantKey,
          occurredAt: (r + 1) * MS_DAY,
          purchaseQuantity: 0,
          lineTotal: 0,
          grossLineAmount: 0,
        })
      );
    }
  }

  return { rows, seedReceiptIds };
}

describe('AP-3 prepared context — membership equivalence', () => {
  it('prepared MP buckets match resolveMerchantProductTargetMembershipRowKeys', () => {
    const rows = [
      mpRow('1', 100, { receiptId: 'r1', occurredAt: MS_DAY }),
      mpRow('2', 120, { receiptId: 'r2', occurredAt: 2 * MS_DAY }),
      mpRow('3', 110, {
        receiptId: 'r3',
        occurredAt: 3 * MS_DAY,
        merchantKey: MERCHANT_B,
      }),
      mpRow('4', 90, {
        receiptId: 'r4',
        occurredAt: 4 * MS_DAY,
        displayName: '別商品',
      }),
    ];
    const prepared = prepareAnalysisPriceInsightContext(
      rows,
      new Set(['r1', 'r2', 'r3', 'r4'])
    );

    for (const mpId of prepared.seededMerchantProductIds) {
      const bucket = prepared.merchantProductBuckets.get(mpId) ?? [];
      expect(
        merchantProductBucketMatchesLegacyMembership(rows, mpId, bucket)
      ).toBe(true);
      const legacy = resolveMerchantProductTargetMembershipRowKeys(
        [...rows],
        mpId
      );
      expect(bucket.length).toBe(legacy.length);
    }
  });

  it('SKU buckets group exactly by skuKey', () => {
    const rows = [
      skuRow('1', 'sku-a', 100, { receiptId: 'r1' }),
      skuRow('2', 'sku-a', 120, { receiptId: 'r2' }),
      skuRow('3', 'sku-b', 80, { receiptId: 'r3' }),
    ];
    const prepared = prepareAnalysisPriceInsightContext(
      rows,
      new Set(['r1', 'r2', 'r3'])
    );
    expect(prepared.skuBuckets.get('sku-a')).toHaveLength(2);
    expect(prepared.skuBuckets.get('sku-b')).toHaveLength(1);
    expect(prepared.seededSkuKeys.has('sku-a')).toBe(true);
  });
});

describe('AP-3 prepared context — complexity regression', () => {
  afterEach(() => {
    endAnalysisPriceWorkCounting();
    jest.restoreAllMocks();
  });

  it('full-universe identity resolve count stays constant as M grows', () => {
    const base = buildScaleFixture(40);
    // Inflate distinct MP candidates by varying product names on seed receipts.
    const extraRows = [...base.rows];
    for (let i = 0; i < 30; i += 1) {
      extraRows.push(
        mpRow(`extra-${i}-a`, 100 + i, {
          receiptId: `extra-r-${i}-a`,
          displayName: `商品${i}`,
          merchantKey: MERCHANT_A,
          occurredAt: MS_DAY,
        }),
        mpRow(`extra-${i}-b`, 110 + i, {
          receiptId: `extra-r-${i}-b`,
          displayName: `商品${i}`,
          merchantKey: MERCHANT_A,
          occurredAt: 2 * MS_DAY,
        })
      );
    }
    const seedReceiptIds = new Set([
      ...base.seedReceiptIds,
      ...extraRows
        .filter((row) => String(row.receiptId).startsWith('extra-r-'))
        .map((row) => row.receiptId),
    ]);

    const resolveSpy = jest.spyOn(
      productIdentityConsumer,
      'resolveIdentityConsumerObservations'
    );
    const tryBuildSpy = jest.spyOn(
      productIdentityConsumer,
      'tryBuildIdentityPriceHistoryForRows'
    );
    const evidenceSpy = jest.spyOn(
      productPriceHistory,
      'buildReceiptEvidenceCache'
    );

    beginAnalysisPriceWorkCounting();
    collectAnalysisTrustedPriceChangeCandidates({
      rows: extraRows,
      seedReceiptIds,
    });
    const counters = endAnalysisPriceWorkCounting();

    expect(counters?.fullUniverseIdentityResolves).toBe(1);
    expect(resolveSpy.mock.calls.length).toBe(1);
    expect(evidenceSpy.mock.calls.length).toBe(1);
    expect(tryBuildSpy).not.toHaveBeenCalled();
    // History inputs are bucket-sized, never the full universe per candidate.
    const maxBucket = Math.max(
      0,
      ...(counters?.historyInputRowCounts ?? [0])
    );
    expect(maxBucket).toBeLessThan(extraRows.length);
    for (const size of counters?.historyInputRowCounts ?? []) {
      expect(size).toBeLessThan(extraRows.length);
    }
  });

  it.each([100, 500, 1000] as const)(
    '%s-receipt structural fixture: one identity pass + one evidence cache',
    (receiptCount) => {
      const { rows, seedReceiptIds } = buildScaleFixture(receiptCount);
      const resolveSpy = jest.spyOn(
        productIdentityConsumer,
        'resolveIdentityConsumerObservations'
      );
      const tryBuildSpy = jest.spyOn(
        productIdentityConsumer,
        'tryBuildIdentityPriceHistoryForRows'
      );

      beginAnalysisPriceWorkCounting();
      const started = Date.now();
      collectAnalysisTrustedPriceChangeCandidates({ rows, seedReceiptIds });
      const elapsedMs = Date.now() - started;
      const counters = endAnalysisPriceWorkCounting();

      expect(counters?.fullUniverseIdentityResolves).toBe(1);
      expect(counters?.evidenceCacheBuilds).toBe(1);
      expect(resolveSpy.mock.calls.length).toBe(1);
      expect(tryBuildSpy).not.toHaveBeenCalled();
      for (const size of counters?.historyInputRowCounts ?? []) {
        expect(size).toBeLessThan(rows.length);
      }
      // Informational only — do not fail on wall-clock.
      // eslint-disable-next-line no-console
      console.info(
        `[AP-3 C2A] ${receiptCount} receipts: ${elapsedMs}ms, historyCalls=${
          counters?.historyInputRowCounts.length ?? 0
        }`
      );
    }
  );
});

describe('AP-3 prepared context — semantic smoke + flag', () => {
  it('preserves unit-price increase and top-level surface shape', () => {
    const rows = [
      skuRow('1', 'sku-milk', 100, {
        receiptId: 'r1',
        occurredAt: MS_DAY,
        displayName: 'Milk',
      }),
      skuRow('2', 'sku-milk', 200, {
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
        displayName: 'Milk',
        purchaseQuantity: 2,
        grossLineAmount: 200,
        lineTotal: 200,
      }),
    ];
    // qty 2 @ 200 ⇒ unit 100; vs prior unit 100 ⇒ unchanged filtered out OR
    // use clear increase:
    const increaseRows = [
      skuRow('1', 'sku-milk', 100, {
        receiptId: 'r1',
        occurredAt: MS_DAY,
        displayName: 'Milk',
      }),
      skuRow('2', 'sku-milk', 150, {
        receiptId: 'r2',
        occurredAt: 2 * MS_DAY,
        displayName: 'Milk',
      }),
    ];
    const surface = buildAnalysisPriceChangesSurfaceFromRows({
      rows: increaseRows,
      seedReceiptIds: new Set(['r2']),
    });
    expect(surface.status).toBe('available');
    if (surface.status === 'available') {
      expect(surface.items[0]?.direction).toBe('up');
      expect(surface.items[0]?.deltaAmount).toBe(50);
    }

    // qty2 vs qty1 unit-price compare still works via interpretation SSOT.
    const qtySurface = buildAnalysisPriceChangesSurfaceFromRows({
      rows: [
        skuRow('1', 'sku-egg', 100, {
          receiptId: 'q1',
          occurredAt: MS_DAY,
          purchaseQuantity: 1,
          displayName: 'Eggs',
        }),
        skuRow('2', 'sku-egg', 240, {
          receiptId: 'q2',
          occurredAt: 2 * MS_DAY,
          purchaseQuantity: 2,
          grossLineAmount: 240,
          lineTotal: 240,
          displayName: 'Eggs',
        }),
      ],
      seedReceiptIds: new Set(['q2']),
    });
    expect(qtySurface.status).toBe('available');
    if (qtySurface.status === 'available') {
      // unit 100 → 120
      expect(qtySurface.items[0]?.direction).toBe('up');
      expect(qtySurface.items[0]?.deltaAmount).toBe(20);
    }

    void rows;
  });

  it('ANALYSIS_PRICE_CHANGES_ENABLED remains false', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/analysis.tsx'),
      'utf8'
    );
    expect(source).toContain('ANALYSIS_PRICE_CHANGES_ENABLED = false');
    expect(source).not.toContain('loadAnalysisTrustedPriceChangesSurface');
  });
});
