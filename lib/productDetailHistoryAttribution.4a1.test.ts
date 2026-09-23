/**
 * Performance Slice 4A.1 — Product Detail historyLoad substage attribution.
 * Instrumentation only — no history truth changes.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

const mockResolveCurrentLocalReceiptOwnerScope = jest.fn();
jest.mock('./receiptOwnershipScope', () => {
  const actual = jest.requireActual('./receiptOwnershipScope');
  return {
    ...actual,
    resolveCurrentLocalReceiptOwnerScope: (...args: unknown[]) =>
      mockResolveCurrentLocalReceiptOwnerScope(...args),
  };
});

const mockResolveIdentityConsumerObservations = jest.fn();
jest.mock('./productIdentityConsumer', () => ({
  resolveIdentityConsumerObservations: (...args: unknown[]) =>
    mockResolveIdentityConsumerObservations(...args),
}));

import type * as SQLite from 'expo-sqlite';
import * as consumerItemMonetaryTruth from './consumerItemMonetaryTruth';
import {
  beginProductDetailLoadTimingCapture,
  enableProductDetailLoadTimingsForTests,
  endProductDetailLoadTimingCapture,
  type ProductDetailLoadTimingSample,
} from './productDetailLoadTimings';
import {
  loadProductHistoryWithDb,
  type ProductHistoryDatabase,
  type ProductHistorySummary,
} from './productHistory';

type ReceiptFixture = {
  id: string;
  createdAt: number;
  transactionAt: number | null;
  merchantRaw: string;
  merchantNormalized: string;
  currency: string;
  userId?: string | null;
  installationId?: string | null;
};

type ItemFixture = {
  id: string;
  receiptId: string;
  sourceIndex: number;
  rawName: string;
  normalizedFullName: string;
  canonicalProductName: string | null;
  family: string | null;
  skuKey: string | null;
  category: string;
  quantity: number;
  lineTotal: number;
};

function bindValues(params: SQLite.SQLiteBindParams): SQLite.SQLiteBindValue[] {
  return Array.isArray(params) ? params : [];
}

class MemoryDb implements ProductHistoryDatabase {
  readonly receipts = new Map<string, ReceiptFixture>();
  readonly items: ItemFixture[] = [];

  addReceipt(id: string, at: number, merchant: string): void {
    this.receipts.set(id, {
      id,
      createdAt: at,
      transactionAt: at,
      merchantRaw: merchant,
      merchantNormalized: merchant,
      currency: 'JPY',
      userId: 'owner-a',
      installationId: null,
    });
  }

  addItem(
    receiptId: string,
    id: string,
    opts: Partial<ItemFixture> & { rawName: string }
  ): void {
    this.items.push({
      id,
      receiptId,
      sourceIndex: opts.sourceIndex ?? 0,
      rawName: opts.rawName,
      normalizedFullName: opts.normalizedFullName ?? opts.rawName,
      canonicalProductName: opts.canonicalProductName ?? opts.rawName,
      family: opts.family ?? null,
      skuKey: opts.skuKey ?? null,
      category: opts.category ?? 'other',
      quantity: opts.quantity ?? 1,
      lineTotal: opts.lineTotal ?? 100,
    });
  }

  purchasedAt(item: ItemFixture): number {
    return this.receipts.get(item.receiptId)!.transactionAt ?? 0;
  }

  matching(source: string, params: SQLite.SQLiteBindParams): ItemFixture[] {
    const values = bindValues(params);
    let paramIndex = 0;
    let rows = [...this.items];
    if (/receipts\.user_id = \?/i.test(source)) {
      const userId = String(values[paramIndex++] ?? '');
      rows = rows.filter(
        (item) => this.receipts.get(item.receiptId)?.userId === userId
      );
    }
    if (/receipt_id NOT IN/i.test(source)) {
      const excluded = new Set(
        values.slice(paramIndex).map((v) => String(v))
      );
      rows = rows.filter((item) => !excluded.has(item.receiptId));
    }
    return rows;
  }

  async getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]> {
    const matching = this.matching(source, params);
    return [...matching]
      .sort(
        (a, b) =>
          this.purchasedAt(b) - this.purchasedAt(a) ||
          a.sourceIndex - b.sourceIndex
      )
      .map((item) => {
        const receipt = this.receipts.get(item.receiptId)!;
        return {
          receiptId: item.receiptId,
          itemId: item.id,
          sourceIndex: item.sourceIndex,
          displayName: item.normalizedFullName,
          category: item.category,
          purchaseQuantity: item.quantity,
          lineTotal: item.lineTotal,
          purchasedAt: this.purchasedAt(item),
          merchantRaw: receipt.merchantRaw,
          merchantNormalized: receipt.merchantNormalized,
          rawName: item.rawName,
          receiptAnalysisJson: JSON.stringify({
            total: item.lineTotal,
            tax: 0,
            tax_is_known: true,
            currency: 'JPY',
            items: [
              {
                name: item.rawName,
                quantity: item.quantity,
                lineTotal: item.lineTotal,
              },
            ],
          }),
          receiptUserItemsJson: null,
          receiptTotal: item.lineTotal,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
          receiptFinalTotal: null,
          receiptUserEdited: 0,
          currency: 'JPY',
        };
      }) as T[];
  }

  async getFirstAsync(): Promise<null> {
    return null;
  }
}

function readyOwnerScope() {
  return {
    status: 'ready' as const,
    ownerKey: 'user:owner-a',
    receiptWhereSql: 'user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: ['owner-a'],
  };
}

function merchantFixture(): MemoryDb {
  const db = new MemoryDb();
  db.addReceipt('r1', 100, 'York');
  db.addReceipt('r2', 200, 'York');
  db.addItem('r1', 'r1:0', {
    rawName: 'Product A',
    sourceIndex: 0,
    quantity: 1,
    lineTotal: 100,
  });
  db.addItem('r1', 'r1:1', {
    rawName: 'Product A',
    sourceIndex: 1,
    quantity: 2,
    lineTotal: 200,
  });
  db.addItem('r2', 'r2:0', {
    rawName: 'Product A',
    sourceIndex: 0,
    quantity: 3,
    lineTotal: 300,
  });
  return db;
}

function stubIdentityMatchMp(mpId: string): void {
  mockResolveIdentityConsumerObservations.mockImplementation(
    (observations: Array<{ receiptId: string; itemSourceIndex: number }>) => ({
      store: {},
      qualified: observations.map((obs) => ({
        ...obs,
        merchantProductId: mpId,
        rawName: 'Product A',
        purchaseUnitPrice: 100,
        quality: 'trusted',
        includeInHistory: true,
        includeInTrend: true,
        suspectedIntegerMultiple: null,
      })),
    })
  );
}

function stageNames(samples: ProductDetailLoadTimingSample[]): string[] {
  return samples.map((s) => s.stage);
}

function summaryFingerprint(summary: ProductHistorySummary | null) {
  if (!summary) return null;
  return {
    purchaseOccurrenceCount: summary.purchaseOccurrenceCount,
    totalPurchaseQuantity: summary.totalPurchaseQuantity,
    totalSpend: summary.totalSpend,
    currency: summary.currency,
    currencyTotals: summary.currencyTotals,
    firstPurchasedAt: summary.firstPurchasedAt,
    lastPurchasedAt: summary.lastPurchasedAt,
    merchantCount: summary.merchantCount,
    merchants: summary.merchants.map((m) => ({
      merchantName: m.merchantName,
      purchaseOccurrenceCount: m.purchaseOccurrenceCount,
      lastPurchasedAt: m.lastPurchasedAt,
    })),
    recentPurchases: summary.recentPurchases.map((r) => ({
      receiptId: r.receiptId,
      sourceIndex: r.sourceIndex,
      purchaseQuantity: r.purchaseQuantity,
      lineTotal: r.lineTotal,
      purchasedAt: r.purchasedAt,
    })),
    title: summary.title,
  };
}

const PRIVATE_META_KEYS = [
  'ownerKey',
  'receiptId',
  'targetKey',
  'merchantProductId',
  'personalProductId',
  'productName',
  'merchantName',
];

describe('Slice 4A.1 — Product Detail history stage attribution', () => {
  beforeEach(() => {
    enableProductDetailLoadTimingsForTests(true);
    beginProductDetailLoadTimingCapture();
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue(
      readyOwnerScope()
    );
    mockResolveIdentityConsumerObservations.mockReset();
    stubIdentityMatchMp('mp_attr');
  });

  afterEach(() => {
    endProductDetailLoadTimingCapture();
    enableProductDetailLoadTimingsForTests(false);
  });

  describe('merchant timing contract', () => {
    it('emits dbFetch → projection → identityFilter → aggregate once each', async () => {
      const db = merchantFixture();
      const summary = await loadProductHistoryWithDb(db, {
        type: 'merchant_product',
        key: 'mp_attr',
      });
      expect(summary).not.toBeNull();

      const samples = endProductDetailLoadTimingCapture();
      const names = stageNames(samples);
      expect(
        names.filter((n) => n === 'productDetail.historyDbFetch')
      ).toHaveLength(1);
      expect(
        names.filter((n) => n === 'productDetail.historyProjection')
      ).toHaveLength(1);
      expect(
        names.filter((n) => n === 'productDetail.historyIdentityFilter')
      ).toHaveLength(1);
      expect(
        names.filter((n) => n === 'productDetail.historyAggregate')
      ).toHaveLength(1);

      const dbIdx = names.indexOf('productDetail.historyDbFetch');
      const projIdx = names.indexOf('productDetail.historyProjection');
      const idIdx = names.indexOf('productDetail.historyIdentityFilter');
      const aggIdx = names.indexOf('productDetail.historyAggregate');
      expect(dbIdx).toBeLessThan(projIdx);
      expect(projIdx).toBeLessThan(idIdx);
      expect(idIdx).toBeLessThan(aggIdx);

      const dbSample = samples[dbIdx]!;
      expect(dbSample.rowCount).toBe(3);
      expect(dbSample.targetType).toBe('merchant_product');
      expect(dbSample.success).toBe(true);

      const proj = samples[projIdx]!;
      expect(proj.inputRowCount).toBe(3);
      expect(proj.projectedObservationCount).toBe(3);

      const ident = samples[idIdx]!;
      expect(ident.inputObservationCount).toBe(3);
      expect(ident.qualifiedObservationCount).toBe(3);
      expect(ident.matchedObservationCount).toBe(3);

      const agg = samples[aggIdx]!;
      expect(agg.purchaseOccurrenceCount).toBe(2);
    });

    it('does not emit private identifiers in sample metadata', async () => {
      const db = merchantFixture();
      await loadProductHistoryWithDb(db, {
        type: 'merchant_product',
        key: 'mp_attr',
      });
      const samples = endProductDetailLoadTimingCapture();
      const blob = JSON.stringify(samples);
      for (const key of PRIVATE_META_KEYS) {
        expect(blob).not.toContain(`"${key}"`);
      }
      expect(blob).not.toContain('mp_attr');
      expect(blob).not.toContain('user:owner-a');
      expect(blob).not.toContain('Product A');
      expect(blob).not.toContain('"r1"');
    });
  });

  describe('merchant output equivalence', () => {
    it('identical inputs yield identical summary fingerprint with timings on/off', async () => {
      const runOnce = async (timingsOn: boolean) => {
        enableProductDetailLoadTimingsForTests(timingsOn);
        if (timingsOn) beginProductDetailLoadTimingCapture();
        stubIdentityMatchMp('mp_attr');
        const summary = await loadProductHistoryWithDb(merchantFixture(), {
          type: 'merchant_product',
          key: 'mp_attr',
        });
        if (timingsOn) endProductDetailLoadTimingCapture();
        return summaryFingerprint(summary);
      };

      const withTiming = await runOnce(true);
      const withoutTiming = await runOnce(false);
      expect(withTiming).toEqual(withoutTiming);
      expect(withTiming?.purchaseOccurrenceCount).toBe(2);
      expect(withTiming?.totalPurchaseQuantity).toBe(6);
    });

    it('no-history remains null when identity matches nothing', async () => {
      mockResolveIdentityConsumerObservations.mockImplementation(
        (observations: unknown[]) => ({
          store: {},
          qualified: (observations as Array<{ receiptId: string }>).map(
            (obs) => ({
              ...obs,
              merchantProductId: 'mp_other',
              rawName: 'x',
              purchaseUnitPrice: 1,
              quality: 'trusted',
              includeInHistory: true,
              includeInTrend: true,
              suspectedIntegerMultiple: null,
            })
          ),
        })
      );
      const summary = await loadProductHistoryWithDb(merchantFixture(), {
        type: 'merchant_product',
        key: 'mp_attr',
      });
      expect(summary).toBeNull();
      const samples = endProductDetailLoadTimingCapture();
      const ident = samples.find(
        (s) => s.stage === 'productDetail.historyIdentityFilter'
      );
      expect(ident?.matchedObservationCount).toBe(0);
      // Aggregate should not run when no match.
      expect(
        samples.some((s) => s.stage === 'productDetail.historyAggregate')
      ).toBe(false);
    });
  });

  describe('personal path — no fake merchant identity stage', () => {
    it('emits dbFetch + projection + aggregate; omits historyIdentityFilter', async () => {
      const { buildPersonalProductInventoryRowKey } = await import(
        './personalProductEndpointInventory'
      );
      const rowKey = buildPersonalProductInventoryRowKey('r-a', 0);
      const mpId = 'mp-personal-cola';
      // assertPersonalProductContextMatchesTarget requires target.key ∈ members.
      const personalContext = {
        requestedTarget: { type: 'personal_product' as const, key: mpId },
        canonicalTarget: { type: 'personal_product' as const, key: 'pp-cola' },
        ownerKey: 'user:owner-a',
        authority: 'exact' as const,
        anchorMerchantProductId: mpId,
        memberMerchantProductIds: [mpId],
        authorizedRowKeys: new Set([rowKey]),
        inventory: {
          ownerKey: 'user:owner-a',
          excludedDuplicateReceiptIds: new Set<string>(),
          itemsByRowKey: new Map([
            [
              rowKey,
              {
                rowKey,
                receiptId: 'r-a',
                sourceIndex: 0,
                merchantProductId: mpId,
              },
            ],
          ]),
          endpointsById: new Map(),
        },
      };

      const selected = [
        {
          receiptId: 'r-a',
          itemId: 'r-a:0',
          sourceIndex: 0,
          displayName: 'Cola',
          category: null,
          purchaseQuantity: 1,
          lineTotal: 100,
          currency: 'JPY',
          purchasedAt: 1,
          merchantRaw: 'A',
          merchantNormalized: 'a',
          rawName: 'Cola',
          receiptAnalysisJson: JSON.stringify({
            total: 100,
            tax: 0,
            tax_is_known: true,
            currency: 'JPY',
            items: [{ name: 'Cola', quantity: 1, lineTotal: 100 }],
          }),
          receiptUserItemsJson: null,
          receiptTotal: 100,
          receiptTax: 0,
          receiptTaxIsKnown: 1,
          receiptFinalTotal: null,
          receiptUserEdited: 0,
          specSizeValue: null,
          specSizeUnit: null,
          specPackCount: null,
          volumeBaseMl: null,
          weightBaseG: null,
          countBase: null,
          specSourceText: null,
        },
      ];

      const db: ProductHistoryDatabase = {
        async getAllAsync() {
          return selected as never;
        },
        async getFirstAsync() {
          return null;
        },
      };

      beginProductDetailLoadTimingCapture();
      const summary = await loadProductHistoryWithDb(
        db,
        { type: 'personal_product', key: mpId },
        { personalProductContext: personalContext as never }
      );
      expect(summary).not.toBeNull();
      expect(summary!.purchaseOccurrenceCount).toBe(1);

      const samples = endProductDetailLoadTimingCapture();
      const names = stageNames(samples);
      expect(names).toContain('productDetail.historyDbFetch');
      expect(names).toContain('productDetail.historyProjection');
      expect(names).toContain('productDetail.historyAggregate');
      expect(names).not.toContain('productDetail.historyIdentityFilter');

      const dbSample = samples.find(
        (s) => s.stage === 'productDetail.historyDbFetch'
      );
      expect(dbSample?.targetType).toBe('personal_product');
      expect(dbSample?.rowCount).toBe(1);

      const proj = samples.find(
        (s) => s.stage === 'productDetail.historyProjection'
      );
      expect(proj?.inputRowCount).toBe(1);
      expect(proj?.projectedObservationCount).toBe(1);
    });
  });

  describe('failure propagation', () => {
    it('DB fetch throw records success:false and rethrows', async () => {
      const db: ProductHistoryDatabase = {
        async getAllAsync() {
          throw new Error('db_boom');
        },
        async getFirstAsync() {
          return null;
        },
      };
      await expect(
        loadProductHistoryWithDb(db, {
          type: 'merchant_product',
          key: 'mp_attr',
        })
      ).rejects.toThrow('db_boom');
      const samples = endProductDetailLoadTimingCapture();
      const dbSample = samples.find(
        (s) => s.stage === 'productDetail.historyDbFetch'
      );
      expect(dbSample?.success).toBe(false);
    });

    it('identity resolver throw records success:false and rethrows', async () => {
      mockResolveIdentityConsumerObservations.mockImplementation(() => {
        throw new Error('identity_boom');
      });
      await expect(
        loadProductHistoryWithDb(merchantFixture(), {
          type: 'merchant_product',
          key: 'mp_attr',
        })
      ).rejects.toThrow('identity_boom');
      const samples = endProductDetailLoadTimingCapture();
      const ident = samples.find(
        (s) => s.stage === 'productDetail.historyIdentityFilter'
      );
      expect(ident?.success).toBe(false);
      expect(
        samples.some((s) => s.stage === 'productDetail.historyProjection')
      ).toBe(true);
    });

    it('projection throw records success:false and rethrows', async () => {
      const spy = jest
        .spyOn(consumerItemMonetaryTruth, 'projectTrustedConsumerItemAmounts')
        .mockImplementation(() => {
          throw new Error('projection_boom');
        });
      try {
        await expect(
          loadProductHistoryWithDb(merchantFixture(), {
            type: 'merchant_product',
            key: 'mp_attr',
          })
        ).rejects.toThrow('projection_boom');
        const samples = endProductDetailLoadTimingCapture();
        const proj = samples.find(
          (s) => s.stage === 'productDetail.historyProjection'
        );
        expect(proj?.success).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
