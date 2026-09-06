/**
 * Experiment Snapshot Export V1 — assembler / privacy / read-only / stability tests.
 */

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));

const mockInitIfNeeded = jest.fn(async () => undefined);
const mockGetInitializedReceiptsDatabaseOrThrow = jest.fn(() => {
  throw Object.assign(
    new Error('Experiment Snapshot requires an already initialized local database.'),
    { name: 'ReceiptsDatabaseNotInitializedError' }
  );
});

jest.mock('./db', () => ({
  initIfNeeded: () => mockInitIfNeeded(),
  listReceiptsForAnalysis: jest.fn(async () => []),
  getReceiptsDatabase: jest.fn(),
  listReceiptsForAnalysisWithDb: jest.fn(async () => []),
  getInitializedReceiptsDatabaseOrThrow: () =>
    mockGetInitializedReceiptsDatabaseOrThrow(),
  ReceiptsDatabaseNotInitializedError: class ReceiptsDatabaseNotInitializedError extends Error {
    constructor(
      message = 'Experiment Snapshot requires an already initialized local database.'
    ) {
      super(message);
      this.name = 'ReceiptsDatabaseNotInitializedError';
    }
  },
}));

import * as fs from 'fs';
import * as path from 'path';

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import type { ReceiptRow } from './db';
import { ReceiptsDatabaseNotInitializedError } from './db';
import {
  assertExperimentSnapshotFiniteNumbers,
  assertExperimentSnapshotJsonSafe,
  buildExperimentSnapshot,
  buildExperimentSnapshotFilename,
  buildExperimentSnapshotFromLocalDb,
  EXPERIMENT_SNAPSHOT_FORBIDDEN_JSON_SUBSTRINGS,
  EXPERIMENT_SNAPSHOT_RECEIPT_ITEM_UNIVERSE,
  EXPERIMENT_SNAPSHOT_SCHEMA_VERSION,
  resolveExperimentSnapshotExperimentMeta,
  serializeExperimentSnapshot,
  shouldExportFullPriceHistoryDetail,
} from './experimentSnapshotExport';
import {
  assertExperimentSnapshotExperimentInput,
  deriveNextReceiptSequence,
  InvalidExperimentSnapshotExperimentMetaError,
  readExperimentSnapshotSequencePreferenceFromStorageValues,
} from './experimentSnapshotSettings';
import { makeTrustedG3TestRow } from './productPriceHistory.testFixtures';
import {
  buildProductPriceHistory,
  type ProductPriceHistoryResult,
} from './productPriceHistory';

const nowMs = Date.parse('2026-09-06T12:00:00+09:00');
const MS_DAY = 86_400_000;
const MERCHANT = 'ヨークベニマル';
const PRODUCT = '横浜家系';

function makeReceipt(args: {
  id: string;
  at: number;
  items: Array<{
    name: string;
    category: string;
    lineTotal: number;
    quantity: number;
  }>;
  createdAt?: number;
  tax?: number;
  taxIsKnown?: number;
  total?: number;
  imageUri?: string;
}): ReceiptRow {
  const itemSum = args.items.reduce((sum, item) => sum + item.lineTotal, 0);
  return {
    id: args.id,
    created_at: args.createdAt ?? args.at,
    transaction_at: args.at,
    image_uri: args.imageUri ?? 'file:///private/receipt.jpg',
    total: args.total ?? itemSum,
    tax: args.tax ?? 10,
    tax_is_known: args.taxIsKnown ?? 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: args.items,
      secret_should_not_export: true,
    }),
    recognition_snapshot_json: JSON.stringify({ ocr: 'FULL RAW OCR TEXT' }),
    merchant_raw: MERCHANT,
    merchant_normalized: MERCHANT,
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  } as ReceiptRow;
}

function mpRow(
  id: string,
  gross: number,
  overrides: Partial<ReturnType<typeof makeTrustedG3TestRow>> = {}
) {
  return makeTrustedG3TestRow(id, {
    grossLineAmount: gross,
    lineTotal: gross,
    purchaseQuantity: overrides.purchaseQuantity ?? 1,
    displayName: PRODUCT,
    merchantRaw: MERCHANT,
    merchantNormalized: MERCHANT,
    receiptId: overrides.receiptId ?? `r-${id}`,
    occurredAt: overrides.occurredAt ?? Number(id.replace(/\D/g, '') || 1) * MS_DAY,
    skuKey: null,
    productFamilyKey: null,
    receiptTaxIsKnown: 1,
    receiptTax: 10,
    receiptTotal: gross,
    ...overrides,
  });
}

function collectJsonKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (value == null || typeof value !== 'object') return keys;
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonKeys(entry, keys);
    return keys;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    collectJsonKeys(child, keys);
  }
  return keys;
}

function stableItemKey(item: {
  itemId: string;
  receiptId: string;
  sourceIndex: number;
}): string {
  return `${item.receiptId}:${item.sourceIndex}:${item.itemId}`;
}

describe('experimentSnapshotSettings', () => {
  it('J — baseline 37→38 and 38→39 via strict assert', () => {
    expect(
      assertExperimentSnapshotExperimentInput({
        phase: 2,
        completedReceiptSequence: 37,
      })
    ).toEqual({
      phase: 2,
      completedReceiptSequence: 37,
      nextReceiptSequence: 38,
    });
    expect(
      assertExperimentSnapshotExperimentInput({
        phase: 2,
        completedReceiptSequence: 38,
      })
    ).toEqual({
      phase: 2,
      completedReceiptSequence: 38,
      nextReceiptSequence: 39,
    });
    expect(deriveNextReceiptSequence(39)).toBe(40);
  });

  it('A2 — rejects fractional / negative / non-finite metadata', () => {
    expect(() =>
      assertExperimentSnapshotExperimentInput({
        phase: 1.5,
        completedReceiptSequence: 37,
      })
    ).toThrow(InvalidExperimentSnapshotExperimentMetaError);
    expect(() =>
      assertExperimentSnapshotExperimentInput({
        phase: 2,
        completedReceiptSequence: 37.2,
      })
    ).toThrow(InvalidExperimentSnapshotExperimentMetaError);
    expect(() =>
      assertExperimentSnapshotExperimentInput({
        phase: 2,
        completedReceiptSequence: -1,
      })
    ).toThrow(InvalidExperimentSnapshotExperimentMetaError);
    expect(() =>
      assertExperimentSnapshotExperimentInput({
        phase: Number.NaN,
        completedReceiptSequence: 37,
      })
    ).toThrow(InvalidExperimentSnapshotExperimentMetaError);
    expect(() =>
      assertExperimentSnapshotExperimentInput({
        phase: 2,
        completedReceiptSequence: Number.POSITIVE_INFINITY,
      })
    ).toThrow(InvalidExperimentSnapshotExperimentMetaError);
  });

  it('storage preference falls back on corrupt values without floor coercion', () => {
    expect(
      readExperimentSnapshotSequencePreferenceFromStorageValues({
        phaseRaw: '1.5',
        completedRaw: '38',
      })
    ).toEqual({
      phase: 2,
      completedReceiptSequence: 38,
      nextReceiptSequence: 39,
    });
    expect(
      readExperimentSnapshotSequencePreferenceFromStorageValues({
        phaseRaw: '2',
        completedRaw: '37.9',
      })
    ).toEqual({
      phase: 2,
      completedReceiptSequence: 37,
      nextReceiptSequence: 38,
    });
  });
});

