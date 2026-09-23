/**
 * Home Performance Slice H3.1 — personalInventory.db substage attribution.
 * Instrumentation only — no SQL / cache / identity changes.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';

import type { ReceiptRow } from './db';
import {
  __resetHomeFocusHeavySnapshotForTests,
  commitHomeFocusHeavySnapshot,
  tryReuseHomeFocusHeavySnapshot,
} from './homeFocusHeavySnapshot';
import { buildHomeProgressiveExperienceBundle } from './homeProgressiveExperience';
import {
  beginHomeRefreshTimingCapture,
  enableHomeRefreshTimingsForTests,
  endHomeRefreshTimingCapture,
  type HomeRefreshTimingSample,
} from './homeRefreshTimings';
import {
  __resetPersonalProductEndpointInventoryCacheForTests,
  loadPersonalProductEndpointInventoryWithDb,
  type PersonalProductEndpointInventoryDatabase,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import { readTabFocusDataGenerations } from './tabFocusDataGenerations';

const OWNER = 'user:h31-owner';
const USER_ID = 'h31-user';

function privacyKeysOf(sample: HomeRefreshTimingSample): string[] {
  return Object.keys(sample).filter(
    (k) =>
      ![
        'stage',
        'durationMs',
        'receiptCount',
        'analyticsReceiptCount',
        'productRowCount',
        'success',
        'rowCount',
        'itemRowCount',
        'decisionCount',
        'inputRowCount',
        'outputRowCount',
        'resolvedRowCount',
      ].includes(k)
  );
}

function baseReceipt(id: string, at: number): ReceiptRow {
  return {
    id,
    created_at: at,
    transaction_at: at,
    image_uri: '',
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    total: 100,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: '{}',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: USER_ID,
    installation_id: null,
  };
}

function inventorySourceRow(
  receiptId: string,
  at: number
): PersonalProductEndpointInventorySourceRow {
  return {
    receiptId,
    itemId: `${receiptId}-i0`,
    sourceIndex: 0,
    occurredAt: at,
    merchantRaw: 'イオン',
    merchantNormalized: 'イオン',
    displayName: 'Milk 500ml',
    rawName: 'Milk 500ml',
    purchaseQuantity: 1,
    lineTotal: 100,
    skuKey: null,
    brand: null,
  };
}

const stamp = {
  userId: USER_ID,
  installationId: null as string | null,
  transactionSource: 'receipt_ocr' as const,
};

beforeEach(() => {
  enableHomeRefreshTimingsForTests(true);
  beginHomeRefreshTimingCapture();
  __resetPersonalProductEndpointInventoryCacheForTests();
  __resetHomeFocusHeavySnapshotForTests();
});

afterEach(() => {
  enableHomeRefreshTimingsForTests(false);
  endHomeRefreshTimingCapture();
  __resetPersonalProductEndpointInventoryCacheForTests();
  __resetHomeFocusHeavySnapshotForTests();
});

describe('H3.1 — personalInventory.db substages', () => {
  it('success: emits items → receipts → decisions → parent db → identity once', async () => {
    const receipt = baseReceipt('r1', 1_700_000_000_000);
    const source = inventorySourceRow('r1', 1_700_000_000_000);
    const db = {
      getAllAsync: jest.fn(async (sql: string) => {
        if (String(sql).includes('FROM receipt_items')) return [source];
        if (String(sql).includes('FROM receipts')) return [receipt];
        return [];
      }),
    } as unknown as PersonalProductEndpointInventoryDatabase;

    const result = await loadPersonalProductEndpointInventoryWithDb(db, stamp, {
      useSessionCache: false,
      listDecisions: async () => [],
    });
    expect(result.status).toBe('ready');

    const samples = endHomeRefreshTimingCapture();
    const stages = samples.map((s) => s.stage);

    expect(
      stages.filter((s) => s === 'home.personalInventory.db.items')
    ).toHaveLength(1);
    expect(
      stages.filter((s) => s === 'home.personalInventory.db.receipts')
    ).toHaveLength(1);
    expect(
      stages.filter((s) => s === 'home.personalInventory.db.decisions')
    ).toHaveLength(1);
    expect(
      stages.filter((s) => s === 'home.personalInventory.db')
    ).toHaveLength(1);
    expect(
      stages.filter((s) => s === 'home.personalInventory.identity')
    ).toHaveLength(1);

    const itemsIdx = stages.indexOf('home.personalInventory.db.items');
    const receiptsIdx = stages.indexOf('home.personalInventory.db.receipts');
    const decisionsIdx = stages.indexOf('home.personalInventory.db.decisions');
    const parentIdx = stages.indexOf('home.personalInventory.db');
    const identityIdx = stages.indexOf('home.personalInventory.identity');

    expect(itemsIdx).toBeLessThan(receiptsIdx);
    expect(receiptsIdx).toBeLessThan(decisionsIdx);
    expect(decisionsIdx).toBeLessThan(parentIdx);
    expect(parentIdx).toBeLessThan(identityIdx);

    const items = samples[itemsIdx]!;
    const receipts = samples[receiptsIdx]!;
    const decisions = samples[decisionsIdx]!;
    const parent = samples[parentIdx]!;

    expect(items.success).toBe(true);
    expect(items.rowCount).toBe(1);
    expect(receipts.success).toBe(true);
    expect(receipts.rowCount).toBe(1);
    expect(decisions.success).toBe(true);
    expect(decisions.rowCount).toBe(0);
    expect(parent.success).toBe(true);
    expect(parent.durationMs).toBeGreaterThanOrEqual(items.durationMs);
    expect(parent.durationMs).toBeGreaterThanOrEqual(receipts.durationMs);
    expect(parent.durationMs).toBeGreaterThanOrEqual(decisions.durationMs);

    expect(privacyKeysOf(items)).toEqual([]);
    expect(privacyKeysOf(receipts)).toEqual([]);
    expect(privacyKeysOf(decisions)).toEqual([]);
  });

  it('Q2 failure: items ok, receipts fail, decisions/identity not emitted', async () => {
    const source = inventorySourceRow('r1', 1);
    const db = {
      getAllAsync: jest.fn(async (sql: string) => {
        if (String(sql).includes('FROM receipt_items')) return [source];
        if (String(sql).includes('FROM receipts')) {
          throw new Error('receipts-boom');
        }
        return [];
      }),
    } as unknown as PersonalProductEndpointInventoryDatabase;

    const result = await loadPersonalProductEndpointInventoryWithDb(db, stamp, {
      useSessionCache: false,
      listDecisions: async () => {
        throw new Error('decisions-should-not-run');
      },
    });

    expect(result).toEqual({
      status: 'current_endpoint_context_incomplete',
      reason: 'owner_inventory_query_failed',
    });

    const samples = endHomeRefreshTimingCapture();
    const stages = samples.map((s) => s.stage);

    expect(
      stages.filter((s) => s === 'home.personalInventory.db.items')
    ).toHaveLength(1);
    expect(
      stages.filter((s) => s === 'home.personalInventory.db.receipts')
    ).toHaveLength(1);
    expect(
      stages.some((s) => s === 'home.personalInventory.db.decisions')
    ).toBe(false);
    expect(
      stages.some((s) => s === 'home.personalInventory.identity')
    ).toBe(false);
    expect(
      stages.filter((s) => s === 'home.personalInventory.db')
    ).toHaveLength(1);

    expect(
      samples.find((s) => s.stage === 'home.personalInventory.db.items')?.success
    ).toBe(true);
    expect(
      samples.find((s) => s.stage === 'home.personalInventory.db.receipts')
        ?.success
    ).toBe(false);
    expect(
      samples.find((s) => s.stage === 'home.personalInventory.db')?.success
    ).toBe(false);
  });

  it('cache HIT does not emit child DB substages', async () => {
    const receipt = baseReceipt('r1', 1_700_000_000_000);
    const source = inventorySourceRow('r1', 1_700_000_000_000);
    const db = {
      getAllAsync: jest.fn(async (sql: string) => {
        if (String(sql).includes('FROM receipt_items')) return [source];
        if (String(sql).includes('FROM receipts')) return [receipt];
        return [];
      }),
    } as unknown as PersonalProductEndpointInventoryDatabase;

    const deps = {
      useSessionCache: true as const,
      listDecisions: async () => [],
    };

    const first = await loadPersonalProductEndpointInventoryWithDb(
      db,
      stamp,
      deps
    );
    expect(first.status).toBe('ready');
    endHomeRefreshTimingCapture();
    beginHomeRefreshTimingCapture();

    const second = await loadPersonalProductEndpointInventoryWithDb(
      db,
      stamp,
      deps
    );
    expect(second.status).toBe('ready');

    const samples = endHomeRefreshTimingCapture();
    expect(
      samples.some((s) => s.stage === 'home.personalInventory.db.items')
    ).toBe(false);
    expect(
      samples.some((s) => s.stage === 'home.personalInventory.db.receipts')
    ).toBe(false);
    expect(
      samples.some((s) => s.stage === 'home.personalInventory.db.decisions')
    ).toBe(false);
    expect(
      samples.some((s) => s.stage === 'home.personalInventory.db')
    ).toBe(false);
    expect(
      samples.some((s) => s.stage === 'home.personalInventory.identity')
    ).toBe(false);
  });

  it('warm heavySnapshot does not emit H3.1 inventory DB substages', () => {
    const experience = buildHomeProgressiveExperienceBundle([], null).experience;
    endHomeRefreshTimingCapture();
    beginHomeRefreshTimingCapture();

    const gens = readTabFocusDataGenerations();
    commitHomeFocusHeavySnapshot({
      ownerKey: OWNER,
      startGenerations: gens,
      displayReceipts: [],
      experience,
      repeatProfiles: [],
    });
    expect(tryReuseHomeFocusHeavySnapshot(OWNER)).not.toBeNull();

    const samples = endHomeRefreshTimingCapture();
    for (const stage of [
      'home.personalInventory.db.items',
      'home.personalInventory.db.receipts',
      'home.personalInventory.db.decisions',
      'home.personalInventory.db',
      'home.personalInventory.identity',
    ] as const) {
      expect(samples.some((s) => s.stage === stage)).toBe(false);
    }

    const homeSource = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    const reuseBlock = homeSource.slice(
      homeSource.indexOf('tryReuseHomeFocusHeavySnapshot'),
      homeSource.indexOf("measureHomeRefreshStage('listReceipts'")
    );
    expect(reuseBlock).not.toContain('home.personalInventory.db.items');
  });
});
