/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import {
  buildPersonalIdentityPromptCandidateV1,
  classifyPersonalIdentityCandidatePair,
  collectCanonicalReceiptIdsForMerchantProducts,
  findPersonalIdentityPromptCandidateForSavedReceipt,
  findPersonalIdentityPromptCandidatesForInventory,
  historicalMerchantProductHasCanonicalEvent,
  rankPersonalIdentityPromptCandidates,
  selectHistoricalRepresentativeItem,
  type RankablePersonalIdentityPromptCandidate,
} from './personalProductIdentityCandidateService';
import {
  buildPersonalProductEndpointInventory,
  type PersonalProductEndpointInventory,
  type PersonalProductInventoryItem,
} from './personalProductEndpointInventory';
import {
  buildPersonalMerchantProductEndpointV1,
  type StoredPersonalProductIdentityDecision,
} from './personalProductIdentityContract';
import { buildProductAttributes } from './productIdentityContract';
import { createMemoryPersonalProductIdentityDatabase } from './personalProductIdentityRepository';
import type { ReceiptRow } from './db';

const OWNER = 'user:candidate-owner';
const SAVED = 'saved-r';

function endpoint(
  id: string,
  scope: string,
  comparisonKey: string,
  volumeMl?: number,
  packCount?: number
) {
  const entries = [];
  if (volumeMl != null) {
    entries.push({ dimension: 'volume' as const, value: volumeMl, unit: 'ml' });
  }
  if (packCount != null) {
    entries.push({
      dimension: 'pack_count' as const,
      value: packCount,
      unit: 'count',
    });
  }
  return buildPersonalMerchantProductEndpointV1({
    merchantProductId: id,
    merchantScopeKey: scope,
    comparisonKey,
    attributes: buildProductAttributes(entries),
  });
}

function item(
  overrides: Partial<PersonalProductInventoryItem> & {
    merchantProductId: string;
    receiptId: string;
    sourceIndex: number;
  }
): PersonalProductInventoryItem {
  const ep = endpoint(
    overrides.merchantProductId,
    overrides.merchantScopeKey ?? 'lawson',
    overrides.merchantProductId,
    500
  );
  return {
    itemId: `${overrides.receiptId}-${overrides.sourceIndex}`,
    occurredAt: overrides.occurredAt ?? 1_700_000_000_000,
    identityLevel: overrides.identityLevel ?? 'merchant_product',
    displayName: overrides.displayName ?? 'コカ・コーラ 500ml',
    merchantName: overrides.merchantName ?? 'Lawson',
    rawName: overrides.rawName ?? overrides.displayName ?? 'コカ・コーラ 500ml',
    merchantScopeKey: overrides.merchantScopeKey ?? ep.merchantScopeKey,
    skuKey: overrides.skuKey ?? null,
    brand: overrides.brand ?? null,
    attributes:
      overrides.attributes ??
      buildProductAttributes([{ dimension: 'volume', value: 500, unit: 'ml' }]),
    specificationLabel: '500ml',
    ...overrides,
  };
}

function receiptRow(id: string, merchant = 'lawson', merchantRaw = 'Lawson'): ReceiptRow {
  return {
    id,
    created_at: 1_700_000_000_000,
    transaction_at: 1_700_000_000_000,
    image_uri: 'file://x',
    merchant_raw: merchantRaw,
    merchant_normalized: merchant,
    merchant_type: 'convenience',
    total: 500,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: '{}',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: OWNER.slice('user:'.length),
    installation_id: null,
  };
}

