/* eslint-disable import/first -- Jest mocks must run before imports. */
import type * as SQLite from 'expo-sqlite';

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

import { resolveReceiptItemIdentity } from './productIdentityResolver';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import {
  loadProductPriceHistoryWithDb,
  type ProductPriceHistoryDatabase,
  type ProductPriceHistoryRow,
} from './productPriceHistory';

type OwnedPriceRow = ProductPriceHistoryRow & {
  ownerUserId?: string | null;
  ownerInstallationId?: string | null;
};

const SKU_KEY = 'milk-sku';

function trustedSkuRow(
  id: string,
  overrides: Partial<OwnedPriceRow> & {
    receiptId: string;
    grossLineAmount: number;
    ownerUserId?: string | null;
  }
): OwnedPriceRow {
  const gross = overrides.grossLineAmount;
  return {
    itemId: overrides.itemId ?? `item-${id}`,
    sourceIndex: overrides.sourceIndex ?? 0,
    occurredAt: overrides.occurredAt ?? Number(id.replace(/\D/g, '')) * 86_400_000,
    merchantRaw: 'Store',
    merchantNormalized: 'store',
    displayName: 'Milk',
    currency: overrides.currency ?? 'JPY',
    lineTotal: gross,
    purchaseQuantity: 1,
    productFamilyKey: 'milk',
    volumeBaseMl: 1000,
    weightBaseG: null,
    countBase: null,
    skuKey: SKU_KEY,
    effectiveLineAmount: gross,
    discountAllocated: null,
    amountProvenance: 'ocr_observed',
    itemAmountEvidenceState: 'coherent',
    promoMarkersJson: null,
    evidenceCaptureVersion: 1,
    priceObservationVersion: 1,
    itemSource: null,
    identitySource: null,
    identityConfidence: null,
    receiptAnalysisJson: JSON.stringify({
      items: [{ name: 'Milk', lineTotal: gross, quantity: 1 }],
      evidenceCaptureVersion: 1,
      reconciliation: { ok: true },
      amount_mismatch: false,
    }),
    receiptUserItemsJson: null,
    receiptUserEdited: 0,
    receiptTotal: gross,
    receiptFinalTotal: null,
    receiptTax: 8,
    receiptTaxIsKnown: 1,
    receiptCurrency: overrides.currency ?? 'JPY',
    ownerInstallationId: null,
    ...overrides,
    grossLineAmount: gross,
  };
}

function bindValues(params: SQLite.SQLiteBindParams): SQLite.SQLiteBindValue[] {
  return Array.isArray(params) ? params : [];
}

class OwnerAwarePriceDb implements ProductPriceHistoryDatabase {
  readonly rows: OwnedPriceRow[] = [];
  readonly queries: string[] = [];

  async getAllAsync<T>(
    source: string,
    params: SQLite.SQLiteBindParams
  ): Promise<T[]> {
    this.queries.push(source);
    const values = bindValues(params);
    let filtered = [...this.rows];

    if (/receipts\.user_id = \?/i.test(source) && !/IS NULL/i.test(source)) {
      const userId = String(values[0]);
      filtered = filtered.filter((row) => row.ownerUserId === userId);
    } else if (/installation_id = \?/i.test(source)) {
      const installationId = String(values[0]);
      filtered = filtered.filter(
        (row) =>
          (row.ownerUserId == null || row.ownerUserId === '') &&
          row.ownerInstallationId === installationId
      );
    }

    if (/receipt_items\.sku_key = \?/i.test(source)) {
      const skuKey = String(values[1] ?? values[0]);
      filtered = filtered.filter((row) => row.skuKey === skuKey);
    } else if (/canonical_product_name = \?/i.test(source)) {
      const key = String(values[1] ?? values[0]);
      filtered = filtered.filter((row) => row.displayName === key);
    } else if (/product_family_key = \?/i.test(source)) {
      const key = String(values[values.length - 1]);
      filtered = filtered.filter((row) => row.productFamilyKey === key);
    }

    return filtered as T[];
  }
}

function setUserScope(userId: string) {
  mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
    status: 'ready',
    ownerKey: `user:${userId}`,
    receiptWhereSql: 'receipts.user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: [userId],
  });
}

