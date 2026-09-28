/**
 * A2.2c — price-history loader provenance and occurrence collapse.
 */

/* eslint-disable import/first */
import type * as SQLite from 'expo-sqlite';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
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

import {
  loadProductPriceHistoryWithDb,
  type ProductPriceHistoryDatabase,
  type ProductPriceHistoryRow,
} from './productPriceHistory';
import { verifiedPurchaseOccurrenceAliasedColumnsSql } from './receiptVerifiedPurchaseOccurrenceSelect';

const TX = Date.parse('2024-05-02T09:00:00+09:00');
const VERIFIED_AT = 1_710_000_000_000;
const ALIASES = verifiedPurchaseOccurrenceAliasedColumnsSql('receipts');

function priceRow(
  receiptId: string,
  provenance: {
    id: string | null;
    source: string | null;
    verifiedAt: number | null;
  }
): ProductPriceHistoryRow {
  return {
    receiptId,
    itemId: `${receiptId}-item`,
    sourceIndex: 0,
    occurredAt: TX,
    merchantRaw: 'MARKET',
    merchantNormalized: 'MARKET',
    displayName: 'MILK',
    currency: 'JPY',
    lineTotal: 480,
    purchaseQuantity: 1,
    productFamilyKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    skuKey: 'milk-sku',
    grossLineAmount: 480,
    effectiveLineAmount: 480,
    receiptAnalysisJson: JSON.stringify({
      merchant: 'MARKET',
      total: 480,
      tax: 8,
      tax_is_known: true,
      currency: 'JPY',
      merchant_type: 'supermarket',
      items: [{ name: 'MILK', quantity: 1, lineTotal: 480 }],
      transaction_time_precision: 'minute',
    }),
    receiptUserEdited: 0,
    receiptTotal: 480,
    receiptTax: 8,
    receiptTaxIsKnown: 1,
    receiptCurrency: 'JPY',
    receiptTransactionAt: TX,
    receiptCreatedAt: TX,
    verifiedPurchaseOccurrenceId: provenance.id,
    verifiedPurchaseOccurrenceSource: provenance.source,
    verifiedPurchaseOccurrenceVerifiedAt: provenance.verifiedAt,
  };
}

function projectQueryRow(
  sql: string,
  row: ProductPriceHistoryRow
): ProductPriceHistoryRow {
  if (sql.includes(ALIASES)) return { ...row };
  const copy: ProductPriceHistoryRow = { ...row };
  delete copy.verifiedPurchaseOccurrenceId;
  delete copy.verifiedPurchaseOccurrenceSource;
  delete copy.verifiedPurchaseOccurrenceVerifiedAt;
  return copy;
}

function loaderDb(rows: ProductPriceHistoryRow[]): ProductPriceHistoryDatabase & {
  queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    async getAllAsync<T>(source: string, _params: SQLite.SQLiteBindParams) {
      queries.push(source);
      return rows.map((row) => projectQueryRow(source, row)) as T[];
    },
  };
}

beforeEach(() => {
  mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue({
    status: 'ready',
    ownerKey: 'user:test-user',
    receiptWhereSql: 'receipts.user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: ['test-user'],
  });
});

describe('A2.2c price history loader provenance', () => {
  it('selects the provenance triple and keeps assigned G as one observation', async () => {
    const rows = Array.from({ length: 7 }, (_, index) => {
      const row = priceRow(`g${index}`, {
        id: 'vpo_g',
        source: 'research_verified',
        verifiedAt: VERIFIED_AT,
      });
      return {
        ...row,
        occurredAt: TX + index * 60_000,
        receiptTransactionAt: TX + index * 60_000,
        receiptCreatedAt: TX + index,
      };
    });
    const db = loaderDb(rows);
    const result = await loadProductPriceHistoryWithDb(db, {
      type: 'sku',
      key: 'milk-sku',
    });
    expect(db.queries[0]).toContain(ALIASES);
    expect(result.totalOccurrenceCount).toBe(1);
  });

  it('keeps all-null provenance unassigned and G1/G2 as two occurrences', async () => {
    const plain = [
      priceRow('plain-a', { id: null, source: null, verifiedAt: null }),
      {
        ...priceRow('plain-b', { id: null, source: null, verifiedAt: null }),
        occurredAt: TX + 86_400_000,
        receiptTransactionAt: TX + 86_400_000,
      },
    ];
    const plainDb = loaderDb(plain);
    const plainResult = await loadProductPriceHistoryWithDb(plainDb, {
      type: 'sku',
      key: 'milk-sku',
    });
    expect(plainDb.queries[0]).toContain(ALIASES);
    expect(plainResult.totalOccurrenceCount).toBe(2);

    const split = [
      priceRow('g1', {
        id: 'vpo_g1',
        source: 'research_verified',
        verifiedAt: VERIFIED_AT,
      }),
      {
        ...priceRow('g2', {
          id: 'vpo_g2',
          source: 'research_verified',
          verifiedAt: VERIFIED_AT,
        }),
        occurredAt: TX + 86_400_000,
        receiptTransactionAt: TX + 86_400_000,
      },
    ];
    const splitResult = await loadProductPriceHistoryWithDb(loaderDb(split), {
      type: 'sku',
      key: 'milk-sku',
    });
    expect(splitResult.totalOccurrenceCount).toBe(2);
  });
});