function inventoryFromItems(
  items: PersonalProductInventoryItem[],
  decisionRows: StoredPersonalProductIdentityDecision[] = [],
  receipts: ReceiptRow[] = []
): PersonalProductEndpointInventory {
  const endpointsById = new Map(
    items.map((row) => [
      row.merchantProductId,
      endpoint(
        row.merchantProductId,
        row.merchantScopeKey,
        row.merchantProductId,
        500,
        row.attributes?.entries.find((entry) => entry.dimension === 'pack_count')
          ?.value as number | undefined
      ),
    ])
  );
  const itemsByRowKey = new Map(
    items.map((row) => [`${row.receiptId}:${row.sourceIndex}`, row])
  );
  const itemKeysByMerchantProductId = new Map<string, string[]>();
  for (const row of items) {
    const key = `${row.receiptId}:${row.sourceIndex}`;
    const list = itemKeysByMerchantProductId.get(row.merchantProductId) ?? [];
    list.push(key);
    itemKeysByMerchantProductId.set(row.merchantProductId, list);
  }
  const receiptsById = new Map(
    (receipts.length ? receipts : items.map((row) => receiptRow(row.receiptId))).map(
      (row) => [row.id, row]
    )
  );
  const snapshot = new Map<string, ReturnType<typeof endpoint> | null>();
  for (const id of new Set(items.map((row) => row.merchantProductId))) {
    snapshot.set(id, endpointsById.get(id) ?? null);
  }
  for (const row of decisionRows) {
    snapshot.set(
      row.leftMerchantProductId,
      endpointsById.get(row.leftMerchantProductId) ?? snapshot.get(row.leftMerchantProductId) ?? null
    );
    snapshot.set(
      row.rightMerchantProductId,
      endpointsById.get(row.rightMerchantProductId) ??
        snapshot.get(row.rightMerchantProductId) ??
        null
    );
  }
  return {
    ownerKey: OWNER,
    snapshot,
    endpointsById,
    merchantProductsById: new Map(),
    itemsByRowKey,
    itemKeysByMerchantProductId,
    receiptsById,
    excludedDuplicateReceiptIds: new Set(),
    decisionRows,
  };
}