const MERCHANT_FIXTURE_NAME = '横浜家系';
const MERCHANT_FIXTURE_KEY = 'ヨークベニマル';

function merchantTrustedRow(
  id: string,
  overrides: Partial<OwnedPriceRow> & {
    receiptId: string;
    grossLineAmount: number;
    ownerUserId?: string | null;
  }
): OwnedPriceRow {
  const gross = overrides.grossLineAmount;
  return trustedSkuRow(id, {
    ...overrides,
    displayName: MERCHANT_FIXTURE_NAME,
    merchantRaw: MERCHANT_FIXTURE_KEY,
    merchantNormalized: MERCHANT_FIXTURE_KEY,
    skuKey: null,
    productFamilyKey: null,
    grossLineAmount: gross,
  });
}

function resolveFixtureMerchantProductId(): string {
  const store = createMemoryProductIdentityStore();
  const link = resolveReceiptItemIdentity(
    {
      rawName: MERCHANT_FIXTURE_NAME,
      merchantKey: MERCHANT_FIXTURE_KEY,
      receiptId: 'mp-seed',
      itemSourceIndex: 0,
    },
    store
  ).link;
  return link.merchantProductId!;
}

describe('Product Price History owner isolation (Privacy-H3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setUserScope('user-a');
  });

  it('sku price history excludes foreign owner observations from points and counts', async () => {
    const db = new OwnerAwarePriceDb();
    db.rows.push(
      trustedSkuRow('1', {
        receiptId: 'receipt-a1',
        grossLineAmount: 100,
        ownerUserId: 'user-a',
        occurredAt: 1 * 86_400_000,
      }),
      trustedSkuRow('2', {
        receiptId: 'receipt-a2',
        grossLineAmount: 110,
        ownerUserId: 'user-a',
        occurredAt: 2 * 86_400_000,
      }),
      trustedSkuRow('3', {
        receiptId: 'receipt-b1',
        grossLineAmount: 500,
        ownerUserId: 'user-b',
        occurredAt: 3 * 86_400_000,
      }),
      trustedSkuRow('4', {
        receiptId: 'receipt-b2',
        grossLineAmount: 600,
        ownerUserId: 'user-b',
        occurredAt: 4 * 86_400_000,
      })
    );

    const result = await loadProductPriceHistoryWithDb(db, {
      type: 'sku',
      key: SKU_KEY,
    });

    expect(result.status).toBe('ready');
    expect(result.totalOccurrenceCount).toBe(2);
    expect(result.points.map((point) => point.receiptId)).toEqual([
      'receipt-a1',
      'receipt-a2',
    ]);
    expect(result.points.map((point) => point.priceValue)).toEqual([100, 110]);
    expect(db.queries[0]).toMatch(/receipts\.user_id = \?/i);
    expect(db.queries[0]).toMatch(/receipt_items\.sku_key = \?/i);
  });

  it('foreign bad currency cannot contaminate current owner gates', async () => {
    const db = new OwnerAwarePriceDb();
    db.rows.push(
      trustedSkuRow('1', {
        receiptId: 'receipt-a1',
        grossLineAmount: 100,
        ownerUserId: 'user-a',
        currency: 'JPY',
        receiptCurrency: 'JPY',
      }),
      trustedSkuRow('2', {
        receiptId: 'receipt-a2',
        grossLineAmount: 110,
        ownerUserId: 'user-a',
        currency: 'JPY',
        receiptCurrency: 'JPY',
        occurredAt: 2 * 86_400_000,
      }),
      trustedSkuRow('3', {
        receiptId: 'receipt-b1',
        grossLineAmount: 500,
        ownerUserId: 'user-b',
        currency: 'USD',
        receiptCurrency: 'USD',
      }),
      trustedSkuRow('4', {
        receiptId: 'receipt-b2',
        grossLineAmount: 600,
        ownerUserId: 'user-b',
        currency: 'USD',
        receiptCurrency: 'USD',
        occurredAt: 2 * 86_400_000,
      })
    );

    const result = await loadProductPriceHistoryWithDb(db, {
      type: 'sku',
      key: SKU_KEY,
    });

    expect(result.status).toBe('ready');
    expect(result.currency).toBe('JPY');
    expect(result.points).toHaveLength(2);
  });

  it('owner unavailable returns safe no-data result without querying', async () => {
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
      status: 'owner_unavailable',
    });
    const db = new OwnerAwarePriceDb();
    db.rows.push(
      trustedSkuRow('1', {
        receiptId: 'receipt-a1',
        grossLineAmount: 100,
        ownerUserId: 'user-a',
      })
    );

    const result = await loadProductPriceHistoryWithDb(db, {
      type: 'sku',
      key: SKU_KEY,
    });

    expect(result.status).toBe('not_enough_points');
    expect(result.points).toEqual([]);
    expect(db.queries).toEqual([]);
  });

  it('merchant_product identity path receives only current-owner rows', async () => {
    jest.resetModules();
    jest.doMock('./env', () => ({
      isProductIdentityPriceHistoryV1Enabled: () => true,
    }));
    const mpId = resolveFixtureMerchantProductId();
    const db = new OwnerAwarePriceDb();
    db.rows.push(
      merchantTrustedRow('1', {
        receiptId: 'receipt-a1',
        grossLineAmount: 100,
        ownerUserId: 'user-a',
        occurredAt: 1 * 86_400_000,
      }),
      merchantTrustedRow('2', {
        receiptId: 'receipt-a2',
        grossLineAmount: 110,
        ownerUserId: 'user-a',
        occurredAt: 2 * 86_400_000,
      }),
      merchantTrustedRow('3', {
        receiptId: 'receipt-b1',
        grossLineAmount: 900,
        ownerUserId: 'user-b',
        occurredAt: 3 * 86_400_000,
      })
    );

    const { loadProductPriceHistoryWithDb: load } = await import(
      './productPriceHistory'
    );
    setUserScope('user-a');
    const result = await load(db, { type: 'merchant_product', key: mpId });

    expect(result.totalOccurrenceCount).toBe(2);
    expect(result.points.map((point) => point.receiptId)).toEqual([
      'receipt-a1',
      'receipt-a2',
    ]);
    expect(db.queries[0]).toMatch(/receipts\.user_id = \?/i);
    expect(db.queries[0]).toMatch(/\(receipts\.user_id = \?\) AND \(1 = 1\)/i);
  });

  it('canonical and family targets include owner predicate in SQL', async () => {
    const db = new OwnerAwarePriceDb();
    db.rows.push(
      trustedSkuRow('1', {
        receiptId: 'receipt-a1',
        grossLineAmount: 100,
        ownerUserId: 'user-a',
        skuKey: null,
        productFamilyKey: 'milk',
        displayName: 'Milk',
      })
    );

    await loadProductPriceHistoryWithDb(db, {
      type: 'family',
      key: 'milk',
    });
    expect(db.queries[0]).toMatch(/receipts\.user_id = \?/i);
    expect(db.queries[0]).toMatch(/product_family_key = \?/i);

    db.queries.length = 0;
    await loadProductPriceHistoryWithDb(db, {
      type: 'canonical',
      key: 'Milk',
    });
    expect(db.queries[0]).toMatch(/receipts\.user_id = \?/i);
    expect(db.queries[0]).toMatch(/canonical_product_name = \?/i);
  });

  it('double-null rows are excluded from installation owner universe', async () => {
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
      status: 'ready',
      ownerKey: 'installation:install-i1',
      receiptWhereSql:
        'receipts.user_id IS NULL AND receipts.installation_id = ?',
      itemWhereSql:
        'receipts.user_id IS NULL AND receipts.installation_id = ?',
      params: ['install-i1'],
    });
    const db = new OwnerAwarePriceDb();
    db.rows.push(
      trustedSkuRow('1', {
        receiptId: 'owned',
        grossLineAmount: 100,
        ownerUserId: null,
        ownerInstallationId: 'install-i1',
      }),
      trustedSkuRow('2', {
        receiptId: 'double-null',
        grossLineAmount: 999,
        ownerUserId: null,
        ownerInstallationId: null,
      })
    );

    const result = await loadProductPriceHistoryWithDb(db, {
      type: 'sku',
      key: SKU_KEY,
    });

    expect(result.totalOccurrenceCount).toBe(1);
    expect(result.observations[0]?.receiptId).toBe('owned');
  });
});
