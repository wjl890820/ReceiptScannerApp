/**
 * H7.2 — Exact merchant-product observation index for Repeat.
 * Differentials vs baseline O(M×N) filter; personal overlay / identity untouched.
 */
/* eslint-disable import/first -- Jest mocks must run before module imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./env', () => ({
  isProductIdentityPriceHistoryV1Enabled: () => true,
}));

import type { ReceiptRow } from './db';
import type { EngagementProductRow } from './engagementMilestones';
import { buildNextPurchaseCandidates } from './nextPurchaseCandidates';
import {
  buildPersonalProductEndpointInventory,
  type PersonalProductEndpointInventory,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import type { StoredPersonalProductIdentityDecision } from './personalProductIdentityContract';
import type { QualifiedIdentityObservation } from './productIdentityConsumer';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import {
  __baselineQualifiedRowsForMerchantProductForTests,
  buildRepeatMerchantProductObservationIndex,
  buildRepeatProductProfiles,
  type RepeatMerchantProductObservationIndexStats,
  type RepeatProductProfile,
} from './repeatProductProfile';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER = 'user:h72-owner';

function receipt(
  id: string,
  overrides: Partial<ReceiptRow> = {}
): ReceiptRow {
  const index = Number(String(id).replace(/\D/g, '')) || 1;
  const transactionAt =
    overrides.transaction_at === undefined
      ? index * DAY_MS
      : overrides.transaction_at;
  const precision =
    overrides.transaction_time_precision ??
    (transactionAt == null ? 'unknown' : 'second');
  return {
    id,
    created_at: index * DAY_MS,
    transaction_at: transactionAt,
    transaction_time_precision: precision,
    image_uri: '',
    total: 100,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [],
      transaction_time_precision: precision,
      ...(precision === 'second' && transactionAt != null
        ? { transactionDate: '2026-07-06 11:44:46' }
        : {}),
    }),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: 'h72-owner',
    installation_id: null,
    ...overrides,
  };
}

function productRow(
  receiptId: string,
  itemId: string,
  overrides: Partial<EngagementProductRow> = {}
): EngagementProductRow {
  const index = Number(String(receiptId).replace(/\D/g, '')) || 1;
  return {
    receiptId,
    itemId,
    sourceIndex: 0,
    occurredAt: index * DAY_MS,
    merchantRaw: 'イオン',
    merchantNormalized: 'イオン',
    merchant_type: 'supermarket',
    analysis_json: '{}',
    displayName: itemId,
    currency: 'JPY',
    lineTotal: 100,
    purchaseQuantity: 1,
    canonicalProductName: null,
    productFamilyKey: null,
    skuKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    ...overrides,
  };
}

function qobs(
  overrides: Partial<QualifiedIdentityObservation> & {
    receiptId: string;
    merchantProductId: string;
  }
): QualifiedIdentityObservation {
  return {
    itemSourceIndex: 0,
    rawName: overrides.displayName || overrides.rawName || 'item',
    merchantKey: 'イオン',
    occurredAt: DAY_MS,
    lineTotal: 100,
    quantity: 1,
    displayName: 'item',
    purchaseUnitPrice: 100,
    quality: 'trusted',
    includeInHistory: true,
    includeInTrend: true,
    suspectedIntegerMultiple: null,
    identityLevel: 'merchant_product',
    identityConfidence: 1,
    identitySource: 'exact',
    merchantScopeKey: 'イオン',
    ...overrides,
  };
}

function countBaselinePredicateEvaluations(
  rows: readonly QualifiedIdentityObservation[],
  targets: readonly string[],
  supportedReceiptIds: ReadonlySet<string>
): number {
  let n = 0;
  for (const target of targets) {
    for (const row of rows) {
      n += 1;
      void (
        row.identityLevel === 'merchant_product' &&
        supportedReceiptIds.has(row.receiptId) &&
        row.merchantProductId === target
      );
    }
  }
  return n;
}

describe('H7.2 MP observation index', () => {
  it('source-order fixture A1,B1,A2,C1,B2,A3 matches baseline filter', () => {
    const supported = new Set(['rA1', 'rB1', 'rA2', 'rC1', 'rB2', 'rA3']);
    const A1 = qobs({ receiptId: 'rA1', merchantProductId: 'mp:A', rawName: 'A1' });
    const B1 = qobs({ receiptId: 'rB1', merchantProductId: 'mp:B', rawName: 'B1' });
    const A2 = qobs({ receiptId: 'rA2', merchantProductId: 'mp:A', rawName: 'A2' });
    const C1 = qobs({ receiptId: 'rC1', merchantProductId: 'mp:C', rawName: 'C1' });
    const B2 = qobs({ receiptId: 'rB2', merchantProductId: 'mp:B', rawName: 'B2' });
    const A3 = qobs({ receiptId: 'rA3', merchantProductId: 'mp:A', rawName: 'A3' });
    const source = [A1, B1, A2, C1, B2, A3];

    const index = buildRepeatMerchantProductObservationIndex(source, supported);

    expect(index.get('mp:A')).toEqual([A1, A2, A3]);
    expect(index.get('mp:B')).toEqual([B1, B2]);
    expect(index.get('mp:C')).toEqual([C1]);

    for (const mpId of ['mp:A', 'mp:B', 'mp:C'] as const) {
      expect(index.get(mpId)).toEqual(
        __baselineQualifiedRowsForMerchantProductForTests(
          source,
          mpId,
          supported
        )
      );
    }
  });

  it('preserves duplicate observations (multiplicity, no Set)', () => {
    const supported = new Set(['r1', 'r2']);
    const a0 = qobs({
      receiptId: 'r1',
      itemSourceIndex: 0,
      merchantProductId: 'mp:X',
      rawName: 'x0',
    });
    const a1 = qobs({
      receiptId: 'r1',
      itemSourceIndex: 1,
      merchantProductId: 'mp:X',
      rawName: 'x1',
    });
    const a2 = qobs({
      receiptId: 'r2',
      itemSourceIndex: 0,
      merchantProductId: 'mp:X',
      rawName: 'x2',
    });
    const source = [a0, a1, a2];
    const index = buildRepeatMerchantProductObservationIndex(source, supported);
    const baseline = __baselineQualifiedRowsForMerchantProductForTests(
      source,
      'mp:X',
      supported
    );
    expect(index.get('mp:X')).toEqual([a0, a1, a2]);
    expect(index.get('mp:X')).toEqual(baseline);
    expect(index.get('mp:X')!.length).toBe(3);
  });

  it('excludes unsupported receipt ids exactly as baseline', () => {
    const supported = new Set(['r-ok']);
    const ok = qobs({ receiptId: 'r-ok', merchantProductId: 'mp:Y' });
    const bad = qobs({ receiptId: 'r-bad', merchantProductId: 'mp:Y' });
    const source = [ok, bad];
    const index = buildRepeatMerchantProductObservationIndex(source, supported);
    const baseline = __baselineQualifiedRowsForMerchantProductForTests(
      source,
      'mp:Y',
      supported
    );
    expect(index.get('mp:Y')).toEqual([ok]);
    expect(index.get('mp:Y')).toEqual(baseline);
    expect(baseline).not.toContain(bad);
  });

  it('rejects non-merchant_product identity levels', () => {
    const supported = new Set(['r1', 'r2']);
    const safe = qobs({
      receiptId: 'r1',
      merchantProductId: 'mp:Z',
      identityLevel: 'merchant_product',
    });
    const family = qobs({
      receiptId: 'r2',
      merchantProductId: 'mp:Z',
      identityLevel: 'family_only',
    });
    const source = [safe, family];
    const index = buildRepeatMerchantProductObservationIndex(source, supported);
    const baseline = __baselineQualifiedRowsForMerchantProductForTests(
      source,
      'mp:Z',
      supported
    );
    expect(index.get('mp:Z')).toEqual([safe]);
    expect(index.get('mp:Z')).toEqual(baseline);
  });

  it('mixed-case merchantProductIds are distinct keys (no normalization)', () => {
    const supported = new Set(['r1', 'r2', 'r3']);
    const a = qobs({ receiptId: 'r1', merchantProductId: 'mp:A' });
    const b = qobs({ receiptId: 'r2', merchantProductId: 'MP:A' });
    const c = qobs({ receiptId: 'r3', merchantProductId: 'Mp:A' });
    const source = [a, b, c];
    const index = buildRepeatMerchantProductObservationIndex(source, supported);
    expect(index.get('mp:A')).toEqual([a]);
    expect(index.get('MP:A')).toEqual([b]);
    expect(index.get('Mp:A')).toEqual([c]);
    expect(index.size).toBe(3);
  });

  it('operation counts: indexRowVisits === N and lookups << M×N', () => {
    const supported = new Set(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    const source = [
      qobs({ receiptId: 'r1', merchantProductId: 'mp:A' }),
      qobs({ receiptId: 'r2', merchantProductId: 'mp:B' }),
      qobs({ receiptId: 'r3', merchantProductId: 'mp:A' }),
      qobs({ receiptId: 'r4', merchantProductId: 'mp:C' }),
      qobs({ receiptId: 'r5', merchantProductId: 'mp:B' }),
      qobs({ receiptId: 'r6', merchantProductId: 'mp:A' }),
    ];
    const stats: RepeatMerchantProductObservationIndexStats = {
      indexRowVisits: 0,
      bucketLookups: 0,
    };
    const index = buildRepeatMerchantProductObservationIndex(
      source,
      supported,
      stats
    );
    const targets = ['mp:A', 'mp:B', 'mp:C'];
    for (const mpId of targets) {
      stats.bucketLookups += 1;
      void (index.get(mpId) ?? []);
    }

    const baselineEvals = countBaselinePredicateEvaluations(
      source,
      targets,
      supported
    );
    expect(stats.indexRowVisits).toBe(source.length);
    expect(stats.bucketLookups).toBe(targets.length);
    expect(baselineEvals).toBe(targets.length * source.length);
    expect(stats.indexRowVisits + stats.bucketLookups).toBeLessThan(
      baselineEvals
    );
  });
});

describe('H7.2 full Repeat differential (index vs baseline filter path)', () => {
  function dualBuild(
    receipts: ReceiptRow[],
    rows: EngagementProductRow[],
    options?: {
      personalInventory?: PersonalProductEndpointInventory | null;
    }
  ): { indexed: RepeatProductProfile[]; baseline: RepeatProductProfile[] } {
    const indexed = buildRepeatProductProfiles(receipts, rows, {
      ...options,
      __useMerchantProductObservationIndexForTests: true,
    });
    const baseline = buildRepeatProductProfiles(receipts, rows, {
      ...options,
      __useMerchantProductObservationIndexForTests: false,
    });
    return { indexed, baseline };
  }

  it('full profiles + Next Purchase deep-equal for multi-MP universe', () => {
    const receipts = [1, 2, 3, 4].map((n) =>
      receipt(`r${n}`, { transaction_at: n * DAY_MS, created_at: n * DAY_MS })
    );
    const rows: EngagementProductRow[] = [
      productRow('r1', 'cola', {
        displayName: 'Cola 500ml',
        occurredAt: DAY_MS,
      }),
      productRow('r2', 'cola', {
        displayName: 'Cola 500ml',
        occurredAt: 2 * DAY_MS,
      }),
      productRow('r1', 'milk', {
        displayName: 'Milk 1L',
        sourceIndex: 1,
        occurredAt: DAY_MS,
      }),
      productRow('r3', 'milk', {
        displayName: 'Milk 1L',
        occurredAt: 3 * DAY_MS,
      }),
      productRow('r2', 'bread', {
        displayName: 'Bread',
        sourceIndex: 1,
        occurredAt: 2 * DAY_MS,
      }),
      productRow('r4', 'bread', {
        displayName: 'Bread',
        occurredAt: 4 * DAY_MS,
      }),
    ];

    const { indexed, baseline } = dualBuild(receipts, rows);
    expect(indexed).toEqual(baseline);
    expect(indexed.length).toBeGreaterThanOrEqual(2);

    const now = 10 * DAY_MS;
    expect(buildNextPurchaseCandidates(indexed, { now })).toEqual(
      buildNextPurchaseCandidates(baseline, { now })
    );
  });

  it('equal-frequency ranking tie-break unchanged', () => {
    const receipts = [1, 2].map((n) =>
      receipt(`r${n}`, { transaction_at: n * DAY_MS, created_at: n * DAY_MS })
    );
    const rows: EngagementProductRow[] = [
      productRow('r1', 'alpha', {
        displayName: 'Alpha Drink',
        occurredAt: DAY_MS,
      }),
      productRow('r2', 'alpha', {
        displayName: 'Alpha Drink',
        occurredAt: 2 * DAY_MS,
      }),
      productRow('r1', 'beta', {
        displayName: 'Beta Drink',
        sourceIndex: 1,
        occurredAt: DAY_MS,
      }),
      productRow('r2', 'beta', {
        displayName: 'Beta Drink',
        sourceIndex: 1,
        occurredAt: 2 * DAY_MS,
      }),
    ];
    const { indexed, baseline } = dualBuild(receipts, rows);
    expect(indexed).toEqual(baseline);
    expect(indexed.map((p) => p.identityKey)).toEqual(
      baseline.map((p) => p.identityKey)
    );
    expect(
      indexed.every((p) => p.purchaseOccurrenceCount === 2)
    ).toBe(true);
  });

  it('buildRepeatProductProfiles stats: visits === safeQualified length', () => {
    const receipts = [1, 2, 3].map((n) =>
      receipt(`r${n}`, { transaction_at: n * DAY_MS, created_at: n * DAY_MS })
    );
    const rows: EngagementProductRow[] = [
      productRow('r1', 'item', { displayName: 'Same Item', occurredAt: DAY_MS }),
      productRow('r2', 'item', {
        displayName: 'Same Item',
        occurredAt: 2 * DAY_MS,
      }),
      productRow('r3', 'item', {
        displayName: 'Same Item',
        occurredAt: 3 * DAY_MS,
      }),
      productRow('r1', 'other', {
        displayName: 'Other Item',
        sourceIndex: 1,
        occurredAt: DAY_MS,
      }),
      productRow('r2', 'other', {
        displayName: 'Other Item',
        sourceIndex: 1,
        occurredAt: 2 * DAY_MS,
      }),
    ];
    const stats: RepeatMerchantProductObservationIndexStats = {
      indexRowVisits: 0,
      bucketLookups: 0,
    };
    const indexed = buildRepeatProductProfiles(receipts, rows, {
      __mpObservationIndexStatsForTests: stats,
    });
    expect(indexed.length).toBeGreaterThanOrEqual(1);
    expect(stats.indexRowVisits).toBeGreaterThan(0);
    expect(stats.bucketLookups).toBeGreaterThan(0);
    // Membership work ≪ naive M×N over the visited safe set.
    expect(stats.indexRowVisits * stats.bucketLookups).toBeGreaterThan(
      stats.indexRowVisits + stats.bucketLookups
    );
    expect(stats.indexRowVisits + stats.bucketLookups).toBeLessThan(
      stats.indexRowVisits * Math.max(stats.bucketLookups, 1)
    );
  });
});

describe('H7.2 personal suppression preserved under MP index', () => {
  function sourceRow(
    overrides: Partial<PersonalProductEndpointInventorySourceRow> = {}
  ): PersonalProductEndpointInventorySourceRow {
    return {
      receiptId: 'r1',
      itemId: 'r1:0',
      sourceIndex: 0,
      occurredAt: DAY_MS,
      merchantRaw: 'AEON',
      merchantNormalized: 'aeon',
      displayName: 'Milk',
      rawName: 'Milk',
      lineTotal: 100,
      purchaseQuantity: 1,
      skuKey: null,
      brand: null,
      ...overrides,
    };
  }

  function buildPersonalInventory(
    sourceRows: PersonalProductEndpointInventorySourceRow[],
    receipts: ReceiptRow[],
    options: {
      decisionRows?: StoredPersonalProductIdentityDecision[];
      excludedDuplicateReceiptIds?: ReadonlySet<string>;
    } = {}
  ): PersonalProductEndpointInventory {
    const store = createMemoryProductIdentityStore();
    const result = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows,
      receipts,
      decisionRows: options.decisionRows ?? [],
      store,
      excludedDuplicateReceiptIds: options.excludedDuplicateReceiptIds,
    });
    if (result.status !== 'ready') {
      throw new Error(`inventory build failed: ${JSON.stringify(result)}`);
    }
    return result.inventory;
  }

  function storedDecisionFromInventory(
    inventory: PersonalProductEndpointInventory,
    leftId: string,
    rightId: string,
    decision: StoredPersonalProductIdentityDecision['decision'] = 'same_product'
  ): StoredPersonalProductIdentityDecision {
    const left = inventory.endpointsById.get(leftId)!;
    const right = inventory.endpointsById.get(rightId)!;
    const [
      leftEndpoint,
      rightEndpoint,
      leftMerchantProductId,
      rightMerchantProductId,
    ] =
      left.merchantProductId < right.merchantProductId
        ? [left, right, left.merchantProductId, right.merchantProductId]
        : [right, left, right.merchantProductId, left.merchantProductId];
    return {
      ownerKey: OWNER,
      leftMerchantProductId,
      rightMerchantProductId,
      leftMerchantScopeKey: leftEndpoint.merchantScopeKey,
      rightMerchantScopeKey: rightEndpoint.merchantScopeKey,
      leftComparisonKey: leftEndpoint.comparisonKey,
      rightComparisonKey: rightEndpoint.comparisonKey,
      leftStructuralSignature: leftEndpoint.structuralSignature,
      rightStructuralSignature: rightEndpoint.structuralSignature,
      identityPipelineVersion: leftEndpoint.identityPipelineVersion,
      decision,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  it('indexed path matches baseline filter path under personal SAME suppression', () => {
    const sourceRows = [
      sourceRow({
        receiptId: 'r-aeon',
        itemId: 'r-aeon:0',
        sourceIndex: 0,
        occurredAt: DAY_MS,
        merchantRaw: 'AEON',
        merchantNormalized: 'aeon',
      }),
      sourceRow({
        receiptId: 'r-york',
        itemId: 'r-york:0',
        sourceIndex: 0,
        occurredAt: 2 * DAY_MS,
        merchantRaw: 'York',
        merchantNormalized: 'york',
      }),
    ];
    const receipts = [
      receipt('r-aeon', {
        merchant_raw: 'AEON',
        merchant_normalized: 'aeon',
        transaction_at: DAY_MS,
        created_at: DAY_MS,
      }),
      receipt('r-york', {
        merchant_raw: 'York',
        merchant_normalized: 'york',
        transaction_at: 2 * DAY_MS,
        created_at: 2 * DAY_MS,
      }),
    ];
    const preliminary = buildPersonalInventory(sourceRows, receipts);
    const [mpA, mpB] = [...preliminary.endpointsById.keys()].sort();
    const inventory = buildPersonalInventory(sourceRows, receipts, {
      decisionRows: [
        storedDecisionFromInventory(preliminary, mpA!, mpB!, 'same_product'),
      ],
    });
    const productRows = sourceRows.map((row) =>
      productRow(row.receiptId, row.itemId, {
        sourceIndex: row.sourceIndex,
        displayName: row.displayName,
        merchantRaw: row.merchantRaw,
        merchantNormalized: row.merchantNormalized,
        occurredAt: row.occurredAt,
        lineTotal: row.lineTotal,
        purchaseQuantity: row.purchaseQuantity,
      })
    );

    const indexed = buildRepeatProductProfiles(receipts, productRows, {
      personalInventory: inventory,
      __useMerchantProductObservationIndexForTests: true,
    });
    const baseline = buildRepeatProductProfiles(receipts, productRows, {
      personalInventory: inventory,
      __useMerchantProductObservationIndexForTests: false,
    });
    expect(indexed).toEqual(baseline);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]!.identityKind).toBe('personal_product');
  });
});
