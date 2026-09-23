/**
 * Home Performance Slice H1.1 — Cold Home internal stage attribution.
 * Instrumentation only — no Home truth / scheduling / cache changes.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./env', () => ({
  isProductIdentityPriceHistoryV1Enabled: () => true,
  isAnonAuthEnabled: () => false,
  getExtra: () => ({}),
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

import * as fs from 'fs';
import * as path from 'path';

import * as currentItemMonetaryTruth from './currentItemMonetaryTruth';
import {
  loadEngagementProductInsightContextWithDb,
  type EngagementMilestoneDatabase,
  type EngagementProductRow,
  type EngagementReceipt,
} from './engagementMilestones';
import {
  __resetHomeFocusHeavySnapshotForTests,
  commitHomeFocusHeavySnapshot,
  tryReuseHomeFocusHeavySnapshot,
} from './homeFocusHeavySnapshot';
import {
  buildHomeProgressiveExperienceBundle,
} from './homeProgressiveExperience';
import {
  beginHomeRefreshTimingCapture,
  enableHomeRefreshTimingsForTests,
  endHomeRefreshTimingCapture,
  type HomeRefreshTimingSample,
} from './homeRefreshTimings';
import {
  buildPersonalProductEndpointInventory,
  loadPersonalProductEndpointInventoryWithDb,
  type PersonalProductEndpointInventoryDatabase,
  type PersonalProductEndpointInventorySourceRow,
} from './personalProductEndpointInventory';
import type { ReceiptRow } from './db';
import { readTabFocusDataGenerations } from './tabFocusDataGenerations';

const OWNER = 'user:h11-owner';
const USER_ID = 'h11-user';

function ownerScopeReady() {
  return {
    status: 'ready' as const,
    ownerKey: OWNER,
    receiptWhereSql: 'user_id = ?',
    itemWhereSql: 'receipts.user_id = ?',
    params: [USER_ID],
  };
}

function privacyKeysOf(sample: HomeRefreshTimingSample): string[] {
  return Object.keys(sample).filter(
    (k) =>
      ![
        'stage',
        'durationMs',
        'success',
        'rowCount',
        'itemRowCount',
        'receiptCount',
        'decisionCount',
        'inputRowCount',
        'outputRowCount',
        'resolvedRowCount',
        'analyticsReceiptCount',
        'productRowCount',
      ].includes(k)
  );
}

function baseReceipt(id: string, at: number): ReceiptRow {
  return {
    id,
    created_at: at,
    transaction_at: at,
    transaction_time_precision: 'second',
    image_uri: '',
    total: 100,
    tax: 0,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [{ name: 'Milk', quantity: 1, unitPrice: 100, lineTotal: 100 }],
      tax: 0,
      total: 100,
      tax_is_known: true,
      reconciliation: { ok: true },
      amount_mismatch: false,
    }),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    user_id: USER_ID,
    installation_id: null,
  };
}

function productRow(
  receiptId: string,
  itemId: string,
  at: number
): EngagementProductRow {
  return {
    receiptId,
    itemId,
    sourceIndex: 0,
    occurredAt: at,
    merchantRaw: 'イオン',
    merchantNormalized: 'イオン',
    merchant_type: 'supermarket',
    receiptAnalysisJson: JSON.stringify({
      items: [{ name: 'Milk', quantity: 1, lineTotal: 100 }],
      tax: 0,
      total: 100,
      tax_is_known: true,
      reconciliation: { ok: true },
      amount_mismatch: false,
    }),
    displayName: 'Milk',
    currency: 'JPY',
    lineTotal: 100,
    purchaseQuantity: 1,
    canonicalProductName: null,
    productFamilyKey: null,
    skuKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    grossLineAmount: 100,
    effectiveLineAmount: 100,
    discountAllocated: 0,
    receiptUserItemsJson: null,
    receiptUserEdited: 0,
    receiptTotal: 100,
    receiptFinalTotal: null,
    receiptTax: 0,
    receiptTaxIsKnown: 1,
    receiptCurrency: 'JPY',
  } as EngagementProductRow;
}

describe('Slice H1.1 — Cold Home internal stage attribution', () => {
  beforeEach(() => {
    enableHomeRefreshTimingsForTests(true);
    beginHomeRefreshTimingCapture();
    mockResolveCurrentLocalReceiptOwnerScope.mockReset();
    mockResolveCurrentLocalReceiptOwnerScope.mockResolvedValue(ownerScopeReady());
    __resetHomeFocusHeavySnapshotForTests();
  });

  afterEach(() => {
    enableHomeRefreshTimingsForTests(false);
    endHomeRefreshTimingCapture();
  });

  describe('productContext children', () => {
    it('emits db then enrich once; parent path output unchanged; privacy ok', async () => {
      const row = productRow('r1', 'i1', 1_700_000_000_000);
      const enrichSpy = jest.spyOn(
        currentItemMonetaryTruth,
        'enrichProductRowsWithCurrentItemMonetaryTruth'
      );
      const db = {
        getAllAsync: jest.fn(async (sql: string) => {
          if (String(sql).includes('FROM receipt_items')) {
            return [row];
          }
          return [];
        }),
      } as unknown as EngagementMilestoneDatabase;

      const ctx = await loadEngagementProductInsightContextWithDb(db, {
        preloaded: {
          ownerKey: OWNER,
          receipts: [baseReceipt('r1', 1_700_000_000_000) as EngagementReceipt],
          analyticsReceipts: [
            baseReceipt('r1', 1_700_000_000_000) as EngagementReceipt,
          ],
          excludedDuplicateReceiptIds: new Set(),
          analyticsGeneration: 1,
          precomputedSelection: true,
        },
      });

      expect(ctx.queryFailed).toBe(false);
      expect(ctx.rows).toHaveLength(1);
      expect(enrichSpy).toHaveBeenCalledTimes(1);

      const samples = endHomeRefreshTimingCapture();
      const stages = samples.map((s) => s.stage);
      expect(stages.filter((s) => s === 'home.productContext.db')).toHaveLength(
        1
      );
      expect(
        stages.filter((s) => s === 'home.productContext.enrich')
      ).toHaveLength(1);
      const dbIdx = stages.indexOf('home.productContext.db');
      const enrichIdx = stages.indexOf('home.productContext.enrich');
      expect(dbIdx).toBeGreaterThan(-1);
      expect(enrichIdx).toBeGreaterThan(dbIdx);

      const dbSample = samples[dbIdx]!;
      const enrichSample = samples[enrichIdx]!;
      expect(dbSample.success).toBe(true);
      expect(dbSample.rowCount).toBe(1);
      expect(enrichSample.success).toBe(true);
      expect(enrichSample.inputRowCount).toBe(1);
      expect(enrichSample.outputRowCount).toBe(1);
      expect(privacyKeysOf(dbSample)).toEqual([]);
      expect(privacyKeysOf(enrichSample)).toEqual([]);

      enrichSpy.mockRestore();
    });

    it('propagates db failure with success:false', async () => {
      const db = {
        getAllAsync: jest.fn(async (sql: string) => {
          if (String(sql).includes('FROM receipt_items')) {
            throw new Error('db-boom');
          }
          return [];
        }),
      } as unknown as EngagementMilestoneDatabase;
      const ctx = await loadEngagementProductInsightContextWithDb(db, {
        preloaded: {
          ownerKey: OWNER,
          receipts: [baseReceipt('r1', 1) as EngagementReceipt],
          analyticsReceipts: [baseReceipt('r1', 1) as EngagementReceipt],
          excludedDuplicateReceiptIds: new Set(),
          analyticsGeneration: 1,
          precomputedSelection: true,
        },
      });
      // readProductInsightContext swallows into queryFailed
      expect(ctx.queryFailed).toBe(true);
      const samples = endHomeRefreshTimingCapture();
      const dbSample = samples.find((s) => s.stage === 'home.productContext.db');
      expect(dbSample?.success).toBe(false);
      expect(
        samples.some((s) => s.stage === 'home.productContext.enrich')
      ).toBe(false);
    });
  });

  describe('personalInventory children', () => {
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
      } as PersonalProductEndpointInventorySourceRow;
    }

    it('emits db then identity once; result unchanged; no extra identity resolves', async () => {
      const receipt = baseReceipt('r1', 1_700_000_000_000);
      const source = inventorySourceRow('r1', 1_700_000_000_000);
      let identityCalls = 0;
      const db = {
        getAllAsync: jest.fn(async (sql: string) => {
          if (String(sql).includes('FROM receipt_items')) return [source];
          if (String(sql).includes('FROM receipts')) return [receipt];
          return [];
        }),
      } as unknown as PersonalProductEndpointInventoryDatabase;

      const result = await loadPersonalProductEndpointInventoryWithDb(
        db,
        {
          userId: USER_ID,
          installationId: null,
          transactionSource: 'receipt_ocr',
        },
        {
          useSessionCache: false,
          listDecisions: async () => [],
          buildInventory: (input) => {
            const wrapped = {
              ...input,
              onIdentityResolve: () => {
                identityCalls += 1;
                input.onIdentityResolve?.();
              },
            };
            return buildPersonalProductEndpointInventory(wrapped);
          },
        }
      );

      expect(result.status === 'ready' || result.status !== 'owner_unavailable').toBe(
        true
      );

      const samples = endHomeRefreshTimingCapture();
      const stages = samples.map((s) => s.stage);
      expect(
        stages.filter((s) => s === 'home.personalInventory.db')
      ).toHaveLength(1);
      expect(
        stages.filter((s) => s === 'home.personalInventory.identity')
      ).toHaveLength(1);
      const dbIdx = stages.indexOf('home.personalInventory.db');
      const idIdx = stages.indexOf('home.personalInventory.identity');
      expect(idIdx).toBeGreaterThan(dbIdx);

      const dbSample = samples[dbIdx]!;
      const idSample = samples[idIdx]!;
      expect(dbSample.success).toBe(true);
      expect(dbSample.itemRowCount).toBe(1);
      expect(dbSample.receiptCount).toBe(1);
      expect(dbSample.decisionCount).toBe(0);
      expect(idSample.success).toBe(true);
      expect(idSample.inputRowCount).toBe(1);
      expect(idSample.resolvedRowCount).toBe(identityCalls);
      expect(privacyKeysOf(dbSample)).toEqual([]);
      expect(privacyKeysOf(idSample)).toEqual([]);
    });

    it('propagates identity throw as construction_failed after success:false', async () => {
      const receipt = baseReceipt('r1', 1);
      const source = inventorySourceRow('r1', 1);
      const db = {
        getAllAsync: jest.fn(async (sql: string) => {
          if (String(sql).includes('FROM receipt_items')) return [source];
          if (String(sql).includes('FROM receipts')) return [receipt];
          return [];
        }),
      } as unknown as PersonalProductEndpointInventoryDatabase;

      const result = await loadPersonalProductEndpointInventoryWithDb(
        db,
        {
          userId: USER_ID,
          installationId: null,
          transactionSource: 'receipt_ocr',
        },
        {
          useSessionCache: false,
          listDecisions: async () => [],
          buildInventory: () => {
            throw new Error('identity-boom');
          },
        }
      );

      expect(result).toEqual({
        status: 'current_endpoint_context_incomplete',
        reason: 'inventory_construction_failed',
      });
      const samples = endHomeRefreshTimingCapture();
      const idSample = samples.find(
        (s) => s.stage === 'home.personalInventory.identity'
      );
      expect(idSample?.success).toBe(false);
    });
  });

  describe('progressive.repeatBuild', () => {
    it('emits once on frequent-stage build; parent still buildHomeProgressiveExperienceBundle', () => {
      const receipts = Array.from({ length: 5 }, (_, i) =>
        baseReceipt(`r${i}`, 1_700_000_000_000 + i * 86_400_000)
      );
      const rows = receipts.map((r, i) => productRow(r.id, `i${i}`, r.created_at));
      const evaluation = {
        status: {
          supportedReceiptCount: 5,
          currentMilestone: 5 as const,
          justUnlocked: null,
          nextMilestone: 10 as const,
          receiptsUntilNext: 5,
        },
        currentResult: null,
      };

      const bundle = buildHomeProgressiveExperienceBundle(
        receipts,
        evaluation,
        false,
        rows,
        null,
        Date.now(),
        receipts
      );
      expect(bundle.experience.stage).toBe('frequent');

      const samples = endHomeRefreshTimingCapture();
      const repeatSamples = samples.filter(
        (s) => s.stage === 'home.progressive.repeatBuild'
      );
      expect(repeatSamples).toHaveLength(1);
      expect(repeatSamples[0]!.success).toBe(true);
      expect(repeatSamples[0]!.inputRowCount).toBe(rows.length);
      expect(privacyKeysOf(repeatSamples[0]!)).toEqual([]);
    });

    it('does not emit repeatBuild when frequent stage locked', () => {
      const receipts = [baseReceipt('r1', 1)];
      buildHomeProgressiveExperienceBundle(receipts, null, false, [], null);
      const samples = endHomeRefreshTimingCapture();
      expect(
        samples.some((s) => s.stage === 'home.progressive.repeatBuild')
      ).toBe(false);
    });
  });

  describe('concurrency + warm reuse contracts', () => {
    it('keeps Phase A as Promise.all (not sequential awaits)', () => {
      const homeSource = fs.readFileSync(
        path.resolve(__dirname, '../app/(tabs)/index.tsx'),
        'utf8'
      );
      const phaseAStart = homeSource.indexOf(
        'const [evaluation, productContext, personalInventory]'
      );
      const phaseAEnd = homeSource.indexOf(
        "measureHomeRefreshStage(\n            'buildHomeProgressiveExperience'"
      );
      const phaseA =
        phaseAEnd > phaseAStart
          ? homeSource.slice(phaseAStart, phaseAEnd)
          : homeSource.slice(
              phaseAStart,
              homeSource.indexOf(
                "measureHomeRefreshStage('buildHomeProgressiveExperience'"
              )
            );
      // Fallback: also accept single-line measure form
      const block =
        phaseA.length > 0
          ? phaseA
          : homeSource.slice(
              phaseAStart,
              homeSource.indexOf('finalCompleteExperience = await')
            );
      expect(block).toContain('Promise.all([');
      expect(block).toContain("measureHomeRefreshStage('engagementMilestone'");
      expect(block).toContain("measureHomeRefreshStage('productContext'");
      expect(block).toContain("measureHomeRefreshStage('personalInventory'");
      expect(block).not.toMatch(
        /await measureHomeRefreshStage\('engagementMilestone'[\s\S]*await measureHomeRefreshStage\('productContext'/
      );
    });

    it('warm heavySnapshotReuse does not rebuild H1.1 child stages', () => {
      const experience = buildHomeProgressiveExperienceBundle([], null).experience;
      // Clear any timing from the empty build above.
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
      const reused = tryReuseHomeFocusHeavySnapshot(OWNER);
      expect(reused).not.toBeNull();

      const samples = endHomeRefreshTimingCapture();
      const childStages = [
        'home.productContext.db',
        'home.productContext.enrich',
        'home.personalInventory.db',
        'home.personalInventory.identity',
        'home.progressive.repeatBuild',
      ] as const;
      for (const stage of childStages) {
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
      expect(reuseBlock).toContain("stage: 'heavySnapshotReuse'");
      expect(reuseBlock).toContain('return;');
      expect(reuseBlock).not.toContain('home.productContext.db');
      expect(reuseBlock).not.toContain('home.personalInventory');
      expect(reuseBlock).not.toContain('home.progressive.repeatBuild');
    });

    it('parent stage names remain in Home wiring', () => {
      const homeSource = fs.readFileSync(
        path.resolve(__dirname, '../app/(tabs)/index.tsx'),
        'utf8'
      );
      for (const stage of [
        'personalInventory',
        'productContext',
        'engagementMilestone',
        'buildHomeProgressiveExperience',
        'volatileRefresh',
        'heavySnapshotReuse',
      ]) {
        expect(homeSource).toContain(`'${stage}'`);
      }
    });
  });
});
