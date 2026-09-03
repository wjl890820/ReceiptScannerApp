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
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import type { EngagementProductRow } from './engagementMilestones';
import { buildHomeProgressiveExperience } from './homeProgressiveExperience';
import {
  buildPersonalProductEndpointInventory,
  type PersonalProductEndpointInventory,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import type { StoredPersonalProductIdentityDecision } from './personalProductIdentityContract';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import {
  buildPurchaseEventDatesFromRows,
  buildRepeatIntervalStats,
  buildRepeatProductProfiles,
  isRepeatEligible,
  mapRepeatProductProfileToHomeFrequentProduct,
  takeHomeRepeatProducts,
  type RepeatProductProfile,
} from './repeatProductProfile';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER = 'user:repeat-owner';

function receipt(
  id: string,
  overrides: Partial<ReceiptRow> = {}
): ReceiptRow {
  const index = Number(String(id).replace(/\D/g, '')) || 1;
  return {
    id,
    created_at: index * DAY_MS,
    transaction_at: index * DAY_MS,
    image_uri: '',
    total: 100,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({ items: [] }),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: 'repeat-owner',
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

function unlockedStatus(count = 5) {
  return {
    supportedReceiptCount: count,
    currentMilestone: count >= 10 ? (10 as const) : (5 as const),
    justUnlocked: null,
    nextMilestone: count >= 10 ? null : (10 as const),
    receiptsUntilNext: count >= 10 ? null : 10 - count,
  };
}

describe('repeatProductProfile timeline helpers', () => {
  it('keeps equal timestamps from different receipts', () => {
    const result = buildPurchaseEventDatesFromRows([
      { receiptId: 'a', occurredAt: 1000 },
      { receiptId: 'b', occurredAt: 1000 },
    ]);
    expect(result.purchaseOccurrenceCount).toBe(2);
    expect(result.purchaseEventDates).toEqual([1000, 1000]);
  });

  it('counts undated receipt occurrence without timeline entry', () => {
    const result = buildPurchaseEventDatesFromRows([
      { receiptId: 'dated', occurredAt: 5000 },
      { receiptId: 'undated', occurredAt: 0 },
    ]);
    expect(result.purchaseOccurrenceCount).toBe(2);
    expect(result.datedPurchaseOccurrenceCount).toBe(1);
    expect(result.purchaseEventDates).toEqual([5000]);
    expect(result.firstPurchasedAt).toBe(5000);
    expect(result.lastPurchasedAt).toBe(5000);
  });

  it('computes median interval from consecutive dated events', () => {
    const profile: Pick<
      RepeatProductProfile,
      'purchaseEventDates' | 'datedPurchaseOccurrenceCount'
    > = {
      purchaseEventDates: [0, 7 * DAY_MS, 17 * DAY_MS, 24 * DAY_MS],
      datedPurchaseOccurrenceCount: 4,
    };
    const stats = buildRepeatIntervalStats(profile);
    expect(stats.intervalSampleSize).toBe(3);
    expect(stats.previousPurchasedAt).toBe(17 * DAY_MS);
    expect(stats.medianIntervalDays).toBe(7);
  });

  it('I. thresholds: 1 not repeat; 2 repeat without median; 3 dated allows median', () => {
    expect(isRepeatEligible({ purchaseOccurrenceCount: 1 })).toBe(false);
    expect(isRepeatEligible({ purchaseOccurrenceCount: 2 })).toBe(true);
    const twoDated = buildRepeatIntervalStats({
      purchaseEventDates: [0, DAY_MS],
      datedPurchaseOccurrenceCount: 2,
    });
    expect(twoDated.medianIntervalDays).toBeNull();
    const threeDated = buildRepeatIntervalStats({
      purchaseEventDates: [0, 7 * DAY_MS, 17 * DAY_MS],
      datedPurchaseOccurrenceCount: 3,
    });
    expect(threeDated.medianIntervalDays).toBe(8.5);
  });
});

describe('repeatProductProfile production identity path', () => {
  const GYOMU_TX_AT = 1786351380000;
  const GYOMU_NOW_MS = Date.parse('2026-09-01T12:00:00+09:00');
  const GYOMU_LINE_AMOUNTS = [372, 378, 108, 313, 100, 103, 88, 1756] as const;
  const GYOMU_SEVEN_RECEIPT_IDS = [
    'ACsMESsCvPCD9Vsgpmn4V',
    'erhG0uXoyTm6vRFNCrBFe',
    'KzeeGp7HDiUxMu0D0CyzE',
    'lmg2SfKrcRGFCM1JVpOMS',
    'rbVx_AFdAfnwFywe11mR_',
    'sLOTqc_9eqHnMhJLlzQpx',
    'auq8r7qU-EN_l38Y2xDea',
  ] as const;
  const GYOMU_BASE_NAMES = [
    '商品A',
    '商品B',
    '商品C',
    '商品D',
    '商品E',
    '商品F',
    '商品G',
  ] as const;

  function gyomuRealItems(
    order: readonly number[],
    variant: 'standard' | 'outlier'
  ) {
    return order.map((lineIndex) => {
      const lineTotal = GYOMU_LINE_AMOUNTS[lineIndex]!;
      if (lineIndex === 7) {
        return {
          name:
            variant === 'outlier'
              ? '正宗生煎包'
              : '正宗生煎包 (4個 x @439)',
          category: 'food_ingredients',
          lineTotal: 1756,
          quantity: variant === 'outlier' ? 1 : 4,
        };
      }
      return {
        name: GYOMU_BASE_NAMES[lineIndex]!,
        category: 'food_ingredients',
        lineTotal,
        quantity: 1,
      };
    });
  }

  function buildGyomuSevenScanFixture(): ReceiptRow[] {
    const itemOrders = [
      [0, 1, 2, 3, 4, 5, 6, 7],
      [7, 6, 5, 4, 3, 2, 1, 0],
      [2, 4, 6, 0, 1, 3, 5, 7],
      [1, 3, 5, 7, 0, 2, 4, 6],
      [4, 0, 6, 2, 7, 1, 5, 3],
      [3, 7, 1, 5, 2, 6, 0, 4],
      [5, 2, 0, 7, 4, 1, 6, 3],
    ];
    return GYOMU_SEVEN_RECEIPT_IDS.map((id, index) =>
      receipt(id, {
        created_at: GYOMU_NOW_MS - index * 60_000,
        transaction_at: GYOMU_TX_AT,
        total: 3393,
        tax: 251,
        tax_is_known: 1,
        merchant_raw:
          index % 2 === 0 ? '業務スーパー古川店' : '業務スーパー古川',
        merchant_normalized:
          index % 2 === 0 ? '業務スーパー古川店' : '業務スーパー古川',
        analysis_json: JSON.stringify({
          items: gyomuRealItems(
            itemOrders[index]!,
            id === 'auq8r7qU-EN_l38Y2xDea' ? 'outlier' : 'standard'
          ),
        }),
      })
    );
  }

  it('A. Gyomu production fixture: 7 stored → 1 canonical → exactly 1 safe occurrence', () => {
    const stored = buildGyomuSevenScanFixture();
    expect(stored).toHaveLength(7);

    const selection = selectAnalyticsReceipts(stored);
    expect(selection.analyticsReceipts).toHaveLength(1);
    expect(selection.excludedDuplicateReceiptIds.size).toBe(6);

    const canonical = selection.analyticsReceipts[0]!;
    const items = JSON.parse(canonical.analysis_json || '{}').items as Array<{
      name?: string;
      lineTotal?: number;
      quantity?: number;
    }>;
    const baoIndex = items.findIndex((item) =>
      String(item.name || '').includes('生煎包')
    );
    expect(baoIndex).toBeGreaterThanOrEqual(0);
    const bao = items[baoIndex]!;

    const {
      resolveIdentityConsumerObservations,
    } = require('./productIdentityConsumer') as typeof import('./productIdentityConsumer');
    const { createMemoryProductIdentityStore } =
      require('./productIdentityStore') as typeof import('./productIdentityStore');
    const store = createMemoryProductIdentityStore();
    const merchantKey =
      (canonical.merchant_normalized || canonical.merchant_raw || '').trim() ||
      'unknown_merchant';
    const { qualified } = resolveIdentityConsumerObservations(
      [
        {
          receiptId: canonical.id,
          itemSourceIndex: baoIndex,
          rawName: String(bao.name),
          merchantKey,
          occurredAt: canonical.transaction_at ?? canonical.created_at,
          lineTotal: bao.lineTotal ?? 1756,
          quantity: bao.quantity ?? 1,
          displayName: String(bao.name),
        },
      ],
      store
    );
    expect(qualified).toHaveLength(1);
    expect(qualified[0]!.identityLevel).toBe('merchant_product');
    expect(qualified[0]!.merchantProductId).toBeTruthy();

    const productRows = [
      productRow(canonical.id, `bao-${baoIndex}`, {
        sourceIndex: baoIndex,
        displayName: String(bao.name),
        merchantRaw: canonical.merchant_raw,
        merchantNormalized: canonical.merchant_normalized,
        occurredAt: canonical.transaction_at ?? canonical.created_at,
        purchaseQuantity: bao.quantity ?? 1,
        lineTotal: bao.lineTotal ?? 1756,
      }),
    ];
    const profiles = buildRepeatProductProfiles(
      selection.analyticsReceipts,
      productRows
    );
    // One merchant_product-qualified occurrence → not Repeat.
    expect(profiles).toHaveLength(0);

    const later = receipt('gyomu-later', {
      merchant_raw: merchantKey,
      merchant_normalized: merchantKey,
      transaction_at: GYOMU_TX_AT + DAY_MS,
      created_at: GYOMU_NOW_MS + DAY_MS,
    });
    const withSecond = buildRepeatProductProfiles(
      [...selection.analyticsReceipts, later],
      [
        ...productRows,
        productRow(later.id, 'bao-later', {
          displayName: String(bao.name),
          merchantRaw: merchantKey,
          merchantNormalized: merchantKey,
          occurredAt: later.transaction_at ?? later.created_at,
          purchaseQuantity: bao.quantity ?? 1,
          lineTotal: bao.lineTotal ?? 1756,
        }),
      ]
    );
    expect(withSecond).toHaveLength(1);
    expect(withSecond[0]!.identityKind).toBe('merchant_product');
    expect(withSecond[0]!.purchaseOccurrenceCount).toBe(2);
  });

  it('B. 牛乳 1L and 牛乳 500ml remain separate (no family merge into one Repeat)', () => {
    // First observation of each generic milk label is family_spec; subsequent
    // same-comparison-key rows become merchant_product while reusing MP id.
    // Use three receipts per spec so each has ≥2 merchant_product-qualified rows.
    const receipts = [1, 2, 3, 4, 5, 6].map((n) =>
      receipt(`r${n}`, { transaction_at: n * DAY_MS, created_at: n * DAY_MS })
    );
    const rows = [
      productRow('r1', 'a1', { displayName: '牛乳 1L', occurredAt: DAY_MS, productFamilyKey: 'milk' }),
      productRow('r2', 'a2', { displayName: '牛乳 1L', occurredAt: 2 * DAY_MS, productFamilyKey: 'milk' }),
      productRow('r3', 'a3', { displayName: '牛乳 1L', occurredAt: 3 * DAY_MS, productFamilyKey: 'milk' }),
      productRow('r4', 'b1', { displayName: '牛乳 500ml', occurredAt: 4 * DAY_MS, productFamilyKey: 'milk' }),
      productRow('r5', 'b2', { displayName: '牛乳 500ml', occurredAt: 5 * DAY_MS, productFamilyKey: 'milk' }),
      productRow('r6', 'b3', { displayName: '牛乳 500ml', occurredAt: 6 * DAY_MS, productFamilyKey: 'milk' }),
    ];
    const profiles = buildRepeatProductProfiles(receipts, rows);
    expect(profiles).toHaveLength(2);
    expect(profiles.every((p) => p.identityKind === 'merchant_product')).toBe(true);
    expect(profiles.every((p) => p.purchaseOccurrenceCount === 2)).toBe(true);
    expect(profiles[0]!.identityKey).not.toBe(profiles[1]!.identityKey);
    const labels = profiles.map((p) => p.displayName).join(' ');
    expect(labels.includes('1L') || labels.includes('1l')).toBe(true);
    expect(labels.includes('500')).toBe(true);
  });

  it('C. legacy family-only grouping is not a Repeat V1 authority', () => {
    const receipts = [
      receipt('r1', { transaction_at: DAY_MS }),
      receipt('r2', { transaction_at: 2 * DAY_MS }),
    ];
    const rows = [
      productRow('r1', 'a', {
        displayName: '牛乳 1L',
        productFamilyKey: 'milk',
        occurredAt: DAY_MS,
      }),
      productRow('r2', 'b', {
        displayName: '牛乳 500ml',
        productFamilyKey: 'milk',
        occurredAt: 2 * DAY_MS,
      }),
    ];
    const profiles = buildRepeatProductProfiles(receipts, rows);
    expect(profiles).toHaveLength(0);
  });

  it('strict: family_only sharing merchantProductId cannot inflate Repeat', () => {
    // Production path: first generic '牛乳' → family_only + MP M;
    // second same comparison key → merchant_product reusing M.
    const receipts = [
      receipt('rA', { transaction_at: DAY_MS }),
      receipt('rB', { transaction_at: 2 * DAY_MS }),
      receipt('rC', { transaction_at: 3 * DAY_MS }),
    ];
    const rows = [
      productRow('rA', 'a', { displayName: '牛乳', occurredAt: DAY_MS }),
      productRow('rB', 'b', { displayName: '牛乳', occurredAt: 2 * DAY_MS }),
      productRow('rC', 'c', { displayName: '牛乳', occurredAt: 3 * DAY_MS }),
    ];
    const {
      resolveIdentityConsumerObservations,
    } = require('./productIdentityConsumer') as typeof import('./productIdentityConsumer');
    const { createMemoryProductIdentityStore } =
      require('./productIdentityStore') as typeof import('./productIdentityStore');
    const store = createMemoryProductIdentityStore();
    const { qualified } = resolveIdentityConsumerObservations(
      rows.map((row) => ({
        receiptId: row.receiptId,
        itemSourceIndex: row.sourceIndex,
        rawName: row.displayName,
        merchantKey: row.merchantNormalized || 'イオン',
        occurredAt: row.occurredAt,
        lineTotal: row.lineTotal,
        quantity: row.purchaseQuantity,
        displayName: row.displayName,
      })),
      store
    );
    expect(qualified.map((q) => q.identityLevel)).toEqual([
      'family_only',
      'merchant_product',
      'merchant_product',
    ]);
    expect(
      new Set(qualified.map((q) => q.merchantProductId)).size
    ).toBe(1);

    // With only family_only + one merchant_product → no Repeat.
    const twoOnly = buildRepeatProductProfiles(receipts.slice(0, 2), rows.slice(0, 2));
    expect(twoOnly).toHaveLength(0);

    // Two merchant_product-qualified → Repeat with occurrence 2 (family_only excluded).
    const profiles = buildRepeatProductProfiles(receipts, rows);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.identityKind).toBe('merchant_product');
    expect(profiles[0]!.purchaseOccurrenceCount).toBe(2);
    expect(profiles[0]!.purchaseEventDates).toEqual([2 * DAY_MS, 3 * DAY_MS]);
  });

  it('strict: family_spec sharing merchantProductId cannot inflate Repeat', () => {
    const receipts = [
      receipt('rA', { transaction_at: DAY_MS }),
      receipt('rB', { transaction_at: 2 * DAY_MS }),
      receipt('rC', { transaction_at: 3 * DAY_MS }),
    ];
    const rows = [
      productRow('rA', 'a', { displayName: '牛乳 1L', occurredAt: DAY_MS }),
      productRow('rB', 'b', { displayName: '牛乳 1L', occurredAt: 2 * DAY_MS }),
      productRow('rC', 'c', { displayName: '牛乳 1L', occurredAt: 3 * DAY_MS }),
    ];
    const {
      resolveIdentityConsumerObservations,
    } = require('./productIdentityConsumer') as typeof import('./productIdentityConsumer');
    const { createMemoryProductIdentityStore } =
      require('./productIdentityStore') as typeof import('./productIdentityStore');
    const { qualified } = resolveIdentityConsumerObservations(
      rows.map((row) => ({
        receiptId: row.receiptId,
        itemSourceIndex: row.sourceIndex,
        rawName: row.displayName,
        merchantKey: row.merchantNormalized || 'イオン',
        occurredAt: row.occurredAt,
        lineTotal: row.lineTotal,
        quantity: row.purchaseQuantity,
        displayName: row.displayName,
      })),
      createMemoryProductIdentityStore()
    );
    expect(qualified.map((q) => q.identityLevel)).toEqual([
      'family_spec',
      'merchant_product',
      'merchant_product',
    ]);
    expect(new Set(qualified.map((q) => q.merchantProductId)).size).toBe(1);

    expect(
      buildRepeatProductProfiles(receipts.slice(0, 2), rows.slice(0, 2))
    ).toHaveLength(0);

    const profiles = buildRepeatProductProfiles(receipts, rows);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.purchaseOccurrenceCount).toBe(2);
    expect(profiles[0]!.purchaseEventDates).toEqual([2 * DAY_MS, 3 * DAY_MS]);
  });

  it('D. same receipt duplicate lines → occurrence 1; quantity may accumulate', () => {
    const receipts = [
      receipt('r1', { transaction_at: DAY_MS }),
      receipt('r2', { transaction_at: 2 * DAY_MS }),
    ];
    const rows = [
      productRow('r1', 'a0', {
        displayName: 'コカ・コーラ 500ml',
        sourceIndex: 0,
        purchaseQuantity: 2,
        occurredAt: DAY_MS,
      }),
      productRow('r1', 'a1', {
        displayName: 'コカ・コーラ 500ml',
        sourceIndex: 1,
        purchaseQuantity: 3,
        occurredAt: DAY_MS,
      }),
      productRow('r2', 'b0', {
        displayName: 'コカ・コーラ 500ml',
        sourceIndex: 0,
        purchaseQuantity: 1,
        occurredAt: 2 * DAY_MS,
      }),
    ];
    const profiles = buildRepeatProductProfiles(receipts, rows);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.purchaseOccurrenceCount).toBe(2);
    expect(profiles[0]!.totalPurchaseQuantity).toBe(6);
  });

  it('E. same-day different canonical receipts → occurrence 2 and both dates kept', () => {
    const sameDay = 1_700_000_000_000;
    const receipts = [
      receipt('r1', { transaction_at: sameDay, created_at: sameDay }),
      receipt('r2', { transaction_at: sameDay, created_at: sameDay + 1 }),
    ];
    const rows = [
      productRow('r1', 'a', {
        displayName: 'コカ・コーラ 500ml',
        occurredAt: sameDay,
      }),
      productRow('r2', 'b', {
        displayName: 'コカ・コーラ 500ml',
        occurredAt: sameDay,
      }),
    ];
    const profiles = buildRepeatProductProfiles(receipts, rows);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.purchaseOccurrenceCount).toBe(2);
    expect(profiles[0]!.purchaseEventDates).toEqual([sameDay, sameDay]);
  });

  it('F. created_at fallback enters timeline; zero timestamp does not', () => {
    const receipts = [
      receipt('r1', { transaction_at: null, created_at: 5 * DAY_MS }),
      receipt('r2', { transaction_at: null, created_at: 0 }),
      receipt('r3', { transaction_at: 9 * DAY_MS, created_at: 9 * DAY_MS }),
    ];
    const rows = [
      productRow('r1', 'a', {
        displayName: 'コカ・コーラ 500ml',
        occurredAt: 5 * DAY_MS,
      }),
      productRow('r2', 'b', {
        displayName: 'コカ・コーラ 500ml',
        occurredAt: 0,
      }),
      productRow('r3', 'c', {
        displayName: 'コカ・コーラ 500ml',
        occurredAt: 9 * DAY_MS,
      }),
    ];
    const profiles = buildRepeatProductProfiles(receipts, rows);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.purchaseOccurrenceCount).toBe(3);
    expect(profiles[0]!.datedPurchaseOccurrenceCount).toBe(2);
    expect(profiles[0]!.purchaseEventDates).toEqual([5 * DAY_MS, 9 * DAY_MS]);
  });

  it('G. hidden/excluded duplicate member contributes zero extra occurrence', () => {
    const receipts = [
      receipt('keep', { transaction_at: DAY_MS }),
      receipt('later', { transaction_at: 3 * DAY_MS }),
    ];
    const rows = [
      productRow('keep', 'a', {
        displayName: 'コカ・コーラ 500ml',
        occurredAt: DAY_MS,
      }),
      productRow('hidden', 'h', {
        displayName: 'コカ・コーラ 500ml',
        occurredAt: 2 * DAY_MS,
      }),
      productRow('later', 'b', {
        displayName: 'コカ・コーラ 500ml',
        occurredAt: 3 * DAY_MS,
      }),
    ];
    const profiles = buildRepeatProductProfiles(receipts, rows);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.purchaseOccurrenceCount).toBe(2);
    expect(profiles[0]!.purchaseEventDates).toEqual([DAY_MS, 3 * DAY_MS]);
  });
});

