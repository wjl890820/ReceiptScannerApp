/**
 * Usage Relation Research Export V1 — owner scope, baskets, identity, privacy.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  getInitializedReceiptsDatabaseOrThrow: jest.fn(() => {
    throw new Error('Research export requires an already initialized local database.');
  }),
}));

import fs from 'fs';
import path from 'path';

import { buildCanonicalPurchaseOccurrenceIndex } from './canonicalPurchaseOccurrence';
import type { ReceiptRow } from './db';
import { PRODUCT_IDENTITY_RESOLVER_VERSION } from './productIdentityContract';
import { resolveReceiptItemIdentity } from './productIdentityResolver';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import { resolveReceiptMerchantScope } from './merchantScopeGeneration';
import {
  assertUsageRelationResearchFiniteNumbers,
  buildUsageRelationResearchExport,
  buildUsageRelationResearchExportFromLocalDb,
  buildUsageRelationResearchFilename,
  exportAndShareUsageRelationResearchData,
  serializeUsageRelationResearchExport,
  UsageRelationResearchExportError,
  UsageRelationResearchOwnerChangedError,
  loadPersonalProductDecisionsForCapturedOwner,
  type UsageRelationResearchItemIndexRow,
} from './usageRelationResearchExport';

const TX = Date.parse('2026-08-08T18:09:00+09:00');

function makeReceipt(
  id: string,
  opts: {
    transactionAt?: number | null;
    precision?: 'second' | 'minute' | 'date' | 'unknown';
    createdAt?: number;
    merchant?: string;
    merchantNormalized?: string;
    items?: unknown[];
    total?: number;
    userItems?: unknown[] | null;
    userEdited?: number;
    verifiedId?: string | null;
    verifiedSource?: string | null;
    verifiedAt?: number | null;
    storeRaw?: string | null;
    storeNormalized?: string | null;
    merchantScopeGeneration?: number | null;
  } = {}
): ReceiptRow {
  const items = opts.items ?? [
    { name: 'パプリカ', quantity: 1, lineTotal: 128 },
  ];
  const total =
    opts.total ??
    (items as { lineTotal?: number }[]).reduce(
      (sum, item) => sum + (item.lineTotal ?? 0),
      0
    );
  const precision = opts.precision ?? 'minute';
  const analysis = {
    merchant: opts.merchant ?? '業務スーパー',
    total,
    tax: 10,
    tax_is_known: true,
    currency: 'JPY',
    is_grocery: true,
    merchant_type: 'supermarket',
    items,
    transaction_time_precision: precision,
  };
  return {
    id,
    created_at: opts.createdAt ?? 1_700_000_000_000,
    transaction_at: opts.transactionAt === undefined ? TX : opts.transactionAt,
    transaction_time_precision: precision,
    image_uri: `file:///private/receipt-${id}.jpg`,
    merchant_raw: opts.merchant ?? '業務スーパー古川店',
    merchant_normalized: opts.merchantNormalized ?? '業務スーパー',
    merchant_type: 'supermarket',
    store_raw: opts.storeRaw ?? '古川店',
    store_normalized: opts.storeNormalized ?? '古川',
    merchant_scope_generation: opts.merchantScopeGeneration ?? 2,
    total,
    tax: 10,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify(analysis),
    user_edited: opts.userEdited ?? 0,
    final_total: null,
    final_category: null,
    note: 'private note must not export',
    user_items_json:
      opts.userItems === undefined
        ? null
        : opts.userItems === null
          ? null
          : JSON.stringify(opts.userItems),
    user_id: 'should-not-export',
    installation_id: 'install-should-not-export',
    ocr_request_id: 'ocr-should-not-export',
    verified_purchase_occurrence_id: opts.verifiedId ?? null,
    verified_purchase_occurrence_source: opts.verifiedSource ?? null,
    verified_purchase_occurrence_verified_at: opts.verifiedAt ?? null,
  } as ReceiptRow;
}

function indexRow(
  receiptId: string,
  sourceIndex: number,
  patch: Partial<UsageRelationResearchItemIndexRow> = {}
): UsageRelationResearchItemIndexRow {
  return {
    receipt_id: receiptId,
    source_index: sourceIndex,
    review_source_index: sourceIndex,
    raw_name: 'パプリカ',
    normalized_name: 'パプリカ',
    normalized_full_name: 'パプリカ',
    canonical_product_name: null,
    brand: null,
    product_family_key: null,
    category: null,
    sku_key: null,
    purchase_quantity: 1,
    item_source: 'ocr',
    identity_source: 'legacy_fallback',
    identity_confidence: 0.35,
    identity_version: 1,
    ...patch,
  };
}

function build(receipts: ReceiptRow[], rows: UsageRelationResearchItemIndexRow[] = [], personal: Map<string, { key: string; source: string; confidence: number | null }> | null = null) {
  return buildUsageRelationResearchExport({
    receipts,
    itemIndexRows: rows,
    exportedAt: '2026-10-08T00:00:00.000Z',
    app: { version: '1.2.3', build: '45' },
    personalProductByRowKey: personal,
  });
}

describe('Usage Relation Research Export', () => {
  it('exports one basket for duplicate rescans and keeps member receipt ids', () => {
    const items = [{ name: 'KS ITEM', quantity: 1, lineTotal: 899 }];
    const a = makeReceipt('rep-a', {
      items,
      total: 899,
      createdAt: 1,
      userEdited: 1,
      verifiedId: 'occ-1',
      verifiedSource: 'user_verified',
      verifiedAt: 50,
    });
    const b = makeReceipt('rep-b', {
      items,
      total: 899,
      createdAt: 2,
      verifiedId: 'occ-1',
      verifiedSource: 'user_verified',
      verifiedAt: 50,
    });
    const index = buildCanonicalPurchaseOccurrenceIndex([a, b]);
    expect(index.groups).toHaveLength(1);
    const doc = build([b, a], [indexRow('rep-a', 0, { raw_name: 'KS ITEM' })]);
    expect(doc.purchases).toHaveLength(1);
    expect(doc.datasetSummary.storedReceiptCount).toBe(2);
    expect(doc.datasetSummary.canonicalPurchaseCount).toBe(1);
    expect(doc.purchases[0]!.representativeReceiptId).toBe(
      index.groups[0]!.representativeReceiptId
    );
    expect(doc.purchases[0]!.representativeReceiptId).toBe('rep-a');
    expect(doc.purchases[0]!.receiptIds).toEqual(['rep-a', 'rep-b']);
    expect(doc.purchases[0]!.canonicalOccurrenceKey).toBe(index.groups[0]!.occurrenceKey);
    expect(doc.purchases[0]!.verifiedPurchaseOccurrenceId).toBe('occ-1');
    expect(doc.purchases[0]!.verifiedPurchaseOccurrenceSource).toBe('user_verified');
    expect(doc.purchases[0]!.verifiedPurchaseOccurrenceVerifiedAt).toBe(50);
    expect(doc.purchases[0]!.userEdited).toBe(true);
    expect(doc.purchases[0]!.items).toHaveLength(1);
    expect(doc.purchases[0]!.items[0]!.receiptId).toBe('rep-a');
  });

  it('keeps same-day same-store visits separate when occurrence truth does', () => {
    const morning = makeReceipt('visit-am', {
      items: [{ name: '牛乳', quantity: 1, lineTotal: 198 }],
      total: 198,
      transactionAt: TX,
      verifiedId: 'occ-am',
      verifiedSource: 'user_verified',
      verifiedAt: 1,
    });
    const evening = makeReceipt('visit-pm', {
      items: [{ name: 'ビスケット', quantity: 2, lineTotal: 300 }],
      total: 300,
      transactionAt: TX + 60_000,
      createdAt: TX + 60_000,
      verifiedId: 'occ-pm',
      verifiedSource: 'user_verified',
      verifiedAt: 2,
    });
    const doc = build([evening, morning]);
    expect(doc.purchases.map((purchase) => purchase.canonicalOccurrenceKey)).toEqual([
      'verified:occ-am',
      'verified:occ-pm',
    ]);
    expect(doc.purchases[0]!.representativeReceiptId).toBe('visit-am');
    expect(doc.purchases[1]!.representativeReceiptId).toBe('visit-pm');
  });

  it('exports the reviewed item and does not adopt a conflicting index row', () => {
    const receipt = makeReceipt('r1', {
      items: [
        { name: 'OCR MILK', quantity: 1, lineTotal: 100 },
        { name: '消費税', quantity: 1, lineTotal: 10 },
      ],
      userItems: [
        { name: 'USER MILK', quantity: 2, lineTotal: 200, item_source: 'user_added' },
        { name: '現金', quantity: 1, lineTotal: 200 },
      ],
    });
    const personal = new Map([
      ['r1:0', { key: 'pp-stale', source: 'personal_manual', confidence: null }],
    ]);
    const doc = build(
      [receipt],
      [
        indexRow('r1', 0, {
          raw_name: 'STALE INDEX',
          normalized_name: 'stale milk',
          normalized_full_name: 'stale milk full',
          canonical_product_name: '牛乳',
          brand: '明治',
          product_family_key: 'milk',
          category: 'dairy',
          sku_key: 'sku-stale',
          purchase_quantity: 1,
          identity_source: 'legacy_fallback',
          identity_confidence: 0.35,
          identity_version: 1,
          review_source_index: 4,
        }),
      ],
      personal
    );
    expect(doc.purchases[0]!.items).toHaveLength(1);
    const item = doc.purchases[0]!.items[0]!;
    expect(item.receiptId).toBe('r1');
    expect(item.sourceIndex).toBe(0);
    expect(item.reviewSourceIndex).toBeNull();
    expect(item.rawName).toBe('USER MILK');
    expect(item.purchaseQuantity).toBe(2);
    expect(item.itemSource).toBe('user_added');
    expect(item.normalizedName).toBeNull();
    expect(item.canonicalProductName).toBeNull();
    expect(item.skuKey).toBeNull();
    expect(item.brand).toBeNull();
    expect(item.persistedIdentity).toEqual({
      source: null,
      confidence: null,
      version: null,
    });
    expect(item.persistedIdentityOrigin).toBe('unavailable');
    expect(item.personalProduct).toBeNull();
    expect(item.bestAvailableIdentity.kind).not.toBe('personal_product');
    expect(item.bestAvailableIdentity.key).not.toBe('sku-stale');
    expect(doc.datasetSummary.merchandiseObservationCount).toBe(1);
  });

  it('retains low-confidence legacy rows and does not promote them to canonical', () => {
    const receipt = makeReceipt('r-low', {
      items: [{ name: '牛乳', quantity: 1, lineTotal: 198, review_source_index: 0 }],
    });
    const doc = build([
      receipt,
    ], [
      indexRow('r-low', 0, {
        raw_name: '牛乳',
        canonical_product_name: '明治 おいしい牛乳',
        identity_source: 'legacy_fallback',
        identity_confidence: 0.35,
      }),
    ]);
    const item = doc.purchases[0]!.items[0]!;
    expect(item.persistedIdentity.source).toBe('legacy_fallback');
    expect(item.bestAvailableIdentity.kind).toBe('occurrence');
    expect(item.bestAvailableIdentity.key).toBe('r-low:0');
    expect(item.bestAvailableIdentity.source).toBe('unresolved');
    expect(item.bestAvailableIdentity.confidence).toBeNull();
    expect(item.canonicalProductName).toBe('明治 おいしい牛乳');
    expect(doc.datasetSummary.fallbackIdentityObservationCount).toBe(1);
    expect(doc.datasetSummary.trustedIdentityObservationCount).toBe(0);
  });

  it('uses personal_product, merchant_product, sku, then trusted canonical', () => {
    const personalReceipt = makeReceipt('r-personal', {
      items: [{ name: '午後の紅茶 500ml', quantity: 1, lineTotal: 160, review_source_index: 0 }],
    });
    const merchantReceipt = makeReceipt('r-merchant', {
      items: [{ name: '午後の紅茶 500ml', quantity: 1, lineTotal: 160, review_source_index: 0 }],
    });
    const skuReceipt = makeReceipt('r-sku', {
      items: [{ name: '牛乳', quantity: 1, lineTotal: 198, review_source_index: 0 }],
    });
    const canonicalReceipt = makeReceipt('r-canonical', {
      items: [{ name: '牛乳', quantity: 1, lineTotal: 198, review_source_index: 0 }],
    });
    const unknownReceipt = makeReceipt('r-unknown', {
      items: [{ name: '牛乳', quantity: 1, lineTotal: 198, review_source_index: 0 }],
    });
    const personal = new Map([
      [
        'r-personal:0',
        { key: 'pp-anchor', source: 'personal_manual', confidence: null },
      ],
    ]);
    const doc = build(
      [unknownReceipt, canonicalReceipt, skuReceipt, merchantReceipt, personalReceipt],
      [
        indexRow('r-personal', 0, {
          identity_source: 'legacy_fallback',
          identity_confidence: 0.35,
          canonical_product_name: '午後の紅茶',
        }),
        indexRow('r-merchant', 0, {
          identity_source: 'legacy_fallback',
          identity_confidence: 0.35,
        }),
        indexRow('r-sku', 0, {
          sku_key: 'sku-milk',
          identity_source: 'legacy_fallback',
          canonical_product_name: '牛乳',
        }),
        indexRow('r-canonical', 0, {
          identity_source: 'high_confidence_rule',
          identity_confidence: 0.99,
          canonical_product_name: '明治 おいしい牛乳',
        }),
        indexRow('r-unknown', 0, {
          identity_source: 'unknown',
          identity_confidence: 0.2,
          canonical_product_name: '牛乳',
        }),
      ],
      personal
    );
    const byReceipt = new Map(
      doc.purchases.map((purchase) => [
        purchase.representativeReceiptId,
        purchase.items[0]!,
      ])
    );
    const personalItem = byReceipt.get('r-personal')!;
    expect(personalItem.bestAvailableIdentity.kind).toBe('personal_product');
    expect(personalItem.bestAvailableIdentity.key).toBe('pp-anchor');
    expect(personalItem.personalProduct).toEqual({ key: 'pp-anchor' });
    expect(personalItem.persistedIdentity.source).toBe('legacy_fallback');

    const merchantItem = byReceipt.get('r-merchant')!;
    const scope = resolveReceiptMerchantScope({
      receiptId: 'r-merchant',
      merchantRaw: merchantReceipt.merchant_raw,
      merchantNormalized: merchantReceipt.merchant_normalized,
      merchantScopeGeneration: 2,
      merchantScopeGenerationPresence: 'present',
    });
    const resolved = resolveReceiptItemIdentity(
      {
        rawName: '午後の紅茶 500ml',
        merchantKey: scope.scopeKey,
        receiptId: 'r-merchant',
        itemSourceIndex: 0,
        quantity: 1,
        lineTotal: 160,
      },
      createMemoryProductIdentityStore()
    );
    expect(resolved.link.identityLevel).toBe('merchant_product');
    expect(merchantItem.bestAvailableIdentity).toMatchObject({
      kind: 'merchant_product',
      key: resolved.link.merchantProductId,
      source: resolved.link.identitySource,
    });
    expect(merchantItem.persistedIdentity.source).toBe('legacy_fallback');
    expect(merchantItem.personalProduct).toBeNull();

    expect(byReceipt.get('r-sku')!.bestAvailableIdentity).toMatchObject({
      kind: 'sku',
      key: 'sku-milk',
    });
    expect(byReceipt.get('r-canonical')!.bestAvailableIdentity).toMatchObject({
      kind: 'canonical',
      key: '明治 おいしい牛乳',
      source: 'high_confidence_rule',
      confidence: 0.99,
    });
    expect(byReceipt.get('r-unknown')!.bestAvailableIdentity.kind).toBe('occurrence');
    expect(doc.datasetSummary.identityKindCounts).toEqual({
      personal_product: 1,
      merchant_product: 1,
      sku: 1,
      canonical: 1,
      occurrence: 1,
    });
    expect(doc.personalProductResolution).toBe('ready');
    expect(doc.identityPipelineVersion).toBe(PRODUCT_IDENTITY_RESOLVER_VERSION);
  });

  it('keeps personal product null when resolution is unavailable', () => {
    const doc = build([
      makeReceipt('r-none', {
        items: [{ name: '午後の紅茶 500ml', quantity: 1, lineTotal: 160 }],
      }),
    ]);
    expect(doc.personalProductResolution).toBe('unavailable');
    expect(doc.purchases[0]!.items[0]!.personalProduct).toBeNull();
    expect(doc.purchases[0]!.items[0]!.bestAvailableIdentity.kind).not.toBe(
      'personal_product'
    );
  });

  it('preserves transaction precision and does not copy createdAt into transactionAt', () => {
    const precisions = ['second', 'minute', 'date', 'unknown'] as const;
    const receipts = precisions.map((precision, index) =>
      makeReceipt(`t-${precision}`, {
        precision,
        transactionAt: precision === 'unknown' ? null : TX + index,
        createdAt: 10 + index,
      })
    );
    const doc = build(receipts);
    for (const precision of precisions) {
      const purchase = doc.purchases.find(
        (row) => row.representativeReceiptId === `t-${precision}`
      )!;
      expect(purchase.transactionTimePrecision).toBe(precision);
      if (precision === 'unknown') {
        expect(purchase.transactionAt).toBeNull();
      } else {
        expect(purchase.transactionAt).not.toBe(purchase.createdAt);
      }
      expect(purchase.createdAt).toBe(
        receipts.find((receipt) => receipt.id === `t-${precision}`)!.created_at
      );
    }
  });

  it('orders purchases, receipt ids, and items deterministically', () => {
    const later = makeReceipt('z-later', {
      transactionAt: TX + 5_000,
      createdAt: 2,
      items: [
        { name: 'B', quantity: 1, lineTotal: 2 },
        { name: 'A', quantity: 1, lineTotal: 1 },
      ],
    });
    const earlier = makeReceipt('a-earlier', {
      transactionAt: TX,
      createdAt: 9,
      items: [{ name: 'EARLY', quantity: 1, lineTotal: 1 }],
    });
    const first = build([later, earlier]);
    const second = build([earlier, later]);
    expect(first.purchases.map((purchase) => purchase.representativeReceiptId)).toEqual([
      'a-earlier',
      'z-later',
    ]);
    expect(serializeUsageRelationResearchExport(first)).toBe(
      serializeUsageRelationResearchExport(second)
    );
    expect(first.purchases[1]!.items.map((item) => item.rawName)).toEqual(['B', 'A']);
    expect(first.purchases[1]!.items.map((item) => item.sourceIndex)).toEqual([0, 1]);
  });

  it('serializes finite JSON and a stable filename', () => {
    const receipt = makeReceipt('finite', {
      items: [{ name: 'パプリカ', quantity: 1, lineTotal: 10 }],
    });
    const doc = build([
      receipt,
    ], [
      indexRow('finite', 0, { identity_confidence: Number.POSITIVE_INFINITY }),
    ]);
    expect(doc.purchases[0]!.items[0]!.persistedIdentity.confidence).toBeNull();
    const json = serializeUsageRelationResearchExport(doc);
    expect(json).not.toMatch(/NaN|Infinity/);
    expect(() => assertUsageRelationResearchFiniteNumbers(JSON.parse(json))).not.toThrow();
    expect(buildUsageRelationResearchFilename(Date.UTC(2026, 9, 8, 3, 4, 5))).toMatch(
      /^meruno-usage-relation-research-\d{8}-\d{6}\.json$/
    );
    expect(doc.purchases[0]!.merchantScopeGeneration).toBe(2);
    expect(doc.purchases[0]!.storeRaw).toBe('古川店');
  });

  it('omits private receipt fields from serialized JSON', () => {
    const doc = build([makeReceipt('secret')]);
    const json = serializeUsageRelationResearchExport(doc);
    for (const forbidden of [
      'image_uri',
      'recognition_snapshot_json',
      'analysis_json',
      'user_items_json',
      'user_id',
      'installation_id',
      'ocr_request_id',
      'note',
      'file:///private',
      'should-not-export',
      'private note',
    ]) {
      expect(json.includes(forbidden)).toBe(false);
    }
    expect(json).toContain(USAGE_RELATION_RESEARCH_PRIVACY_FROM_DOC(doc));
  });

  it('fails closed when owner scope is unavailable and excludes another owner', async () => {
    const calls: string[] = [];
    const writes = { n: 0 };
    const stored = [
      { ...makeReceipt('owned'), user_id: 'owner-a' },
      { ...makeReceipt('other'), user_id: 'owner-b' },
    ];
    const db = {
      runAsync: async () => {
        writes.n += 1;
      },
      execAsync: async () => {
        writes.n += 1;
      },
      getAllAsync: async <T>(sql: string, params?: unknown): Promise<T[]> => {
        calls.push(sql);
        if (/\b(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i.test(sql)) writes.n += 1;
        const ownerId = Array.isArray(params) ? params[0] : undefined;
        const visible = stored.filter((receipt) => receipt.user_id === ownerId);
        if (sql.includes('receipt_items')) {
          const ids = new Set(visible.map((receipt) => receipt.id));
          return [indexRow('owned', 0), indexRow('other', 0)].filter((row) =>
            ids.has(row.receipt_id)
          ) as T[];
        }
        return visible as T[];
      },
    };
    await expect(
      buildUsageRelationResearchExportFromLocalDb({
        db,
        resolveOwnerScope: async () => ({ status: 'owner_unavailable' }),
        loadPersonalInventory: async () => ({ status: 'unavailable' }),
      })
    ).rejects.toBeInstanceOf(UsageRelationResearchExportError);
    expect(calls).toHaveLength(0);

    const doc = await buildUsageRelationResearchExportFromLocalDb({
      db,
      resolveOwnerScope: async () => ({
        status: 'ready',
        ownerKey: 'user:owner-a',
        receiptWhereSql: 'receipts.user_id = ?',
        itemWhereSql: 'receipts.user_id = ?',
        params: ['owner-a'],
      }),
      loadPersonalInventory: async () => ({ status: 'unavailable' }),
      now: new Date('2026-10-08T00:00:00.000Z'),
    });
    expect(calls.every((sql) => sql.includes('receipts.user_id = ?'))).toBe(true);
    expect(calls.some((sql) => sql.includes('image_uri'))).toBe(false);
    expect(calls.some((sql) => sql.includes('user_id,'))).toBe(false);
    expect(doc.purchases.map((purchase) => purchase.representativeReceiptId)).toEqual([
      'owned',
    ]);
    expect(doc.personalProductResolution).toBe('unavailable');
    expect(writes.n).toBe(0);
  });

  it('shares a cache JSON file and does not touch write APIs', async () => {
    const shared: { uri?: string; options?: { mimeType?: string; UTI?: string } } = {};
    let written = '';
    const result = await exportAndShareUsageRelationResearchData({
      db: {
        getAllAsync: async <T>(sql: string): Promise<T[]> => {
          if (sql.includes('receipt_items')) return [] as T[];
          return [makeReceipt('only')] as T[];
        },
      },
      resolveOwnerScope: async () => ({
        status: 'ready',
        ownerKey: 'user:owner-a',
        receiptWhereSql: 'receipts.user_id = ?',
        itemWhereSql: 'receipts.user_id = ?',
        params: ['owner-a'],
      }),
      loadPersonalInventory: async () => ({ status: 'unavailable' }),
      cacheDirectory: 'file:///cache/',
      writeAsStringAsync: async (_uri, contents) => {
        written = contents;
      },
      isAvailableAsync: async () => true,
      shareAsync: async (uri, options) => {
        shared.uri = uri;
        shared.options = options;
      },
      now: new Date('2026-10-08T01:02:03.000Z'),
    });
    expect(result.filename).toMatch(/^meruno-usage-relation-research-\d{8}-\d{6}\.json$/);
    expect(shared.uri).toBe(`file:///cache/${result.filename}`);
    expect(shared.options).toEqual({
      mimeType: 'application/json',
      UTI: 'public.json',
      dialogTitle: result.filename,
    });
    expect(written).toContain('"schemaVersion": 1');
  });

  it('aborts when personal inventory owner does not match the captured owner', async () => {
    const writes: string[] = [];
    await expect(
      exportAndShareUsageRelationResearchData({
        db: {
          getAllAsync: async <T>(): Promise<T[]> => [],
        },
        resolveOwnerScope: async () => ({
          status: 'ready',
          ownerKey: 'user:owner-a',
          receiptWhereSql: 'receipts.user_id = ?',
          itemWhereSql: 'receipts.user_id = ?',
          params: ['owner-a'],
        }),
        loadPersonalInventory: async () => ({
          status: 'ready',
          inventory: {
            ownerKey: 'user:owner-b',
            merchantProductsById: new Map(),
          } as never,
        }),
        cacheDirectory: 'file:///cache/',
        writeAsStringAsync: async (uri) => {
          writes.push(uri);
        },
        isAvailableAsync: async () => true,
        shareAsync: async () => {
          writes.push('share');
        },
      })
    ).rejects.toThrow(/captured owner/);
    expect(writes).toEqual([]);
  });

  it('aborts file write when the owner changes or disappears', async () => {
    const writes: string[] = [];
    let reads = 0;
    const switching = async () => {
      reads += 1;
      if (reads === 1) {
        return {
          status: 'ready' as const,
          ownerKey: 'user:owner-a',
          receiptWhereSql: 'receipts.user_id = ?',
          itemWhereSql: 'receipts.user_id = ?',
          params: ['owner-a'],
        };
      }
      return {
        status: 'ready' as const,
        ownerKey: 'user:owner-b',
        receiptWhereSql: 'receipts.user_id = ?',
        itemWhereSql: 'receipts.user_id = ?',
        params: ['owner-b'],
      };
    };
    await expect(
      exportAndShareUsageRelationResearchData({
        db: { getAllAsync: async <T>(): Promise<T[]> => [] },
        resolveOwnerScope: switching,
        loadPersonalInventory: async (_db, ownerKey) => {
          expect(ownerKey).toBe('user:owner-a');
          return { status: 'unavailable' };
        },
        cacheDirectory: 'file:///cache/',
        writeAsStringAsync: async (uri) => {
          writes.push(uri);
        },
        isAvailableAsync: async () => true,
        shareAsync: async () => {
          writes.push('share');
        },
      })
    ).rejects.toBeInstanceOf(UsageRelationResearchOwnerChangedError);
    expect(writes).toEqual([]);

    writes.length = 0;
    reads = 0;
    await expect(
      exportAndShareUsageRelationResearchData({
        db: { getAllAsync: async <T>(): Promise<T[]> => [] },
        resolveOwnerScope: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              status: 'ready' as const,
              ownerKey: 'user:owner-a',
              receiptWhereSql: 'receipts.user_id = ?',
              itemWhereSql: 'receipts.user_id = ?',
              params: ['owner-a'],
            };
          }
          return { status: 'owner_unavailable' };
        },
        loadPersonalInventory: async () => ({ status: 'unavailable' }),
        cacheDirectory: 'file:///cache/',
        writeAsStringAsync: async (uri) => {
          writes.push(uri);
        },
        isAvailableAsync: async () => true,
        shareAsync: async () => undefined,
      })
    ).rejects.toBeInstanceOf(UsageRelationResearchOwnerChangedError);
    expect(writes).toEqual([]);
  });

  it('keeps personal inventory select-only and owner-bound', async () => {
    const sqls: { sql: string; params: unknown }[] = [];
    const absent = await loadPersonalProductDecisionsForCapturedOwner(
      {
        getAllAsync: async <T>(sql: string, params?: unknown): Promise<T[]> => {
          sqls.push({ sql, params });
          if (/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql)) {
            throw new Error('write sql');
          }
          if (sql.includes('sqlite_master')) return [] as T[];
          return [] as T[];
        },
      },
      'user:owner-a'
    );
    expect(absent).toBeNull();
    expect(sqls.some((call) => /CREATE|ensurePersonal/i.test(call.sql))).toBe(false);

    sqls.length = 0;
    const present = await loadPersonalProductDecisionsForCapturedOwner(
      {
        getAllAsync: async <T>(sql: string, params?: unknown): Promise<T[]> => {
          sqls.push({ sql, params });
          if (sql.includes('sqlite_master')) {
            return [{ name: 'personal_product_identity_decisions' }] as T[];
          }
          return [
            {
              owner_key: 'user:owner-a',
              left_merchant_product_id: 'mp-a',
              right_merchant_product_id: 'mp-b',
              left_merchant_scope_key: 'm',
              right_merchant_scope_key: 'm',
              left_comparison_key: 'c',
              right_comparison_key: 'c',
              left_structural_signature: 's',
              right_structural_signature: 's',
              identity_pipeline_version: 'v',
              decision: 'same_product',
              created_at: 1,
              updated_at: 2,
            },
            {
              owner_key: 'user:owner-b',
              left_merchant_product_id: 'mp-other',
              right_merchant_product_id: 'mp-b',
              left_merchant_scope_key: 'm',
              right_merchant_scope_key: 'm',
              left_comparison_key: 'c',
              right_comparison_key: 'c',
              left_structural_signature: 's',
              right_structural_signature: 's',
              identity_pipeline_version: 'v',
              decision: 'same_product',
              created_at: 1,
              updated_at: 2,
            },
          ] as T[];
        },
      },
      'user:owner-a'
    );
    expect(sqls.some((call) => call.sql.includes('owner_key = ?'))).toBe(true);
    expect(sqls.some((call) => Array.isArray(call.params) && call.params[0] === 'user:owner-a')).toBe(
      true
    );
    expect(present?.map((row) => row.ownerKey)).toEqual(['user:owner-a']);
    expect(present?.some((row) => row.leftMerchantProductId === 'mp-other')).toBe(false);
  });

  it('reconciles only proven review_source_index rows', () => {
    const removed = makeReceipt('removed', {
      transactionAt: TX + 1,
      userItems: [
        { name: 'KEPT', quantity: 1, lineTotal: 10, review_source_index: 1 },
      ],
    });
    const reordered = makeReceipt('reordered', {
      transactionAt: TX + 2,
      userItems: [
        { name: 'SECOND', quantity: 1, lineTotal: 2, review_source_index: 1 },
        { name: 'FIRST', quantity: 1, lineTotal: 1, review_source_index: 0 },
      ],
    });
    const added = makeReceipt('added', {
      transactionAt: TX + 3,
      userItems: [{ name: 'NEW', quantity: 1, lineTotal: 5, user_added: true }],
    });
    const conflict = makeReceipt('conflict', {
      transactionAt: TX + 4,
      userItems: [
        { name: 'NOW', quantity: 1, lineTotal: 5, review_source_index: 7 },
      ],
    });
    const matched = makeReceipt('matched', {
      transactionAt: TX + 5,
      userItems: [
        {
          name: 'SAME',
          quantity: 1,
          lineTotal: 5,
          review_source_index: 3,
        },
      ],
    });
    const missing = makeReceipt('missing', {
      transactionAt: TX + 6,
      userItems: [
        { name: 'PLAIN', quantity: 1, lineTotal: 5, review_source_index: 0 },
      ],
    });
    const unchanged = makeReceipt('unchanged', {
      transactionAt: TX + 7,
      userItems: [
        { name: '牛乳', quantity: 1, lineTotal: 5, review_source_index: 0 },
      ],
    });
    const onReviewed = makeReceipt('on-item', {
      transactionAt: TX + 8,
      userItems: [
        {
          name: '牛乳',
          quantity: 1,
          lineTotal: 5,
          review_source_index: 9,
          identity_version: 1,
          identity_source: 'user_confirmed',
          identity_confidence: 1,
          canonical_product_name: '確認牛乳',
          sku_key: 'sku-reviewed',
        },
      ],
    });
    const personal = new Map([
      ['reordered:0', { key: 'pp-first', source: 'personal_manual', confidence: null }],
      ['reordered:1', { key: 'pp-second', source: 'personal_manual', confidence: null }],
      ['matched:4', { key: 'pp-matched', source: 'personal_manual', confidence: null }],
      ['conflict:0', { key: 'pp-conflict', source: 'personal_manual', confidence: null }],
    ]);
    const doc = build(
      [removed, reordered, added, conflict, matched, missing, unchanged, onReviewed],
      [
        indexRow('removed', 0, {
          raw_name: 'GONE',
          review_source_index: 0,
          identity_source: 'user_confirmed',
          sku_key: 'sku-gone',
          canonical_product_name: '消えた',
        }),
        indexRow('removed', 1, {
          raw_name: 'KEPT',
          review_source_index: 1,
          identity_source: 'dictionary',
          identity_confidence: 0.9,
          canonical_product_name: '残った',
        }),
        indexRow('reordered', 0, {
          raw_name: 'FIRST',
          review_source_index: 0,
          identity_source: 'dictionary',
          canonical_product_name: '先',
          sku_key: 'sku-first',
        }),
        indexRow('reordered', 1, {
          raw_name: 'SECOND',
          review_source_index: 1,
          identity_source: 'merchant_alias',
          canonical_product_name: '後',
          sku_key: 'sku-second',
        }),
        indexRow('added', 0, {
          raw_name: 'OLD',
          review_source_index: 0,
          identity_source: 'dictionary',
          sku_key: 'sku-old',
          canonical_product_name: '古い',
        }),
        indexRow('conflict', 0, {
          raw_name: 'OTHER',
          review_source_index: 0,
          identity_source: 'dictionary',
          sku_key: 'sku-other',
          canonical_product_name: '別商品',
        }),
        indexRow('matched', 4, {
          raw_name: 'SAME',
          review_source_index: 3,
          identity_source: 'high_confidence_rule',
          identity_confidence: 0.99,
          canonical_product_name: '一致',
        }),
        indexRow('unchanged', 0, {
          raw_name: '牛乳',
          review_source_index: 0,
          identity_source: 'legacy_fallback',
          identity_confidence: 0.35,
          canonical_product_name: '牛乳表示',
        }),
        indexRow('on-item', 0, {
          raw_name: 'INDEX',
          review_source_index: 0,
          identity_source: 'dictionary',
          sku_key: 'sku-index',
          canonical_product_name: '索引名',
        }),
      ],
      personal
    );
    const byId = new Map(
      doc.purchases.map((purchase) => [purchase.representativeReceiptId, purchase])
    );

    const kept = byId.get('removed')!.items[0]!;
    expect(kept.rawName).toBe('KEPT');
    expect(kept.persistedIdentity.source).toBe('dictionary');
    expect(kept.canonicalProductName).toBe('残った');
    expect(kept.skuKey).not.toBe('sku-gone');
    expect(kept.personalProduct).toBeNull();

    const second = byId.get('reordered')!.items[0]!;
    const first = byId.get('reordered')!.items[1]!;
    expect(second.rawName).toBe('SECOND');
    expect(second.canonicalProductName).toBe('後');
    expect(second.personalProduct).toEqual({ key: 'pp-second' });
    expect(second.bestAvailableIdentity.kind).toBe('personal_product');
    expect(first.rawName).toBe('FIRST');
    expect(first.skuKey).toBe('sku-first');
    expect(first.personalProduct).toEqual({ key: 'pp-first' });
    expect(first.bestAvailableIdentity.key).toBe('pp-first');
    expect(second.bestAvailableIdentity.key).not.toBe('pp-first');

    const userAdded = byId.get('added')!.items[0]!;
    expect(userAdded.rawName).toBe('NEW');
    expect(userAdded.persistedIdentityOrigin).toBe('unavailable');
    expect(userAdded.skuKey).toBeNull();
    expect(userAdded.personalProduct).toBeNull();

    const conflicting = byId.get('conflict')!.items[0]!;
    expect(conflicting.rawName).toBe('NOW');
    expect(conflicting.persistedIdentityOrigin).toBe('unavailable');
    expect(conflicting.canonicalProductName).toBeNull();
    expect(conflicting.personalProduct).toBeNull();
    expect(conflicting.bestAvailableIdentity.kind).not.toBe('personal_product');

    const proven = byId.get('matched')!.items[0]!;
    expect(proven.sourceIndex).toBe(0);
    expect(proven.reviewSourceIndex).toBe(3);
    expect(proven.persistedIdentityOrigin).toBe('reconciled_index');
    expect(proven.persistedIdentity.source).toBe('high_confidence_rule');
    expect(proven.personalProduct).toEqual({ key: 'pp-matched' });

    const absent = byId.get('missing')!.items[0]!;
    expect(absent.rawName).toBe('PLAIN');
    expect(absent.persistedIdentityOrigin).toBe('unavailable');

    const same = byId.get('unchanged')!.items[0]!;
    expect(same.persistedIdentity.source).toBe('legacy_fallback');
    expect(same.persistedIdentityOrigin).toBe('reconciled_index');
    expect(same.bestAvailableIdentity.kind).toBe('occurrence');
    expect(same.personalProduct).toBeNull();

    const reviewedTruth = byId.get('on-item')!.items[0]!;
    expect(reviewedTruth.persistedIdentityOrigin).toBe('reviewed_item');
    expect(reviewedTruth.persistedIdentity.source).toBe('user_confirmed');
    expect(reviewedTruth.canonicalProductName).toBe('確認牛乳');
    expect(reviewedTruth.skuKey).toBe('sku-reviewed');
    expect(reviewedTruth.bestAvailableIdentity).toMatchObject({
      kind: 'sku',
      key: 'sku-reviewed',
    });
    expect(reviewedTruth.canonicalProductName).not.toBe('索引名');
  });

  it('serializes merchant scope generation as 2 or null', () => {
    const values: unknown[] = [
      null,
      undefined,
      2,
      1,
      3,
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '2',
    ];
    const receipts = values.map((value, index) => {
      const receipt = makeReceipt(`gen-${index}`, {
        items: [{ name: `品${index}`, quantity: 1, lineTotal: 1 }],
        transactionAt: TX + index,
      });
      if (value === undefined) {
        delete receipt.merchant_scope_generation;
      } else {
        (receipt as { merchant_scope_generation?: unknown }).merchant_scope_generation =
          value;
      }
      return receipt;
    });
    const doc = build(receipts);
    const exported = doc.purchases.map((purchase) => purchase.merchantScopeGeneration);
    expect(exported).toEqual([null, null, 2, null, null, null, null, null, null]);
  });

  function readyOwner(ownerKey: string, userId: string) {
    return {
      status: 'ready' as const,
      ownerKey,
      receiptWhereSql: 'receipts.user_id = ?',
      itemWhereSql: 'receipts.user_id = ?',
      params: [userId],
    };
  }

  it('keeps the captured owner through share initiation', async () => {
    const events: string[] = [];
    let reads = 0;
    const shareCalls: string[] = [];
    const deleted: string[] = [];

    const run = (
      nextOwner: (
        read: number
      ) => ReturnType<typeof readyOwner> | { status: 'owner_unavailable' }
    ) =>
      exportAndShareUsageRelationResearchData({
        db: { getAllAsync: async <T>(): Promise<T[]> => [] },
        resolveOwnerScope: async () => {
          reads += 1;
          events.push(`owner-${reads}`);
          return nextOwner(reads);
        },
        loadPersonalInventory: async () => ({ status: 'unavailable' }),
        cacheDirectory: 'file:///cache/',
        writeAsStringAsync: async (uri) => {
          events.push(`write:${uri}`);
        },
        deleteAsync: async (uri) => {
          events.push(`delete:${uri}`);
          deleted.push(uri);
        },
        isAvailableAsync: async () => {
          events.push('available');
          return true;
        },
        shareAsync: async (uri) => {
          events.push('share');
          shareCalls.push(uri);
        },
        now: new Date('2026-10-08T01:02:03.000Z'),
      });

    reads = 0;
    events.length = 0;
    await expect(
      run((read) =>
        read === 1
          ? readyOwner('user:owner-a', 'owner-a')
          : readyOwner('user:owner-b', 'owner-b')
      )
    ).rejects.toBeInstanceOf(UsageRelationResearchOwnerChangedError);
    expect(events.some((event) => event.startsWith('write:'))).toBe(false);
    expect(shareCalls).toEqual([]);

    reads = 0;
    events.length = 0;
    deleted.length = 0;
    shareCalls.length = 0;
    await expect(
      run((read) =>
        read < 3
          ? readyOwner('user:owner-a', 'owner-a')
          : readyOwner('user:owner-b', 'owner-b')
      )
    ).rejects.toBeInstanceOf(UsageRelationResearchOwnerChangedError);
    const written = events.find((event) => event.startsWith('write:'));
    expect(written).toBeTruthy();
    expect(events.indexOf('available')).toBeGreaterThan(events.indexOf(written!));
    expect(events.indexOf('owner-3')).toBeGreaterThan(events.indexOf('available'));
    expect(deleted).toEqual([written!.slice('write:'.length)]);
    expect(shareCalls).toEqual([]);

    reads = 0;
    events.length = 0;
    deleted.length = 0;
    await expect(
      run((read) =>
        read < 3
          ? readyOwner('user:owner-a', 'owner-a')
          : { status: 'owner_unavailable' }
      )
    ).rejects.toBeInstanceOf(UsageRelationResearchOwnerChangedError);
    expect(deleted).toHaveLength(1);
    expect(shareCalls).toEqual([]);

    reads = 0;
    events.length = 0;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      exportAndShareUsageRelationResearchData({
        db: { getAllAsync: async <T>(): Promise<T[]> => [] },
        resolveOwnerScope: async () => {
          reads += 1;
          return reads < 3
            ? readyOwner('user:owner-a', 'owner-a')
            : readyOwner('user:owner-b', 'owner-b');
        },
        loadPersonalInventory: async () => ({ status: 'unavailable' }),
        cacheDirectory: 'file:///cache/',
        writeAsStringAsync: async () => undefined,
        deleteAsync: async () => {
          throw new Error('cleanup failed');
        },
        isAvailableAsync: async () => true,
        shareAsync: async () => {
          shareCalls.push('shared');
        },
      })
    ).rejects.toBeInstanceOf(UsageRelationResearchOwnerChangedError);
    expect(shareCalls).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    reads = 0;
    events.length = 0;
    shareCalls.length = 0;
    deleted.length = 0;
    const shared = await run(() => readyOwner('user:owner-a', 'owner-a'));
    expect(shareCalls).toEqual([shared.fileUri]);
    expect(events).toEqual([
      'owner-1',
      'owner-2',
      `write:${shared.fileUri}`,
      'available',
      'owner-3',
      'share',
    ]);
    expect(deleted).toEqual([]);

    const source = fs.readFileSync(
      path.join(__dirname, 'usageRelationResearchExport.ts'),
      'utf8'
    );
    const finalCheck = source.lastIndexOf(
      'if (!(await ownerMatchesCaptured(resolveScope, capturedOwnerKey)))'
    );
    const shareAwait = source.indexOf('await deps.shareAsync(', finalCheck);
    const between = source.slice(finalCheck, shareAwait);
    expect(between).toContain('discardUnsharedResearchFile');
    expect(between).toContain('UsageRelationResearchOwnerChangedError');
    expect(between).not.toMatch(
      /await\s+(?!ownerMatchesCaptured|discardUnsharedResearchFile)/
    );
  });

  it('does not borrow index identity fields into a partial reviewed identity', () => {
    const partial = makeReceipt('partial', {
      transactionAt: TX + 1,
      userItems: [
        {
          name: '牛乳',
          quantity: 1,
          lineTotal: 10,
          review_source_index: 0,
          identity_version: 1,
          identity_source: 'user_confirmed',
          identity_confidence: 1,
        },
      ],
    });
    const canonicalOnly = makeReceipt('canonical-only', {
      transactionAt: TX + 2,
      userItems: [
        {
          name: '牛乳',
          quantity: 1,
          lineTotal: 10,
          review_source_index: 0,
          identity_version: 1,
          identity_source: 'user_confirmed',
          identity_confidence: 1,
          canonical_product_name: '確認牛乳',
        },
      ],
    });
    const personal = new Map([
      ['partial:0', { key: 'pp-index', source: 'personal_manual', confidence: null }],
      [
        'canonical-only:0',
        { key: 'pp-index-2', source: 'personal_manual', confidence: null },
      ],
    ]);
    const doc = build(
      [partial, canonicalOnly],
      [
        indexRow('partial', 0, {
          review_source_index: 0,
          canonical_product_name: 'INDEX CANONICAL',
          sku_key: 'INDEX SKU',
          brand: 'INDEX BRAND',
          product_family_key: 'milk',
          identity_source: 'dictionary',
          identity_confidence: 0.8,
        }),
        indexRow('canonical-only', 0, {
          review_source_index: 0,
          canonical_product_name: 'INDEX CANONICAL',
          sku_key: 'INDEX SKU',
          brand: 'INDEX BRAND',
          product_family_key: 'milk',
        }),
      ],
      personal
    );
    const partialItem = doc.purchases[0]!.items[0]!;
    expect(partialItem.persistedIdentityOrigin).toBe('reviewed_item');
    expect(partialItem.persistedIdentity).toEqual({
      source: 'user_confirmed',
      confidence: 1,
      version: 1,
    });
    expect(partialItem.canonicalProductName).toBeNull();
    expect(partialItem.skuKey).toBeNull();
    expect(partialItem.brand).toBeNull();
    expect(partialItem.productFamilyKey).toBeNull();
    expect(partialItem.personalProduct).toBeNull();
    expect(partialItem.bestAvailableIdentity.kind).toBe('occurrence');
    expect(JSON.stringify(partialItem)).not.toContain('INDEX CANONICAL');
    expect(JSON.stringify(partialItem)).not.toContain('INDEX SKU');
    expect(JSON.stringify(partialItem)).not.toContain('INDEX BRAND');

    const canonicalItem = doc.purchases[1]!.items[0]!;
    expect(canonicalItem.persistedIdentityOrigin).toBe('reviewed_item');
    expect(canonicalItem.canonicalProductName).toBe('確認牛乳');
    expect(canonicalItem.skuKey).toBeNull();
    expect(canonicalItem.brand).toBeNull();
    expect(canonicalItem.productFamilyKey).toBeNull();
    expect(canonicalItem.personalProduct).toBeNull();
    expect(canonicalItem.bestAvailableIdentity).toMatchObject({
      kind: 'canonical',
      key: '確認牛乳',
      source: 'user_confirmed',
    });
  });

  it('fails closed when review_source_index provenance is not unique', () => {
    const duplicatedItems = makeReceipt('dup-items', {
      transactionAt: TX + 1,
      userItems: [
        { name: '左', quantity: 1, lineTotal: 1, review_source_index: 4 },
        { name: '右', quantity: 1, lineTotal: 2, review_source_index: 4 },
      ],
    });
    const duplicatedIndex = makeReceipt('dup-index', {
      transactionAt: TX + 2,
      userItems: [
        { name: '一つ', quantity: 1, lineTotal: 3, review_source_index: 2 },
      ],
    });
    const personal = new Map([
      ['dup-items:0', { key: 'pp-dup', source: 'personal_manual', confidence: null }],
      ['dup-index:0', { key: 'pp-a', source: 'personal_manual', confidence: null }],
      ['dup-index:1', { key: 'pp-b', source: 'personal_manual', confidence: null }],
    ]);
    const doc = build(
      [duplicatedItems, duplicatedIndex],
      [
        indexRow('dup-items', 0, {
          review_source_index: 4,
          sku_key: 'INDEX SKU',
          canonical_product_name: 'INDEX CANONICAL',
          identity_source: 'dictionary',
        }),
        indexRow('dup-index', 0, {
          review_source_index: 2,
          sku_key: 'SKU-A',
          identity_source: 'dictionary',
        }),
        indexRow('dup-index', 1, {
          review_source_index: 2,
          sku_key: 'SKU-B',
          identity_source: 'merchant_alias',
        }),
      ],
      personal
    );
    expect(doc.purchases[0]!.items).toHaveLength(2);
    for (const item of doc.purchases[0]!.items) {
      expect(item.persistedIdentityOrigin).toBe('unavailable');
      expect(item.skuKey).toBeNull();
      expect(item.personalProduct).toBeNull();
    }
    const only = doc.purchases[1]!.items[0]!;
    expect(only.rawName).toBe('一つ');
    expect(only.persistedIdentityOrigin).toBe('unavailable');
    expect(only.skuKey).toBeNull();
    expect(only.personalProduct).toBeNull();
    const originTotal = Object.values(
      doc.datasetSummary.persistedIdentityOriginCounts
    ).reduce((sum, count) => sum + count, 0);
    expect(originTotal).toBe(doc.datasetSummary.merchandiseObservationCount);
    expect(doc.datasetSummary.persistedIdentityOriginCounts).toEqual({
      reviewed_item: 0,
      reconciled_index: 0,
      unavailable: 3,
    });
  });

  it('does not claim read-only from source text alone', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'usageRelationResearchExport.ts'),
      'utf8'
    );
    expect(source.includes('initIfNeeded')).toBe(false);
    expect(source.includes('ensureAnonAuth')).toBe(false);
    expect(source.includes('ensurePersonalProductIdentitySchema')).toBe(false);
    expect(source.includes('getOrCreateInstallationId')).toBe(false);
    expect(source.includes('resolveCurrentLocalReceiptOwnerScope')).toBe(false);
    expect(source.includes('loadPersonalProductEndpointInventoryWithDb')).toBe(false);
    expect(source.includes('CREATE TABLE')).toBe(false);
    expect(source.includes('clipboard')).toBe(false);
  });
});

function USAGE_RELATION_RESEARCH_PRIVACY_FROM_DOC(doc: {
  privacyWarning: string;
}): string {
  return doc.privacyWarning;
}