describe('experimentSnapshotExport', () => {
  beforeEach(() => {
    mockInitIfNeeded.mockClear();
    mockGetInitializedReceiptsDatabaseOrThrow.mockReset();
    mockGetInitializedReceiptsDatabaseOrThrow.mockImplementation(() => {
      throw new ReceiptsDatabaseNotInitializedError();
    });
  });

  const milkItems = [
    {
      name: '明治おいしい牛乳',
      category: 'food_ingredients',
      lineTotal: 198,
      quantity: 1,
    },
  ];

  it('filename uses meruno-experiment-snapshot-YYYYMMDD-HHmmss.json', () => {
    const stamp = new Date(2026, 8, 6, 18, 20, 5).getTime();
    expect(buildExperimentSnapshotFilename(stamp)).toBe(
      'meruno-experiment-snapshot-20260906-182005.json'
    );
  });

  it('experiment meta resolves next = completed + 1 only', () => {
    expect(
      resolveExperimentSnapshotExperimentMeta({
        phase: 2,
        completedReceiptSequence: 37,
      })
    ).toEqual({
      phase: 2,
      completedReceiptSequence: 37,
      nextReceiptSequence: 38,
    });
  });

  it('A — duplicate stored rows: stored > analytics; Repeat occurrence not inflated', () => {
    const a = makeReceipt({
      id: 'dup-a',
      at: nowMs,
      createdAt: nowMs,
      items: milkItems,
    });
    const b = makeReceipt({
      id: 'dup-b',
      at: nowMs,
      createdAt: nowMs + 60_000,
      items: milkItems,
    });
    const selection = selectAnalyticsReceipts([a, b]);
    expect(selection.analyticsPurchaseCandidateCount).toBe(1);

    const productRows = [
      mpRow('1', 198, {
        receiptId: selection.analyticsReceipts[0]!.id,
        occurredAt: nowMs,
        displayName: '明治おいしい牛乳',
        purchaseQuantity: 1,
      }),
    ];

    const snapshot = buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [a, b],
      selection,
      productRows,
      nowMs,
    });

    expect(snapshot.datasetSummary.storedReceiptCount).toBe(2);
    expect(snapshot.datasetSummary.analyticsPurchaseCount).toBe(1);
    expect(snapshot.datasetSummary.excludedDuplicateCount).toBe(1);
    expect(snapshot.datasetSummary.receiptItemUniverse).toBe(
      EXPERIMENT_SNAPSHOT_RECEIPT_ITEM_UNIVERSE
    );
    expect(
      snapshot.receipts.filter((r) => r.analyticsIncluded)
    ).toHaveLength(1);

    for (const profile of snapshot.purchaseMemory.repeatProfiles) {
      expect(profile.purchaseOccurrenceCount).toBeLessThanOrEqual(1);
    }
  });

  it('A1 — displayName is honest; raw/normalized/brand stay null without separate SoT', () => {
    const receipt = makeReceipt({
      id: 'name-1',
      at: nowMs,
      items: milkItems,
    });
    const snapshot = buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [receipt],
      productRows: [
        mpRow('1', 198, {
          receiptId: 'name-1',
          occurredAt: nowMs,
          displayName: '明治おいしい牛乳',
          canonicalProductName: 'Meiji Milk',
        } as Partial<ReturnType<typeof makeTrustedG3TestRow>> & {
          canonicalProductName?: string;
        }),
      ],
      nowMs,
    });
    expect(snapshot.receiptItems[0]!.displayName).toBe('明治おいしい牛乳');
    expect(snapshot.receiptItems[0]!.rawName).toBeNull();
    expect(snapshot.receiptItems[0]!.normalizedName).toBeNull();
    expect(snapshot.receiptItems[0]!.brand).toBeNull();
    expect(snapshot.receiptItems[0]!.canonicalProductName).toBe('Meiji Milk');
  });

  it('B — quantity > 1 still counts as one purchase occurrence', () => {
    const r1 = makeReceipt({
      id: 'qty-1',
      at: nowMs,
      items: [
        {
          name: PRODUCT,
          category: 'food_ingredients',
          lineTotal: 600,
          quantity: 3,
        },
      ],
      total: 600,
    });
    const r2 = makeReceipt({
      id: 'qty-2',
      at: nowMs + MS_DAY,
      items: [
        {
          name: PRODUCT,
          category: 'food_ingredients',
          lineTotal: 200,
          quantity: 1,
        },
      ],
      total: 200,
    });
    const productRows = [
      mpRow('q1', 600, {
        receiptId: 'qty-1',
        occurredAt: nowMs,
        purchaseQuantity: 3,
      }),
      mpRow('q2', 200, {
        receiptId: 'qty-2',
        occurredAt: nowMs + MS_DAY,
        purchaseQuantity: 1,
      }),
    ];
    const snapshot = buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [r1, r2],
      productRows,
      nowMs,
    });
    const identity = snapshot.productIdentities.find(
      (p) => p.kind === 'merchant_product'
    );
    expect(identity).toBeTruthy();
    expect(identity!.purchaseOccurrenceCount).toBe(2);

    const profile = snapshot.purchaseMemory.repeatProfiles.find(
      (p) => p.identityKind === 'merchant_product'
    );
    expect(profile).toBeTruthy();
    expect(profile!.purchaseOccurrenceCount).toBe(2);
    expect(profile!.totalPurchaseQuantity).toBe(4);
  });

  it('C — consecutive exports keep stable join keys', () => {
    const receipt = makeReceipt({
      id: 'stable-1',
      at: nowMs,
      items: [{ name: PRODUCT, category: 'food_ingredients', lineTotal: 100, quantity: 1 }],
    });
    const productRows = [
      mpRow('s1', 100, { receiptId: 'stable-1', occurredAt: nowMs, itemId: 'item-stable' }),
    ];
    const input = {
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [receipt],
      productRows,
      nowMs,
    };
    const first = buildExperimentSnapshot(input);
    const second = buildExperimentSnapshot(input);
    expect(first.receipts.map((r) => r.id)).toEqual(second.receipts.map((r) => r.id));
    expect(first.receiptItems.map((i) => [i.itemId, i.receiptId, i.sourceIndex])).toEqual(
      second.receiptItems.map((i) => [i.itemId, i.receiptId, i.sourceIndex])
    );
    expect(
      first.productIdentities.map((p) => [p.kind, p.identityKey])
    ).toEqual(second.productIdentities.map((p) => [p.kind, p.identityKey]));
  });

  it('C2 — stable join keys survive row reorder + object reconstruction', () => {
    const r1 = makeReceipt({
      id: 'ord-1',
      at: nowMs,
      items: [{ name: PRODUCT, category: 'food_ingredients', lineTotal: 100, quantity: 1 }],
    });
    const r2 = makeReceipt({
      id: 'ord-2',
      at: nowMs + MS_DAY,
      items: [{ name: PRODUCT, category: 'food_ingredients', lineTotal: 120, quantity: 1 }],
    });
    const rowsA = [
      mpRow('1', 100, {
        receiptId: 'ord-1',
        occurredAt: nowMs,
        itemId: 'item-a',
        sourceIndex: 0,
      }),
      mpRow('2', 120, {
        receiptId: 'ord-2',
        occurredAt: nowMs + MS_DAY,
        itemId: 'item-b',
        sourceIndex: 0,
      }),
    ];
    const rowsB = [
      { ...rowsA[1]! },
      { ...rowsA[0]! },
    ];
    const first = buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [r1, r2],
      productRows: rowsA,
      nowMs,
    });
    const second = buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [{ ...r2 }, { ...r1 }],
      productRows: rowsB,
      nowMs,
    });

    const mapItems = (snap: typeof first) =>
      new Map(
        snap.receiptItems.map((item) => [
          stableItemKey(item),
          {
            merchantProductId: item.merchantProductId,
            skuKey: item.skuKey,
            displayName: item.displayName,
          },
        ])
      );
    expect(mapItems(first)).toEqual(mapItems(second));

    const mapIdentities = (snap: typeof first) =>
      new Map(
        snap.productIdentities.map((identity) => [
          `${identity.kind}:${identity.identityKey}`,
          identity.purchaseOccurrenceCount,
        ])
      );
    expect(mapIdentities(first)).toEqual(mapIdentities(second));

    expect(new Set(first.receipts.map((r) => r.id))).toEqual(
      new Set(second.receipts.map((r) => r.id))
    );
  });

  it('D — tax provenance is plain decision only (no bound capability)', () => {
    const receipt = makeReceipt({
      id: 'tax-1',
      at: nowMs,
      items: milkItems,
      tax: 10,
      taxIsKnown: 1,
    });
    const snapshot = buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [receipt],
      productRows: [],
      nowMs,
    });
    expect(snapshot.receipts[0]!.taxProvenance).toEqual({
      trust: 'trusted',
      source: 'persisted_known',
    });
    const json = serializeExperimentSnapshot(snapshot);
    expect(json).not.toMatch(/WeakSet|WeakMap|BoundEffective|capability/i);
    const parsed = assertExperimentSnapshotJsonSafe(snapshot);
    expect(parsed.receipts[0]!.taxProvenance.trust).toBe('trusted');
  });

  it('E/F/G — not_enough_points retained; ready has points; reject reasons kept', () => {
    const r1 = makeReceipt({
      id: 'ph-1',
      at: nowMs,
      items: [{ name: PRODUCT, category: 'food_ingredients', lineTotal: 100, quantity: 1 }],
    });
    const single = buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [r1],
      productRows: [mpRow('1', 100, { receiptId: 'ph-1', occurredAt: nowMs })],
      nowMs,
    });
    const singleHistories = single.priceHistories.filter(
      (h) => h.targetType === 'merchant_product'
    );
    expect(singleHistories.length).toBeGreaterThan(0);
    expect(singleHistories.some((h) => h.status === 'not_enough_points')).toBe(
      true
    );

    const r2 = makeReceipt({
      id: 'ph-2',
      at: nowMs + MS_DAY,
      items: [{ name: PRODUCT, category: 'food_ingredients', lineTotal: 120, quantity: 1 }],
    });
    const readySnap = buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 38 },
      storedReceipts: [r1, r2],
      productRows: [
        mpRow('1', 100, { receiptId: 'ph-1', occurredAt: nowMs }),
        mpRow('2', 120, {
          receiptId: 'ph-2',
          occurredAt: nowMs + MS_DAY,
          sourceIndex: 0,
        }),
      ],
      nowMs: nowMs + MS_DAY,
    });
    const ready = readySnap.priceHistories.find(
      (h) => h.targetType === 'merchant_product' && h.status === 'ready'
    );
    expect(ready).toBeTruthy();
    expect(ready!.detail).toBe('full');
    expect(ready!.points!.length).toBeGreaterThanOrEqual(2);
  });

  it('H — privacy allowlist: forbidden fields absent from JSON', () => {
    const receipt = makeReceipt({
      id: 'priv-1',
      at: nowMs,
      items: milkItems,
      imageUri: 'file:///secret/path.jpg',
    });
    const snapshot = buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [receipt],
      productRows: [
        mpRow('1', 198, {
          receiptId: 'priv-1',
          occurredAt: nowMs,
          receiptAnalysisJson: JSON.stringify({ leak: true }),
          receiptUserItemsJson: '[{"leak":true}]',
        }),
      ],
      nowMs,
    });
    const json = serializeExperimentSnapshot(snapshot);
    for (const forbidden of EXPERIMENT_SNAPSHOT_FORBIDDEN_JSON_SUBSTRINGS) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
    expect(json).not.toContain('file:///secret/path.jpg');
    expect(json).not.toContain('FULL RAW OCR TEXT');
    expect(json).toContain('"displayName"');
    const keys = collectJsonKeys(snapshot);
    expect(keys.has('analysis_json')).toBe(false);
    expect(keys.has('recognition_snapshot_json')).toBe(false);
    expect(keys.has('image_uri')).toBe(false);
    expect(keys.has('displayName')).toBe(true);
  });

  it('I — JSON.stringify + parse round-trip', () => {
    const receipt = makeReceipt({
      id: 'ser-1',
      at: nowMs,
      items: milkItems,
    });
    const snapshot = buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [receipt],
      productRows: [mpRow('1', 198, { receiptId: 'ser-1', occurredAt: nowMs })],
      nowMs,
    });
    const parsed = assertExperimentSnapshotJsonSafe(snapshot);
    expect(parsed.schemaVersion).toBe(EXPERIMENT_SNAPSHOT_SCHEMA_VERSION);
    expect(parsed.experiment).toEqual({
      phase: 2,
      completedReceiptSequence: 37,
      nextReceiptSequence: 38,
    });
    expect(parsed.datasetSummary.receiptItemUniverse).toBe(
      'analytics_engagement_rows'
    );
  });

  it('finite numbers: NaN/Infinity fail export (no silent null)', () => {
    expect(() =>
      assertExperimentSnapshotFiniteNumbers({ total: Number.NaN }, '$.total')
    ).toThrow(/non_finite_number/);
    expect(() =>
      assertExperimentSnapshotFiniteNumbers(
        { total: Number.POSITIVE_INFINITY },
        '$.total'
      )
    ).toThrow(/non_finite_number/);
    expect(() =>
      assertExperimentSnapshotFiniteNumbers(
        { total: Number.NEGATIVE_INFINITY },
        '$.total'
      )
    ).toThrow(/non_finite_number/);
  });

  it('K — datasetSummary invariants', () => {
    const a = makeReceipt({
      id: 'sum-a',
      at: nowMs,
      createdAt: nowMs,
      items: milkItems,
    });
    const b = makeReceipt({
      id: 'sum-b',
      at: nowMs,
      createdAt: nowMs + 1,
      items: milkItems,
    });
    const selection = selectAnalyticsReceipts([a, b]);
    const productRows = [
      mpRow('1', 198, {
        receiptId: selection.analyticsReceipts[0]!.id,
        occurredAt: nowMs,
      }),
    ];
    const snapshot = buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [a, b],
      selection,
      productRows,
      nowMs,
    });
    expect(snapshot.datasetSummary.storedReceiptCount).toBe(
      snapshot.receipts.length
    );
    expect(snapshot.datasetSummary.analyticsPurchaseCount).toBe(
      snapshot.receipts.filter((r) => r.analyticsIncluded).length
    );
    expect(snapshot.datasetSummary.receiptItemCount).toBe(
      snapshot.receiptItems.length
    );
    expect(snapshot.datasetSummary.receiptItemUniverse).toBe(
      EXPERIMENT_SNAPSHOT_RECEIPT_ITEM_UNIVERSE
    );
  });

  it('N/O — price history builder and price-change collector are reused', () => {
    const r1 = makeReceipt({
      id: 'reuse-1',
      at: nowMs,
      items: [{ name: PRODUCT, category: 'food_ingredients', lineTotal: 100, quantity: 1 }],
    });
    const r2 = makeReceipt({
      id: 'reuse-2',
      at: nowMs + MS_DAY,
      items: [{ name: PRODUCT, category: 'food_ingredients', lineTotal: 130, quantity: 1 }],
    });
    const productRows = [
      mpRow('1', 100, { receiptId: 'reuse-1', occurredAt: nowMs }),
      mpRow('2', 130, { receiptId: 'reuse-2', occurredAt: nowMs + MS_DAY }),
    ];
    const buildHistory = jest.fn(
      ((...args: Parameters<typeof buildProductPriceHistory>) =>
        buildProductPriceHistory(...args)) as typeof buildProductPriceHistory
    );
    const collectPriceChangeCandidates = jest.fn((_input: unknown) => []);
    buildExperimentSnapshot({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      storedReceipts: [r1, r2],
      productRows,
      nowMs,
      buildHistory,
      collectPriceChangeCandidates,
    });
    expect(buildHistory).toHaveBeenCalled();
    expect(collectPriceChangeCandidates).toHaveBeenCalled();
  });

  it('L/M — assembler source is read-only / offline (static guard)', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'experimentSnapshotExport.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/\brunAsync\b/);
    expect(source).not.toMatch(/\bexecAsync\b/);
    expect(source).not.toMatch(/\bsaveReceipt\b/);
    expect(source).not.toMatch(/\bupdateReceipt\b/);
    expect(source).not.toMatch(/\bdeleteReceipt\b/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bGoogleGenerativeAI\b/);
    expect(source).not.toMatch(/from '@supabase/);
    expect(source).toContain('getInitializedReceiptsDatabaseOrThrow');
    expect(source).toContain('loadEngagementProductInsightContextWithDb');
    expect(source).toContain('listReceiptsForAnalysisWithDb');
    expect(source).not.toContain('loadProductPriceHistoryWithDb');
    expect(source).not.toMatch(/await initIfNeeded\s*\(/);
    expect(source).not.toContain('getReceiptsDatabase(');
    expect(source).not.toContain('listReceiptsForAnalysis()');
  });

  it('A3 — fails when DB not initialized; initIfNeeded never called', async () => {
    await expect(
      buildExperimentSnapshotFromLocalDb({
        experiment: { phase: 2, completedReceiptSequence: 37 },
      })
    ).rejects.toThrow(/already initialized local database/i);

    expect(mockGetInitializedReceiptsDatabaseOrThrow).toHaveBeenCalled();
    expect(mockInitIfNeeded).not.toHaveBeenCalled();
  });

  it('A3 — observational path uses injected initialized DB; no initIfNeeded', async () => {
    const runAsync = jest.fn();
    const execAsync = jest.fn();
    const fakeDb = {
      getAllAsync: jest.fn(async () => []),
      runAsync,
      execAsync,
    } as unknown as import('expo-sqlite').SQLiteDatabase;

    const requireInitializedDb = jest.fn(() => fakeDb);
    const listReceiptsWithDb = jest.fn(async () => [] as ReceiptRow[]);
    const loadProductRowsWithDb = jest.fn(async () => []);
    const loadPersonalInventoryWithDb = jest.fn(async () => null);

    const snapshot = await buildExperimentSnapshotFromLocalDb({
      experiment: { phase: 2, completedReceiptSequence: 37 },
      nowMs,
      requireInitializedDb,
      listReceiptsWithDb,
      loadProductRowsWithDb,
      loadPersonalInventoryWithDb,
    });

    expect(requireInitializedDb).toHaveBeenCalledTimes(1);
    expect(listReceiptsWithDb).toHaveBeenCalledWith(fakeDb);
    expect(loadProductRowsWithDb).toHaveBeenCalledWith(fakeDb);
    expect(loadPersonalInventoryWithDb).toHaveBeenCalledWith(fakeDb);
    expect(mockInitIfNeeded).not.toHaveBeenCalled();
    expect(mockGetInitializedReceiptsDatabaseOrThrow).not.toHaveBeenCalled();
    expect(runAsync).not.toHaveBeenCalled();
    expect(execAsync).not.toHaveBeenCalled();
    expect(snapshot.experiment.nextReceiptSequence).toBe(38);
  });

  it('A3 — engagement WithDb helper is used by production wrapper path shape', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'engagementMilestones.ts'),
      'utf8'
    );
    expect(source).toContain('loadEngagementProductInsightContextWithDb');
    expect(source).toMatch(
      /export async function loadEngagementProductInsightContext[\s\S]*getEngagementMilestoneDb[\s\S]*loadEngagementProductInsightContextWithDb/
    );
  });

  it('settings exposes Experiment Snapshot entry (not auto-increment)', () => {
    const settingsSource = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/settings/index.tsx'),
      'utf8'
    );
    expect(settingsSource).toContain('Export Experiment Snapshot');
    expect(settingsSource).toContain('exportAndShareExperimentSnapshot');
    expect(settingsSource).toContain('Experiment completed sequence');
    expect(settingsSource).toContain('does not auto-increment');
    expect(settingsSource).toContain('getExperimentSnapshotSequencePreference');
    expect(settingsSource).toContain('shouldShowExperimentSnapshotEntry');
    expect(settingsSource).not.toMatch(
      /nextReceiptSequence:\s*experimentSequence\.nextReceiptSequence/
    );
  });

  it('shouldExportFullPriceHistoryDetail keeps reject-bearing / multi-point histories', () => {
    const summaryLike = {
      status: 'not_enough_points',
      totalOccurrenceCount: 1,
      comparableOccurrenceCount: 0,
      observations: [{ level2RejectReasons: [] }],
    } as unknown as ProductPriceHistoryResult;
    expect(shouldExportFullPriceHistoryDetail(summaryLike)).toBe(false);

    const rejectLike = {
      status: 'not_enough_points',
      totalOccurrenceCount: 1,
      comparableOccurrenceCount: 0,
      observations: [
        { level2RejectReasons: ['insufficient_comparable_points'] },
      ],
    } as unknown as ProductPriceHistoryResult;
    expect(shouldExportFullPriceHistoryDetail(rejectLike)).toBe(true);
  });
});

describe('db observational accessor', () => {
  it('source exposes fail-closed initialized accessor without initIfNeeded', () => {
    const source = fs.readFileSync(path.join(__dirname, 'db.ts'), 'utf8');
    expect(source).toContain('getInitializedReceiptsDatabaseOrThrow');
    expect(source).toContain('ReceiptsDatabaseNotInitializedError');
    expect(source).toContain('listReceiptsForAnalysisWithDb');
    expect(source).toMatch(
      /function getInitializedReceiptsDatabaseOrThrow[\s\S]*isReceiptsDatabaseInitialized/
    );
    const accessorBlock = source.slice(
      source.indexOf('export function getInitializedReceiptsDatabaseOrThrow')
    );
    const accessorEnd = accessorBlock.indexOf('export function __resetReceiptsDatabaseLifecycleForTests');
    const body = accessorBlock.slice(0, accessorEnd);
    expect(body).not.toContain('initIfNeeded');
    expect(body).not.toContain('openDatabaseAsync');
  });
});