describe('repeatProductProfile personal SAME', () => {
  function sourceRow(
    overrides: Partial<PersonalProductEndpointInventorySourceRow> = {}
  ): PersonalProductEndpointInventorySourceRow {
    return {
      receiptId: 'r1',
      itemId: 'r1:0',
      sourceIndex: 0,
      occurredAt: DAY_MS,
      merchantRaw: 'Lawson',
      merchantNormalized: 'lawson',
      displayName: 'コカ・コーラ 500ml',
      rawName: 'コカ・コーラ 500ml',
      lineTotal: 150,
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
    const [leftEndpoint, rightEndpoint, leftMerchantProductId, rightMerchantProductId] =
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

  it('H. explicit personal SAME combines distinct canonical receipts', () => {
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
    expect(mpA).toBeTruthy();
    expect(mpB).toBeTruthy();
    expect(mpA).not.toBe(mpB);

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

    const withoutPersonal = buildRepeatProductProfiles(receipts, productRows);
    expect(withoutPersonal).toHaveLength(0);

    const profiles = buildRepeatProductProfiles(receipts, productRows, {
      personalInventory: inventory,
    });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.identityKind).toBe('personal_product');
    expect(profiles[0]!.purchaseOccurrenceCount).toBe(2);
    expect(profiles[0]!.purchaseEventDates).toEqual([DAY_MS, 2 * DAY_MS]);
    expect(profiles[0]!.datedPurchaseOccurrenceCount).toBe(2);
  });
});

describe('repeatProductProfile Home wiring', () => {
  it('K. Home consumes Repeat V1; no family filler; cap 5; sorting', () => {
    const receipts = [1, 2, 3, 4, 5, 6].map((n) =>
      receipt(`r${n}`, { transaction_at: n * DAY_MS, created_at: n * DAY_MS })
    );
    const rows: EngagementProductRow[] = [];
    for (let i = 0; i < 8; i += 1) {
      const name = `商品${i} 500ml`;
      rows.push(
        productRow('r1', `${i}-a`, {
          displayName: name,
          occurredAt: DAY_MS,
          productFamilyKey: 'drinks',
        }),
        productRow('r2', `${i}-b`, {
          displayName: name,
          occurredAt: 2 * DAY_MS,
          productFamilyKey: 'drinks',
        })
      );
    }
    // Extra family-only bait that must never appear as Repeat filler.
    rows.push(
      productRow('r3', 'fam-a', {
        displayName: '完全不同A',
        productFamilyKey: 'milk',
        occurredAt: 3 * DAY_MS,
      }),
      productRow('r4', 'fam-b', {
        displayName: '完全不同B',
        productFamilyKey: 'milk',
        occurredAt: 4 * DAY_MS,
      })
    );

    const all = buildRepeatProductProfiles(receipts, rows);
    expect(all.every((p) => p.identityKind === 'merchant_product')).toBe(true);
    expect(all.some((p) => p.identityKey === 'milk')).toBe(false);
    expect(takeHomeRepeatProducts(all).length).toBeLessThanOrEqual(5);

    const experience = buildHomeProgressiveExperience(
      receipts,
      { status: unlockedStatus(6), currentResult: null },
      false,
      rows
    );
    expect(experience.stage).toBe('frequent');
    expect(experience.frequentProducts.length).toBeLessThanOrEqual(5);
    expect(
      experience.frequentProducts.every(
        (p) =>
          p.groupingType === 'merchant_product' ||
          p.groupingType === 'personal_product'
      )
    ).toBe(true);
    expect(
      experience.frequentProducts.every((p) => p.groupingType !== 'family')
    ).toBe(true);

    for (let i = 1; i < experience.frequentProducts.length; i += 1) {
      const prev = experience.frequentProducts[i - 1]!;
      const next = experience.frequentProducts[i]!;
      expect(prev.purchaseOccurrenceCount).toBeGreaterThanOrEqual(
        next.purchaseOccurrenceCount
      );
    }
  });

  it('L. user-edit/index: updated indexed display is used; excluded id not double-counted', () => {
    const receipts = [
      receipt('r1', { transaction_at: DAY_MS }),
      receipt('r2', { transaction_at: 2 * DAY_MS }),
    ];
    const beforeEdit = buildRepeatProductProfiles(receipts, [
      productRow('r1', 'a', {
        displayName: 'コカ・コーラ 500ml',
        occurredAt: DAY_MS,
      }),
      productRow('r2', 'b', {
        displayName: 'コカ・コーラ 500ml',
        occurredAt: 2 * DAY_MS,
      }),
    ]);
    expect(beforeEdit).toHaveLength(1);

    const afterEdit = buildRepeatProductProfiles(receipts, [
      productRow('r1', 'a', {
        displayName: 'コカ・コーラZERO 500ml',
        occurredAt: DAY_MS,
      }),
      productRow('r2', 'b', {
        displayName: 'コカ・コーラZERO 500ml',
        occurredAt: 2 * DAY_MS,
      }),
      // Stale excluded sibling must not add occurrence when not in analytics set.
      productRow('r1-dup', 'stale', {
        displayName: 'コカ・コーラ 500ml',
        occurredAt: DAY_MS,
      }),
    ]);
    expect(afterEdit).toHaveLength(1);
    expect(afterEdit[0]!.purchaseOccurrenceCount).toBe(2);
    expect(afterEdit[0]!.displayName.includes('ZERO')).toBe(true);
    const home = mapRepeatProductProfileToHomeFrequentProduct(afterEdit[0]!);
    expect(home.purchaseOccurrenceCount).toBe(2);
    expect(home.groupingType).toBe('merchant_product');
  });

  it('Home: family_only cannot help cross Repeat threshold or create frequent item', () => {
    const receipts = [1, 2, 3, 4, 5].map((n) =>
      receipt(`r${n}`, { transaction_at: n * DAY_MS, created_at: n * DAY_MS })
    );
    const rows = [
      productRow('r1', 'a', { displayName: '牛乳', occurredAt: DAY_MS }),
      productRow('r2', 'b', { displayName: '牛乳', occurredAt: 2 * DAY_MS }),
    ];
    const experience = buildHomeProgressiveExperience(
      receipts,
      { status: unlockedStatus(5), currentResult: null },
      false,
      rows
    );
    expect(experience.stage).toBe('frequent');
    expect(experience.frequentProducts).toEqual([]);
  });
});