function storedDecision(
  left: ReturnType<typeof endpoint>,
  right: ReturnType<typeof endpoint>,
  decision: StoredPersonalProductIdentityDecision['decision']
): StoredPersonalProductIdentityDecision {
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

describe('G4-2A personalProductIdentityCandidateService', () => {
  const mpCurrent = 'mp-current';
  const mpHistorical = 'mp-historical';

  const baseCurrent = item({
    merchantProductId: mpCurrent,
    receiptId: SAVED,
    sourceIndex: 0,
    merchantScopeKey: 'lawson',
    displayName: 'コカ・コーラ 500ml',
    rawName: 'コカ・コーラ 500ml',
  });
  const baseHistorical = item({
    merchantProductId: mpHistorical,
    receiptId: 'hist-r',
    sourceIndex: 0,
    merchantScopeKey: 'seven',
    merchantName: 'Seven',
    displayName: 'コカ・コーラ 500ml',
    rawName: 'コカ・コーラ 500ml',
    occurredAt: 1_699_000_000_000,
  });
  const secondHistoricalReceipt = item({
    merchantProductId: mpHistorical,
    receiptId: 'hist-r-2',
    sourceIndex: 0,
    merchantScopeKey: 'seven',
    merchantName: 'Seven',
    displayName: 'コカ・コーラ 500ml',
    rawName: 'コカ・コーラ 500ml',
    occurredAt: 1_698_000_000_000,
  });

  it('1 cross-merchant similar product with >=2 purchase events => candidate', () => {
    const inventory = inventoryFromItems(
      [baseCurrent, baseHistorical, secondHistoricalReceipt],
      [],
      [receiptRow(SAVED), receiptRow('hist-r', 'seven', 'Seven'), receiptRow('hist-r-2', 'seven', 'Seven')]
    );
    const classified = classifyPersonalIdentityCandidatePair({
      inventory,
      currentItem: baseCurrent,
      historicalItem: baseHistorical,
      savedReceiptId: SAVED,
    });
    expect(classified.classification).toBe('prompt_candidate');
    const ranked = findPersonalIdentityPromptCandidatesForInventory(inventory, SAVED);
    expect(ranked.length).toBe(1);
    expect(ranked[0]?.valueReason).toBe('cross_merchant_history');
  });

  it('2 family/spec only identity level => no candidate', () => {
    const inventory = inventoryFromItems([
      { ...baseCurrent, identityLevel: 'family_spec' },
      baseHistorical,
      secondHistoricalReceipt,
    ]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: inventory.itemsByRowKey.get(`${SAVED}:0`)!,
        historicalItem: inventory.itemsByRowKey.get('hist-r:0')!,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('3 different flavor/variant => no candidate', () => {
    const lemon = item({
      merchantProductId: 'mp-lemon',
      receiptId: 'hist-r',
      sourceIndex: 0,
      merchantScopeKey: 'seven',
      displayName: 'コカ・コーラ レモン 500ml',
      rawName: 'コカ・コーラ レモン 500ml',
    });
    const inventory = inventoryFromItems([baseCurrent, lemon, secondHistoricalReceipt]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: lemon,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('4 500ml vs 1000ml => no candidate', () => {
    const liter = item({
      merchantProductId: 'mp-liter',
      receiptId: 'hist-r',
      sourceIndex: 0,
      merchantScopeKey: 'seven',
      displayName: 'コカ・コーラ 1000ml',
      rawName: 'コカ・コーラ 1000ml',
      attributes: buildProductAttributes([
        { dimension: 'volume', value: 1000, unit: 'ml' },
      ]),
    });
    const inventory = inventoryFromItems([baseCurrent, liter, secondHistoricalReceipt]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: liter,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('5 known personal SAME => no candidate', () => {
    const left = endpoint(mpCurrent, 'lawson', mpCurrent, 500);
    const right = endpoint(mpHistorical, 'seven', mpHistorical, 500);
    const inventory = inventoryFromItems(
      [baseCurrent, baseHistorical, secondHistoricalReceipt],
      [storedDecision(left, right, 'same_product')]
    );
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: baseHistorical,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('6 known personal NO => no candidate', () => {
    const left = endpoint(mpCurrent, 'lawson', mpCurrent, 500);
    const right = endpoint(mpHistorical, 'seven', mpHistorical, 500);
    const inventory = inventoryFromItems(
      [baseCurrent, baseHistorical, secondHistoricalReceipt],
      [storedDecision(left, right, 'not_same_product')]
    );
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: baseHistorical,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('7 known valid UNSURE => no candidate', () => {
    const left = endpoint(mpCurrent, 'lawson', mpCurrent, 500);
    const right = endpoint(mpHistorical, 'seven', mpHistorical, 500);
    const inventory = inventoryFromItems(
      [baseCurrent, baseHistorical, secondHistoricalReceipt],
      [storedDecision(left, right, 'unsure')]
    );
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: baseHistorical,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('8 stale UNSURE with current descriptors may prompt again', () => {
    const left = endpoint(mpCurrent, 'lawson', mpCurrent, 500);
    const staleRight = endpoint(mpHistorical, 'seven', 'old-comparison', 500);
    const currentRight = endpoint(mpHistorical, 'seven', mpHistorical, 500);
    const inventory = inventoryFromItems(
      [baseCurrent, baseHistorical, secondHistoricalReceipt],
      [storedDecision(left, staleRight, 'unsure')]
    );
    inventory.snapshot = new Map(inventory.snapshot);
    (inventory.snapshot as Map<string, typeof currentRight | null>).set(
      mpHistorical,
      currentRight
    );
    inventory.endpointsById = new Map(inventory.endpointsById);
    (inventory.endpointsById as Map<string, typeof currentRight>).set(
      mpHistorical,
      currentRight
    );
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: baseHistorical,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('prompt_candidate');
  });

  it('9 same MerchantProduct ID => automatic_exact / no prompt', () => {
    const sameMp = item({
      merchantProductId: mpCurrent,
      receiptId: 'hist-r',
      sourceIndex: 0,
      merchantScopeKey: 'seven',
      displayName: 'コカ・コーラ 500ml',
      rawName: 'コカ・コーラ 500ml',
    });
    const inventory = inventoryFromItems([baseCurrent, sameMp, secondHistoricalReceipt]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: sameMp,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('automatic_exact');
  });

  it('10 same authoritative nonempty sku_key => automatic_exact', () => {
    const sku = 'sku:abc123';
    const current = { ...baseCurrent, skuKey: sku };
    const historical = { ...baseHistorical, skuKey: sku };
    const inventory = inventoryFromItems([current, historical, secondHistoricalReceipt]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: current,
        historicalItem: historical,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('automatic_exact');
  });

  it('11 high similarity without meaningful structure => no candidate', () => {
    const noStructCurrent = {
      ...baseCurrent,
      attributes: buildProductAttributes([]),
      displayName: 'コカ・コーラ',
      rawName: 'コカ・コーラ',
    };
    const noStructHistorical = {
      ...baseHistorical,
      attributes: buildProductAttributes([]),
      displayName: 'コカ・コーラ',
      rawName: 'コカ・コーラ',
    };
    const inventory = inventoryFromItems([
      noStructCurrent,
      noStructHistorical,
      secondHistoricalReceipt,
    ]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: noStructCurrent,
        historicalItem: noStructHistorical,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('12 meaningful same structure but similarity below .96 => no candidate', () => {
    const differentName = {
      ...baseHistorical,
      displayName: 'ペプシコーラ 500ml',
      rawName: 'ペプシコーラ 500ml',
    };
    const inventory = inventoryFromItems([
      baseCurrent,
      differentName,
      secondHistoricalReceipt,
    ]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: differentName,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('13 both known brands differ => no candidate', () => {
    const brandedCurrent = { ...baseCurrent, brand: 'Coca-Cola' };
    const brandedHistorical = { ...baseHistorical, brand: 'Pepsi' };
    const inventory = inventoryFromItems([
      brandedCurrent,
      brandedHistorical,
      secondHistoricalReceipt,
    ]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: brandedCurrent,
        historicalItem: brandedHistorical,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('14 many matches => exactly one top candidate', () => {
    const alt = item({
      merchantProductId: 'mp-alt',
      receiptId: 'hist-r-3',
      sourceIndex: 0,
      merchantScopeKey: 'familymart',
      displayName: 'コカ・コーラ 500ml',
      rawName: 'コカ・コーラ 500ml',
      occurredAt: 1_697_000_000_000,
    });
    const altHistory = item({
      merchantProductId: 'mp-alt',
      receiptId: 'hist-r-4',
      sourceIndex: 0,
      merchantScopeKey: 'familymart',
      displayName: 'コカ・コーラ 500ml',
      rawName: 'コカ・コーラ 500ml',
      occurredAt: 1_696_000_000_000,
    });
    const inventory = inventoryFromItems([
      baseCurrent,
      baseHistorical,
      secondHistoricalReceipt,
      alt,
      altHistory,
    ]);
    const ranked = findPersonalIdentityPromptCandidatesForInventory(inventory, SAVED);
    const top = rankPersonalIdentityPromptCandidates(ranked, inventory)[0];
    expect(top).toBeTruthy();
    const candidate = buildPersonalIdentityPromptCandidateV1({
      savedReceiptId: SAVED,
      currentItem: top!.currentItem,
      historicalItem: top!.historicalItem,
      inventory,
      similarity: top!.similarity,
      valueReason: top!.valueReason,
      prospectivePurchaseEventCount: top!.prospectivePurchaseEventCount,
      prospectiveMerchantCount: top!.prospectiveMerchantCount,
    });
    expect(candidate).toBeTruthy();
    expect(
      findPersonalIdentityPromptCandidatesForInventory(inventory, SAVED).length
    ).toBeGreaterThan(1);
    expect(candidate?.pair.leftMerchantProductId).toBeTruthy();
  });

  it('15 cross-merchant outranks same-merchant candidate', () => {
    const sameMerchant = item({
      merchantProductId: 'mp-same-merchant',
      receiptId: 'hist-r',
      sourceIndex: 0,
      merchantScopeKey: 'lawson',
      displayName: 'コカ・コーラ 500ml',
      rawName: 'コカ・コーラ 500ml',
    });
    const ranked = rankPersonalIdentityPromptCandidates(
      [
        {
          currentItem: baseCurrent,
          historicalItem: sameMerchant,
          similarity: 0.99,
          prospectivePurchaseEventCount: 3,
          prospectiveMerchantCount: 1,
          valueReason: 'repeat_purchase_history',
        },
        {
          currentItem: baseCurrent,
          historicalItem: baseHistorical,
          similarity: 0.97,
          prospectivePurchaseEventCount: 2,
          prospectiveMerchantCount: 2,
          valueReason: 'cross_merchant_history',
        },
      ],
      inventoryFromItems([baseCurrent, sameMerchant, baseHistorical, secondHistoricalReceipt])
    );
    expect(ranked[0]?.valueReason).toBe('cross_merchant_history');
  });

  it('16 more purchase events breaks tie after cross-merchant priority', () => {
    const ranked = rankPersonalIdentityPromptCandidates(
      [
        {
          currentItem: baseCurrent,
          historicalItem: baseHistorical,
          similarity: 0.97,
          prospectivePurchaseEventCount: 2,
          prospectiveMerchantCount: 2,
          valueReason: 'cross_merchant_history',
        },
        {
          currentItem: baseCurrent,
          historicalItem: {
            ...baseHistorical,
            merchantProductId: 'mp-more-events',
            merchantScopeKey: 'familymart',
          },
          similarity: 0.97,
          prospectivePurchaseEventCount: 4,
          prospectiveMerchantCount: 3,
          valueReason: 'cross_merchant_history',
        },
      ],
      inventoryFromItems([baseCurrent, baseHistorical, secondHistoricalReceipt])
    );
    expect(ranked[0]?.prospectivePurchaseEventCount).toBe(4);
  });

  it('17 current side must belong to savedReceiptId', () => {
    const inventory = inventoryFromItems([baseCurrent, baseHistorical, secondHistoricalReceipt]);
    const ranked = findPersonalIdentityPromptCandidatesForInventory(inventory, SAVED);
    expect(ranked.every((row) => row.currentItem.receiptId === SAVED)).toBe(true);
  });

  it('18 same canonical purchase event cannot supply historical repeat value alone', () => {
    const onlySavedHistorical = item({
      merchantProductId: mpHistorical,
      receiptId: SAVED,
      sourceIndex: 1,
      merchantScopeKey: 'seven',
      displayName: 'コカ・コーラ500ml',
      rawName: 'コカ・コーラ500ml',
    });
    const inventory = inventoryFromItems([baseCurrent, onlySavedHistorical]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: onlySavedHistorical,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('19 duplicate DB observations cannot inflate purchase-event count', () => {
    const inventory = inventoryFromItems(
      [baseCurrent, baseHistorical, secondHistoricalReceipt],
      [],
      [receiptRow(SAVED), receiptRow('hist-r', 'seven', 'Seven'), receiptRow('hist-r-2', 'seven', 'Seven')]
    );
    inventory.excludedDuplicateReceiptIds = new Set(['hist-r-2']);
    const receiptIds = collectCanonicalReceiptIdsForMerchantProducts(inventory, [
      mpCurrent,
      mpHistorical,
    ]);
    expect(receiptIds.has('hist-r-2')).toBe(false);
    expect(receiptIds.size).toBe(2);
  });

  it('20 candidate service makes zero writes to personal decision table', async () => {
    const memory = createMemoryPersonalProductIdentityDatabase();
    const db = {
      async getAllAsync<T>(source: string) {
        if (/receipt_items/i.test(source)) return [] as T[];
        if (/FROM receipts/i.test(source)) return [] as T[];
        return memory.getAllAsync<T>(source);
      },
    };
    const before = memory.txnDb.insertCalls;
    await findPersonalIdentityPromptCandidateForSavedReceipt(SAVED, db, {
      userId: OWNER.slice('user:'.length),
      installationId: null,
      transactionSource: 'receipt_ocr',
    });
    expect(memory.txnDb.insertCalls).toBe(before);
  });

  it('6-pack vs 12-pack => no candidate', () => {
    const sixPack = item({
      merchantProductId: 'mp-6',
      receiptId: 'hist-r',
      sourceIndex: 0,
      merchantScopeKey: 'seven',
      displayName: 'コカ・コーラ 500ml 6本',
      rawName: 'コカ・コーラ 500ml 6本',
      attributes: buildProductAttributes([
        { dimension: 'volume', value: 500, unit: 'ml' },
        { dimension: 'pack_count', value: 6, unit: 'count' },
      ]),
    });
    const twelveCurrent = item({
      merchantProductId: mpCurrent,
      receiptId: SAVED,
      sourceIndex: 0,
      merchantScopeKey: 'lawson',
      displayName: 'コカ・コーラ 500ml 12本',
      rawName: 'コカ・コーラ 500ml 12本',
      attributes: buildProductAttributes([
        { dimension: 'volume', value: 500, unit: 'ml' },
        { dimension: 'pack_count', value: 12, unit: 'count' },
      ]),
    });
    const inventory = inventoryFromItems([twelveCurrent, sixPack, secondHistoricalReceipt]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: twelveCurrent,
        historicalItem: sixPack,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });
});

describe('G4-2A canonical purchase-event gates', () => {
  const mpCurrent = 'mp-current';
  const mpHistorical = 'mp-historical';
  const SAVED = 'saved-r';

  const baseCurrent = item({
    merchantProductId: mpCurrent,
    receiptId: SAVED,
    sourceIndex: 0,
    merchantScopeKey: 'lawson',
    displayName: 'コカ・コーラ 500ml',
    rawName: 'コカ・コーラ 500ml',
  });
  const baseHistorical = item({
    merchantProductId: mpHistorical,
    receiptId: 'hist-r',
    sourceIndex: 0,
    merchantScopeKey: 'seven',
    merchantName: 'Seven',
    displayName: 'コカ・コーラ 500ml',
    rawName: 'コカ・コーラ 500ml',
    occurredAt: 1_699_000_000_000,
  });
  const olderCurrentHistory = item({
    merchantProductId: mpCurrent,
    receiptId: 'old-current-r',
    sourceIndex: 0,
    merchantScopeKey: 'lawson',
    displayName: 'コカ・コーラ 500ml',
    rawName: 'コカ・コーラ 500ml',
    occurredAt: 1_698_000_000_000,
  });

  it('1 duplicate-excluded savedReceiptId blocks candidate even with strong historical match', () => {
    const inventory = inventoryFromItems([baseCurrent, baseHistorical]);
    inventory.excludedDuplicateReceiptIds = new Set([SAVED]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: baseHistorical,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('2 union count cannot rescue historical endpoint with only duplicate-excluded rows', () => {
    const excludedHistoricalOnly = item({
      merchantProductId: mpHistorical,
      receiptId: 'dup-hist',
      sourceIndex: 0,
      merchantScopeKey: 'seven',
      displayName: 'コカ・コーラ 500ml',
      rawName: 'コカ・コーラ 500ml',
      occurredAt: 1_697_000_000_000,
    });
    const inventory = inventoryFromItems([
      baseCurrent,
      olderCurrentHistory,
      excludedHistoricalOnly,
    ]);
    inventory.excludedDuplicateReceiptIds = new Set(['dup-hist']);
    expect(
      collectCanonicalReceiptIdsForMerchantProducts(inventory, [mpCurrent, mpHistorical]).size
    ).toBeGreaterThanOrEqual(2);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: excludedHistoricalOnly,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('3 historical endpoint with one valid non-excluded receipt qualifies independently', () => {
    const inventory = inventoryFromItems([baseCurrent, baseHistorical, olderCurrentHistory]);
    expect(
      historicalMerchantProductHasCanonicalEvent(inventory, mpHistorical, SAVED)
    ).toBe(true);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: baseHistorical,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('prompt_candidate');
  });

  it('4 representative skips newer duplicate-excluded row and picks older valid canonical row', () => {
    const newerExcluded = item({
      merchantProductId: mpHistorical,
      receiptId: 'dup-newer',
      sourceIndex: 0,
      merchantScopeKey: 'seven',
      displayName: 'コカ・コーラ 500ml',
      rawName: 'コカ・コーラ 500ml',
      occurredAt: 1_700_500_000_000,
    });
    const olderValid = item({
      merchantProductId: mpHistorical,
      receiptId: 'valid-older',
      sourceIndex: 0,
      merchantScopeKey: 'seven',
      displayName: 'コカ・コーラ 500ml',
      rawName: 'コカ・コーラ 500ml',
      occurredAt: 1_698_500_000_000,
    });
    const inventory = inventoryFromItems([newerExcluded, olderValid]);
    inventory.excludedDuplicateReceiptIds = new Set(['dup-newer']);
    expect(
      selectHistoricalRepresentativeItem(inventory, mpHistorical, SAVED)?.receiptId
    ).toBe('valid-older');
  });

  it('5 historical endpoint with only excluded rows yields null representative', () => {
    const excludedOnly = item({
      merchantProductId: mpHistorical,
      receiptId: 'dup-only',
      sourceIndex: 0,
      merchantScopeKey: 'seven',
      displayName: 'コカ・コーラ 500ml',
      rawName: 'コカ・コーラ 500ml',
    });
    const inventory = inventoryFromItems([excludedOnly]);
    inventory.excludedDuplicateReceiptIds = new Set(['dup-only']);
    expect(
      selectHistoricalRepresentativeItem(inventory, mpHistorical, SAVED)
    ).toBeNull();
    expect(
      findPersonalIdentityPromptCandidatesForInventory(inventory, SAVED).length
    ).toBe(0);
  });

  it('6 rows only on savedReceiptId cannot satisfy historical repeat value', () => {
    const sameReceiptHistorical = item({
      merchantProductId: mpHistorical,
      receiptId: SAVED,
      sourceIndex: 1,
      merchantScopeKey: 'seven',
      displayName: 'コカ・コーラ 500ml',
      rawName: 'コカ・コーラ 500ml',
    });
    const inventory = inventoryFromItems([baseCurrent, sameReceiptHistorical]);
    expect(
      classifyPersonalIdentityCandidatePair({
        inventory,
        currentItem: baseCurrent,
        historicalItem: sameReceiptHistorical,
        savedReceiptId: SAVED,
      }).classification
    ).toBe('no_match');
  });

  it('7 prospective purchase-event count uses distinct non-excluded canonical receiptIds', () => {
    const secondHistoricalReceipt = item({
      merchantProductId: mpHistorical,
      receiptId: 'hist-r-2',
      sourceIndex: 0,
      merchantScopeKey: 'seven',
      displayName: 'コカ・コーラ 500ml',
      rawName: 'コカ・コーラ 500ml',
      occurredAt: 1_696_000_000_000,
    });
    const inventory = inventoryFromItems([
      baseCurrent,
      baseHistorical,
      secondHistoricalReceipt,
      olderCurrentHistory,
    ]);
    inventory.excludedDuplicateReceiptIds = new Set(['hist-r-2']);
    const classified = classifyPersonalIdentityCandidatePair({
      inventory,
      currentItem: baseCurrent,
      historicalItem: baseHistorical,
      savedReceiptId: SAVED,
    });
    expect(classified.classification).toBe('prompt_candidate');
    expect(classified.prospectivePurchaseEventCount).toBe(3);
  });
});

describe('G4-2A integration build path', () => {
  it('buildPersonalProductEndpointInventory produces candidate-ready inventory', () => {
    const productName = 'テスト専用飲料ABCDEF 500ml';
    const result = buildPersonalProductEndpointInventory({
      ownerKey: OWNER,
      sourceRows: [
        {
          receiptId: SAVED,
          itemId: 'i1',
          sourceIndex: 0,
          occurredAt: 1_700_000_000_000,
          merchantRaw: 'Lawson',
          merchantNormalized: 'lawson',
          displayName: productName,
          rawName: productName,
          lineTotal: 150,
          purchaseQuantity: 1,
          skuKey: null,
          brand: null,
        },
        {
          receiptId: 'hist-r',
          itemId: 'i2',
          sourceIndex: 0,
          occurredAt: 1_699_000_000_000,
          merchantRaw: 'Seven',
          merchantNormalized: 'seven',
          displayName: productName,
          rawName: productName,
          lineTotal: 160,
          purchaseQuantity: 1,
          skuKey: null,
          brand: null,
        },
        {
          receiptId: 'hist-r-2',
          itemId: 'i3',
          sourceIndex: 0,
          occurredAt: 1_698_000_000_000,
          merchantRaw: 'Seven',
          merchantNormalized: 'seven',
          displayName: productName,
          rawName: productName,
          lineTotal: 160,
          purchaseQuantity: 1,
          skuKey: null,
          brand: null,
        },
      ],
      receipts: [
        receiptRow(SAVED),
        receiptRow('hist-r', 'seven', 'Seven'),
        receiptRow('hist-r-2', 'seven', 'Seven'),
      ],
      decisionRows: [],
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    const items = [...result.inventory.itemsByRowKey.values()];
    expect(items.length).toBe(3);
    expect(new Set(items.map((row) => row.merchantScopeKey)).size).toBe(2);
    expect(new Set(items.map((row) => row.merchantProductId)).size).toBe(2);
    const currentItem = items.find((row) => row.receiptId === SAVED);
    const historicalItem = items.find((row) => row.receiptId === 'hist-r');
    expect(currentItem).toBeTruthy();
    expect(historicalItem).toBeTruthy();
    expect(currentItem!.identityLevel).toBe('merchant_product');
    expect(historicalItem!.identityLevel).toBe('merchant_product');
    const currentEndpoint = result.inventory.endpointsById.get(currentItem!.merchantProductId);
    const historicalEndpoint = result.inventory.endpointsById.get(
      historicalItem!.merchantProductId
    );
    expect(currentEndpoint?.structuralSignature).toBe(
      historicalEndpoint?.structuralSignature
    );
    const classified = classifyPersonalIdentityCandidatePair({
      inventory: result.inventory,
      currentItem: currentItem!,
      historicalItem: historicalItem!,
      savedReceiptId: SAVED,
    });
    expect(classified).toMatchObject({
      classification: 'prompt_candidate',
      prospectivePurchaseEventCount: 3,
    });
    const ranked = findPersonalIdentityPromptCandidatesForInventory(
      result.inventory,
      SAVED
    );
    expect(ranked.length).toBeGreaterThanOrEqual(1);
  });
});
