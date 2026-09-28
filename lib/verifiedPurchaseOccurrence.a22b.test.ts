/**
 * A2.2b — production provenance readers and occurrence-local verified overlay.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('nanoid/non-secure', () => ({ nanoid: jest.fn(() => 'generated-id') }));
jest.mock('./productAlias', () => ({
  seedBuiltinProductAliases: jest.fn(async () => undefined),
}));
jest.mock('./cloudBackupWorker', () => ({
  requestCloudBackupFlush: jest.fn(async () => ({ status: 'skipped' })),
}));
jest.mock('./syncOutbox', () => ({
  ensureSyncOutboxSchema: jest.fn(async () => undefined),
  generateSyncIntentId: jest.fn(() => 'intent'),
  replaceSyncOutboxIntent: jest.fn(async () => undefined),
}));
jest.mock('./receiptItemIndex', () => ({
  clearReceiptItemIndex: jest.fn(async () => undefined),
  deleteReceiptItemIndex: jest.fn(async () => undefined),
  ensureReceiptItemsSchema: jest.fn(async () => undefined),
  projectMinimalReceiptItemIndexFromSoT: jest.fn(() => []),
  rebuildReceiptItemIndex: jest.fn(async () => undefined),
}));
jest.mock('./receiptItemIndexBackfill', () => ({
  runReceiptItemIndexBackfillBatch: jest.fn(async () => ({
    succeeded: 0,
    failed: 0,
    remaining: 0,
  })),
}));
jest.mock('./shoppingIntentSchema', () => ({
  ensureShoppingIntentsSchema: jest.fn(async () => undefined),
}));
jest.mock('./productIdentityEntitySchema', () => ({
  ensureProductIdentityEntitySchema: jest.fn(async () => undefined),
}));
jest.mock('./personalProductIdentitySchema', () => ({
  ensurePersonalProductIdentitySchema: jest.fn(async () => undefined),
}));
jest.mock('./logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('./receiptOwnershipContext', () => ({
  TRANSACTION_SOURCE_RECEIPT_OCR: 'receipt_ocr',
  resolveOwnershipStamp: jest.fn(async () => ({
    userId: 'user-a22b',
    installationId: 'install-a22b',
    transactionSource: 'receipt_ocr',
  })),
}));
jest.mock('./receiptOwnershipScope', () => ({
  composeReceiptListWhereClause: jest.fn(),
  resolveCurrentLocalReceiptOwnerScope: jest.fn(async () => ({
    status: 'ready',
    ownerKey: 'owner-a22b',
    receiptWhereSql: 'receipts.user_id = ?',
    params: ['user-a22b'],
    itemWhereSql: '1=1',
  })),
}));

import type { ReceiptRow } from './db';
import {
  __resetReceiptsDatabaseLifecycleForTests,
  __setReceiptsDatabaseInitializedForTests,
  listAllReceiptsForCurrentOwnerPurchaseTruth,
  listReceiptsForAnalysisWithDb,
} from './db';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { buildCanonicalPurchaseOccurrenceIndex } from './canonicalPurchaseOccurrence';
import {
  buildEngagementProductInsightSelectSql,
  loadEngagementOwnerReceiptsWithDb,
} from './engagementMilestones';
import { buildHomeProgressiveExperience } from './homeProgressiveExperience';
import {
  buildHistoryPurchaseTruthView,
  projectHistorySearchToPurchaseTruth,
  resolveHistoryPurchaseDeleteIds,
  resolveHistoryPurchaseDetailReceiptId,
  resolveHistoryPurchaseEditMemberIds,
} from './historyPurchaseTruth';
import { deriveExactLogicalPurchaseMemberSet } from './logicalPurchaseEditPartition';
import {
  countDistinctPurchaseEventOccurrences,
  resolvePurchaseOccurrenceIndexForRows,
  type ProductPriceHistoryRow,
} from './productPriceHistory';
import {
  buildPurchaseEventDatesFromRows,
  buildRepeatIntervalStats,
} from './repeatProductProfile';
import { classifyVerifiedPurchaseOccurrenceBundle } from './verifiedPurchaseOccurrenceProvenance';

const TX = Date.parse('2024-05-02T09:00:00+09:00');
const VERIFIED_AT = 1_710_000_000_000;
const PROVENANCE_COLUMNS = [
  'verified_purchase_occurrence_id',
  'verified_purchase_occurrence_source',
  'verified_purchase_occurrence_verified_at',
] as const;

function sqlProjectsProvenance(sql: string): boolean {
  return PROVENANCE_COLUMNS.every((column) => sql.includes(column));
}

function projectStoredRow(sql: string, row: ReceiptRow): ReceiptRow {
  if (sqlProjectsProvenance(sql)) return { ...row };
  const copy: ReceiptRow = { ...row };
  delete copy.verified_purchase_occurrence_id;
  delete copy.verified_purchase_occurrence_source;
  delete copy.verified_purchase_occurrence_verified_at;
  return copy;
}

function makeReceipt(
  id: string,
  opts: {
    precision?: 'second' | 'minute';
    transactionAt?: number;
    createdAt?: number;
    total?: number;
    merchant?: string;
    verifiedId?: string | null;
    verifiedSource?: string | null;
    verifiedAt?: number | null;
    partialIdOnly?: boolean;
  } = {}
): ReceiptRow {
  const precision = opts.precision ?? 'minute';
  const total = opts.total ?? 1200;
  const merchant = opts.merchant ?? 'MARKET';
  const txAt = opts.transactionAt ?? TX;
  const analysis = {
    merchant,
    total,
    tax: 80,
    tax_is_known: true,
    currency: 'JPY',
    is_grocery: true,
    merchant_type: 'supermarket',
    items: [{ name: 'MILK', quantity: 1, lineTotal: total }],
    transaction_time_precision: precision,
    transactionDate:
      precision === 'second' ? '2024-05-02 09:00:00' : '2024-05-02 09:00',
  };
  const assigned = opts.verifiedId != null && !opts.partialIdOnly;
  return {
    id,
    created_at: opts.createdAt ?? 2_000,
    transaction_at: txAt,
    transaction_time_precision: precision,
    image_uri: '',
    merchant_raw: merchant,
    merchant_normalized: merchant,
    merchant_type: 'supermarket',
    total,
    tax: 80,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify(analysis),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    verified_purchase_occurrence_id: opts.partialIdOnly
      ? (opts.verifiedId ?? 'partial-only')
      : (opts.verifiedId ?? null),
    verified_purchase_occurrence_source: assigned
      ? (opts.verifiedSource ?? 'research_verified')
      : null,
    verified_purchase_occurrence_verified_at: assigned
      ? (opts.verifiedAt ?? VERIFIED_AT)
      : null,
  };
}

function ownerScope() {
  return {
    status: 'ready' as const,
    ownerKey: 'owner-a22b',
    receiptWhereSql: 'receipts.user_id = ?',
    params: ['user-a22b'],
    itemWhereSql: '1=1',
  };
}

describe('A2.2b production provenance readers', () => {
  afterEach(() => {
    __resetReceiptsDatabaseLifecycleForTests();
  });

  async function readAnalytics(row: ReceiptRow): Promise<ReceiptRow> {
    const db = {
      getAllAsync: jest.fn(async (sql: string) => [projectStoredRow(sql, row)]),
    };
    const rows = await listReceiptsForAnalysisWithDb(
      db as unknown as import('expo-sqlite').SQLiteDatabase
    );
    expect(sqlProjectsProvenance(String(db.getAllAsync.mock.calls[0]?.[0]))).toBe(
      true
    );
    return rows[0]!;
  }

  async function readExhaustive(row: ReceiptRow): Promise<ReceiptRow> {
    const db = {
      getAllAsync: jest.fn(async (sql: string) => [projectStoredRow(sql, row)]),
    };
    __setReceiptsDatabaseInitializedForTests(
      db as unknown as import('expo-sqlite').SQLiteDatabase
    );
    const rows = await listAllReceiptsForCurrentOwnerPurchaseTruth();
    expect(sqlProjectsProvenance(String(db.getAllAsync.mock.calls[0]?.[0]))).toBe(
      true
    );
    return rows[0]!;
  }

  async function readEngagement(row: ReceiptRow): Promise<ReceiptRow> {
    const db = {
      getAllAsync: jest.fn(async (sql: string) => [projectStoredRow(sql, row)]),
    };
    const rows = await loadEngagementOwnerReceiptsWithDb(
      db as unknown as Parameters<typeof loadEngagementOwnerReceiptsWithDb>[0],
      ownerScope()
    );
    expect(sqlProjectsProvenance(String(db.getAllAsync.mock.calls[0]?.[0]))).toBe(
      true
    );
    return rows[0] as ReceiptRow;
  }

  it('analytics, engagement, and exhaustive readers keep an assigned triple', async () => {
    const stored = makeReceipt('persisted', {
      precision: 'second',
      verifiedId: 'G1',
      verifiedSource: 'research_verified',
      verifiedAt: VERIFIED_AT,
    });
    for (const read of [readAnalytics, readExhaustive, readEngagement]) {
      const loaded = await read(stored);
      expect(loaded.verified_purchase_occurrence_id).toBe('G1');
      expect(loaded.verified_purchase_occurrence_source).toBe('research_verified');
      expect(loaded.verified_purchase_occurrence_verified_at).toBe(VERIFIED_AT);
    }
  });

  it('all-null provenance stays all-null from each reader', async () => {
    const stored = makeReceipt('plain', { precision: 'second' });
    for (const read of [readAnalytics, readExhaustive, readEngagement]) {
      const loaded = await read(stored);
      expect(loaded.verified_purchase_occurrence_id).toBeNull();
      expect(loaded.verified_purchase_occurrence_source).toBeNull();
      expect(loaded.verified_purchase_occurrence_verified_at).toBeNull();
    }
  });
});

describe('A2.2b analytics verified boundary from production reader rows', () => {
  function boundaryFixture(): ReceiptRow[] {
    return [
      makeReceipt('U', { precision: 'second' }),
      makeReceipt('G1a', { precision: 'second', verifiedId: 'vpo_g1', createdAt: 1 }),
      makeReceipt('G1b', { precision: 'second', verifiedId: 'vpo_g1', createdAt: 2 }),
      makeReceipt('G2a', { precision: 'second', verifiedId: 'vpo_g2', createdAt: 3 }),
      makeReceipt('G2b', { precision: 'second', verifiedId: 'vpo_g2', createdAt: 4 }),
    ];
  }

  async function loadOrder(rows: ReceiptRow[]): Promise<ReceiptRow[]> {
    const db = {
      getAllAsync: jest.fn(async (sql: string) =>
        rows.map((row) => projectStoredRow(sql, row))
      ),
    };
    return listReceiptsForAnalysisWithDb(
      db as unknown as import('expo-sqlite').SQLiteDatabase
    );
  }

  function hcSignature(rows: ReceiptRow[]): string[] {
    return selectAnalyticsReceipts(rows).highConfidenceDuplicateGroups
      .map((group) => [...group.receiptIds].sort().join(','))
      .sort();
  }

  it('keeps G1 and G2 apart across input orders without changing Analysis D groups', async () => {
    const base = boundaryFixture();
    const orders = [base, [...base].reverse(), [base[2]!, base[4]!, base[0]!, base[1]!, base[3]!]];
    const signatures: string[] = [];
    for (const order of orders) {
      const loaded = await loadOrder(order);
      const stripped = loaded.map((row) => ({
        ...row,
        verified_purchase_occurrence_id: null,
        verified_purchase_occurrence_source: null,
        verified_purchase_occurrence_verified_at: null,
      }));
      expect(hcSignature(loaded)).toEqual(hcSignature(stripped));
      const full = buildCanonicalPurchaseOccurrenceIndex(loaded);
      const g1 = full.groups.find(
        (group) =>
          group.receiptIds.includes('G1a') && group.receiptIds.includes('G1b')
      );
      const g2 = full.groups.find(
        (group) =>
          group.receiptIds.includes('G2a') && group.receiptIds.includes('G2b')
      );
      expect(g1).toBeDefined();
      expect(g2).toBeDefined();
      expect(g1!.receiptIds.some((id) => id === 'G2a' || id === 'G2b')).toBe(false);
      expect(g2!.receiptIds.some((id) => id === 'G1a' || id === 'G1b')).toBe(false);
      const selection = selectAnalyticsReceipts(loaded);
      const afterSelection = buildCanonicalPurchaseOccurrenceIndex(
        selection.analyticsReceipts
      );
      expect(
        afterSelection.groups.some((group) => group.occurrenceId === 'vpo_g1')
      ).toBe(true);
      expect(
        afterSelection.groups.some((group) => group.occurrenceId === 'vpo_g2')
      ).toBe(true);
      expect(
        afterSelection.groups.some(
          (group) =>
            group.receiptIds.some((id) => id === 'G1a' || id === 'G1b') &&
            group.receiptIds.some((id) => id === 'G2a' || id === 'G2b')
        )
      ).toBe(false);
      signatures.push(
        JSON.stringify(
          full.groups
            .map((group) => [...group.receiptIds].sort().join(','))
            .sort()
        )
      );
    }
    expect(new Set(signatures).size).toBe(1);
  });
});

describe('A2.2b occurrence-local overlay', () => {
  function legacyPair(): ReceiptRow[] {
    return [
      makeReceipt('L1', { precision: 'second', createdAt: 1, total: 400, merchant: 'LEGACY' }),
      makeReceipt('L2', { precision: 'second', createdAt: 2, total: 400, merchant: 'LEGACY' }),
    ];
  }

  function verifiedPair(): ReceiptRow[] {
    return [
      makeReceipt('V1', {
        precision: 'second',
        verifiedId: 'vpo_v',
        transactionAt: TX + 86_400_000,
        createdAt: 11,
        total: 900,
        merchant: 'VERIFIED SHOP',
      }),
      makeReceipt('V2', {
        precision: 'second',
        verifiedId: 'vpo_v',
        transactionAt: TX + 86_400_000,
        createdAt: 12,
        total: 900,
        merchant: 'VERIFIED SHOP',
      }),
    ];
  }

  it('assigning V does not change unrelated legacy L edit, delete, or history', () => {
    const legacy = legacyPair();
    const beforeEdit = deriveExactLogicalPurchaseMemberSet('L1', legacy);
    const beforeDelete = resolveHistoryPurchaseDeleteIds(['L1'], legacy);
    const beforeHistory = buildHistoryPurchaseTruthView(legacy).visibleRows.map(
      (row) => row.id
    );
    expect(beforeEdit).toEqual(['L1', 'L2']);

    const withVerified = [...legacy, ...verifiedPair()];
    expect(deriveExactLogicalPurchaseMemberSet('L1', withVerified)).toEqual(beforeEdit);
    expect(deriveExactLogicalPurchaseMemberSet('L2', withVerified)).toEqual(beforeEdit);
    expect(resolveHistoryPurchaseDeleteIds(['L1'], withVerified)).toEqual(beforeDelete);
    expect(resolveHistoryPurchaseEditMemberIds('L1', withVerified)).toEqual(
      resolveHistoryPurchaseEditMemberIds('L1', legacy)
    );
    const history = buildHistoryPurchaseTruthView(withVerified);
    expect(history.visibleRows.map((row) => row.id).filter((id) => id === 'L1' || id === 'L2')).toEqual(
      beforeHistory
    );
    expect(deriveExactLogicalPurchaseMemberSet('V1', withVerified)).toEqual(['V1', 'V2']);
    expect(
      history.effective.purchaseByReceiptId.get('L1')?.verifiedActive
    ).toBe(false);
    expect(history.effective.purchaseByReceiptId.get('V1')?.verifiedActive).toBe(
      true
    );
    expect(history.effective.purchaseByReceiptId.get('V1')?.occurrenceKey).toBe(
      'verified:vpo_v'
    );

    const malformed = makeReceipt('M', {
      precision: 'minute',
      partialIdOnly: true,
      verifiedId: 'something',
      transactionAt: TX + 3 * 86_400_000,
      createdAt: 30,
      total: 50,
      merchant: 'OTHER',
    });
    expect(
      classifyVerifiedPurchaseOccurrenceBundle({
        occurrenceId: malformed.verified_purchase_occurrence_id,
        source: malformed.verified_purchase_occurrence_source,
        verifiedAt: malformed.verified_purchase_occurrence_verified_at,
      }).state
    ).toBe('invalid');
    const withMalformed = [...withVerified, malformed];
    expect(deriveExactLogicalPurchaseMemberSet('L1', withMalformed)).toEqual(beforeEdit);
    expect(resolveHistoryPurchaseDeleteIds(['L1'], withMalformed)).toEqual(beforeDelete);
    expect(
      buildHistoryPurchaseTruthView(withMalformed).effective.purchaseByReceiptId.get('L1')
        ?.verifiedActive
    ).toBe(false);
    expect(
      buildHistoryPurchaseTruthView(withMalformed).effective.purchaseByReceiptId.get('M')
        ?.verifiedActive
    ).toBe(false);
  });

  it('verified-active G+U uses canonical membership for every anchor', () => {
    const g = makeReceipt('G', {
      precision: 'second',
      verifiedId: 'vpo_gu',
      createdAt: 1,
    });
    const u = makeReceipt('U', { precision: 'second', createdAt: 2 });
    const rows = [g, u];
    for (const anchor of ['G', 'U']) {
      expect(deriveExactLogicalPurchaseMemberSet(anchor, rows)).toEqual(['G', 'U']);
      expect(resolveHistoryPurchaseEditMemberIds(anchor, rows)).toEqual(['G', 'U']);
    }
    const truth = buildHistoryPurchaseTruthView(rows);
    expect(truth.visibleRows).toHaveLength(1);
    expect(truth.effective.purchaseByReceiptId.get('U')?.verifiedActive).toBe(true);
    expect(truth.effective.purchaseByReceiptId.get('U')?.occurrenceKey).toBe(
      'verified:vpo_gu'
    );
  });

  it('History shows one row for seven G rescans and two rows for G1/G2', () => {
    const seven = Array.from({ length: 7 }, (_, index) =>
      makeReceipt(`g${index}`, {
        precision: 'minute',
        verifiedId: 'vpo_hist',
        createdAt: index + 1,
      })
    );
    const view = buildHistoryPurchaseTruthView(seven);
    expect(view.visibleRows).toHaveLength(1);
    const detail = resolveHistoryPurchaseDetailReceiptId('g3', seven);
    expect(detail).toBe(view.visibleRows[0]!.id);
    expect(resolveHistoryPurchaseEditMemberIds('g3', seven)).toHaveLength(7);
    const search = projectHistorySearchToPurchaseTruth(
      {
        itemResults: seven.map((row) => ({
          receiptId: row.id,
          displayName: 'MILK',
          sourceIndex: 0,
        })),
        receiptResults: seven,
      },
      view.selection,
      { effective: view.effective, universeReceipts: view.universeReceipts }
    );
    expect(search.receiptResults).toHaveLength(1);
    expect(search.itemResults).toHaveLength(1);

    const separated = [
      makeReceipt('a', { precision: 'second', verifiedId: 'vpo_a', createdAt: 1 }),
      makeReceipt('b', { precision: 'second', verifiedId: 'vpo_b', createdAt: 2 }),
    ];
    expect(buildHistoryPurchaseTruthView(separated).visibleRows).toHaveLength(2);
  });
});

describe('A2.2b History exhaustive universe', () => {
  it('one verified occurrence straddling the old 2000-row cutoff stays one purchase', () => {
    const baseAt = Date.parse('2027-06-01T00:00:00+09:00');
    const fillers = Array.from({ length: 1999 }, (_, index) =>
      makeReceipt(`filler-${index}`, {
        precision: 'second',
        transactionAt: baseAt + index * 60_000,
        createdAt: baseAt + index * 60_000,
        total: 100 + (index % 17),
        merchant: `Filler ${index}`,
      })
    );
    const older = makeReceipt('boundary-old', {
      precision: 'minute',
      verifiedId: 'vpo_boundary',
      transactionAt: Date.parse('2020-01-01T09:00:00+09:00'),
      createdAt: 1,
      total: 1200,
      merchant: 'BOUNDARY',
    });
    const newer = makeReceipt('boundary-new', {
      precision: 'minute',
      verifiedId: 'vpo_boundary',
      transactionAt: baseAt + 1999 * 60_000,
      createdAt: 2,
      total: 1200,
      merchant: 'BOUNDARY',
    });
    const exhaustive = [...fillers, newer, older];
    const newestTwoThousand = exhaustive
      .slice()
      .sort(
        (left, right) =>
          (right.transaction_at ?? right.created_at) -
          (left.transaction_at ?? left.created_at)
      )
      .slice(0, 2000);
    expect(newestTwoThousand.some((row) => row.id === 'boundary-old')).toBe(false);
    expect(newestTwoThousand.some((row) => row.id === 'boundary-new')).toBe(true);

    const view = buildHistoryPurchaseTruthView(exhaustive);
    const visible = view.visibleRows.filter(
      (row) => row.id === 'boundary-old' || row.id === 'boundary-new'
    );
    expect(visible).toHaveLength(1);
    const pairOnly = buildHistoryPurchaseTruthView([older, newer]);
    const reversed = buildHistoryPurchaseTruthView([newer, older]);
    expect(visible[0]!.id).toBe(pairOnly.visibleRows[0]!.id);
    expect(reversed.visibleRows[0]!.id).toBe(pairOnly.visibleRows[0]!.id);
    expect(
      resolveHistoryPurchaseEditMemberIds(visible[0]!.id, exhaustive).sort()
    ).toEqual(['boundary-new', 'boundary-old']);
    expect(
      resolveHistoryPurchaseDeleteIds([visible[0]!.id], exhaustive).sort()
    ).toEqual(['boundary-new', 'boundary-old']);
  }, 120_000);
});

describe('A2.2b Home local overlay', () => {
  it('collapses verified rescans without changing unrelated legacy recent purchases', () => {
    const rescans = Array.from({ length: 7 }, (_, index) =>
      makeReceipt(`g${index}`, {
        precision: 'minute',
        verifiedId: 'vpo_home',
        createdAt: index + 1,
        total: 100,
      })
    );
    const h = makeReceipt('h', {
      precision: 'minute',
      transactionAt: TX + 86_400_000,
      total: 200,
      createdAt: 20,
      merchant: 'H SHOP',
    });
    const i = makeReceipt('i', {
      precision: 'minute',
      transactionAt: TX + 2 * 86_400_000,
      total: 300,
      createdAt: 30,
      merchant: 'I SHOP',
    });
    const experience = buildHomeProgressiveExperience([...rescans, h, i], null);
    expect(experience.recentInsight?.receiptIds).toHaveLength(3);
    expect(experience.recentInsight?.totalSpend).toBe(600);

    const legacy = [
      makeReceipt('h2', {
        precision: 'minute',
        transactionAt: TX + 3 * 86_400_000,
        total: 210,
        createdAt: 40,
        merchant: 'H2',
      }),
      makeReceipt('i2', {
        precision: 'minute',
        transactionAt: TX + 4 * 86_400_000,
        total: 220,
        createdAt: 41,
        merchant: 'I2',
      }),
      makeReceipt('j2', {
        precision: 'minute',
        transactionAt: TX + 5 * 86_400_000,
        total: 230,
        createdAt: 42,
        merchant: 'J2',
      }),
    ];
    const before = buildHomeProgressiveExperience(legacy, null);
    const malformed = makeReceipt('m', {
      precision: 'minute',
      partialIdOnly: true,
      verifiedId: 'something',
      transactionAt: TX,
      createdAt: 3,
      total: 10,
      merchant: 'MALFORMED',
    });
    const afterMalformed = buildHomeProgressiveExperience(
      [...legacy, malformed],
      null
    );
    expect(afterMalformed.recentInsight?.receiptIds).toEqual(
      before.recentInsight?.receiptIds
    );
    expect(afterMalformed.recentInsight?.totalSpend).toBe(
      before.recentInsight?.totalSpend
    );
    const oldVerified = rescans.map((row) => ({
      ...row,
      transaction_at: TX - 86_400_000,
    }));
    const afterVerified = buildHomeProgressiveExperience(
      [...legacy, ...oldVerified],
      null
    );
    expect(afterVerified.recentInsight?.receiptIds).toEqual(
      before.recentInsight?.receiptIds
    );
  });
});

describe('A2.2b Repeat and PPH provenance', () => {
  function productRow(
    receiptId: string,
    verifiedId: string | null
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
      lineTotal: 1200,
      purchaseQuantity: 1,
      productFamilyKey: null,
      volumeBaseMl: null,
      weightBaseG: null,
      countBase: null,
      receiptAnalysisJson: makeReceipt(receiptId).analysis_json,
      receiptTotal: 1200,
      receiptTax: 80,
      receiptTaxIsKnown: 1,
      receiptCurrency: 'JPY',
      receiptUserEdited: 0,
      verifiedPurchaseOccurrenceId: verifiedId,
      verifiedPurchaseOccurrenceSource: verifiedId ? 'research_verified' : null,
      verifiedPurchaseOccurrenceVerifiedAt: verifiedId ? VERIFIED_AT : null,
    };
  }

  it('engagement reader output collapses seven G rescans to one repeat event', async () => {
    const seven = Array.from({ length: 7 }, (_, index) =>
      makeReceipt(`r${index}`, {
        precision: 'minute',
        verifiedId: 'vpo_repeat',
        createdAt: index + 1,
      })
    );
    const db = {
      getAllAsync: jest.fn(async (sql: string) =>
        seven.map((row) => projectStoredRow(sql, row))
      ),
    };
    const loaded = await loadEngagementOwnerReceiptsWithDb(
      db as unknown as Parameters<typeof loadEngagementOwnerReceiptsWithDb>[0],
      ownerScope()
    );
    const index = buildCanonicalPurchaseOccurrenceIndex(loaded as ReceiptRow[]);
    const dates = buildPurchaseEventDatesFromRows(
      loaded.map((row) => ({
        receiptId: row.id,
        occurredAt: row.transaction_at ?? row.created_at,
      })),
      { purchaseOccurrenceIdByReceiptId: index.occurrenceIdByReceiptId }
    );
    expect(index.groups).toHaveLength(1);
    expect(dates.purchaseOccurrenceCount).toBe(1);
    expect(dates.purchaseEventDates).toHaveLength(1);
    expect(
      buildRepeatIntervalStats({
        purchaseEventDates: dates.purchaseEventDates,
        datedPurchaseOccurrenceCount: dates.datedPurchaseOccurrenceCount,
      }).intervalSampleSize
    ).toBe(0);

    const split = [
      makeReceipt('a', {
        precision: 'second',
        verifiedId: 'vpo_a',
        transactionAt: TX,
        createdAt: 1,
      }),
      makeReceipt('b', {
        precision: 'second',
        verifiedId: 'vpo_b',
        transactionAt: TX + 86_400_000,
        createdAt: 2,
      }),
    ];
    const splitIndex = buildCanonicalPurchaseOccurrenceIndex(split);
    expect(
      buildPurchaseEventDatesFromRows(
        split.map((row) => ({
          receiptId: row.id,
          occurredAt: row.transaction_at ?? row.created_at,
        })),
        { purchaseOccurrenceIdByReceiptId: splitIndex.occurrenceIdByReceiptId }
      ).purchaseOccurrenceCount
    ).toBe(2);

    const plain = seven.map((row) =>
      makeReceipt(row.id, { precision: 'minute', createdAt: row.created_at })
    );
    expect(buildCanonicalPurchaseOccurrenceIndex(plain).groups).toHaveLength(7);
  });

  it('product insight rows keep provenance and cap seven G rescans at one observation', () => {
    const sql = buildEngagementProductInsightSelectSql({ itemWhereSql: '1=1' });
    expect(sqlProjectsProvenance(sql)).toBe(true);
    const seven = Array.from({ length: 7 }, (_, index) =>
      productRow(`p${index}`, 'vpo_pph')
    );
    const index = resolvePurchaseOccurrenceIndexForRows(seven);
    expect(index.groups).toHaveLength(1);
    expect(
      countDistinctPurchaseEventOccurrences(seven, {
        purchaseOccurrenceIdByReceiptId: index.occurrenceIdByReceiptId,
      })
    ).toBe(1);
    const split = [productRow('p-a', 'vpo_pa'), productRow('p-b', 'vpo_pb')];
    const splitIndex = resolvePurchaseOccurrenceIndexForRows(split);
    expect(splitIndex.groups).toHaveLength(2);
    expect(
      countDistinctPurchaseEventOccurrences(split, {
        purchaseOccurrenceIdByReceiptId: splitIndex.occurrenceIdByReceiptId,
      })
    ).toBe(2);
    const plain = Array.from({ length: 7 }, (_, index) => productRow(`n${index}`, null));
    expect(resolvePurchaseOccurrenceIndexForRows(plain).groups).toHaveLength(7);
  });
});
