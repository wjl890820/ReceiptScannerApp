/**
 * Target receipt evidence export — narrow INTERNAL/Validation instrumentation.
 * Observational / SELECT-only; no monetary recovery on persisted rows.
 */

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  getInitializedReceiptsDatabaseOrThrow: jest.fn(() => {
    throw new Error('db must not be opened by pure projection tests');
  }),
  ReceiptsDatabaseNotInitializedError: class ReceiptsDatabaseNotInitializedError extends Error {
    constructor(message?: string) {
      super(message ?? 'Receipts database is not initialized');
      this.name = 'ReceiptsDatabaseNotInitializedError';
    }
  },
}));

import * as fs from 'fs';
import * as path from 'path';

import { assertReceiptsDbExportAllowed } from './receiptsDbExport';
import {
  TARGET_RECEIPT_EVIDENCE_FORBIDDEN_JSON_SUBSTRINGS,
  TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
  TARGET_RECEIPT_ITEMS_SELECT_SQL,
  TARGET_RECEIPT_SELECT_SQL,
  assertTargetReceiptEvidenceJsonSafe,
  buildTargetReceiptEvidenceExport,
  classifyUserItemsJsonRaw,
  loadTargetReceiptEvidenceWithDb,
  type TargetReceiptEvidenceDatabase,
} from './targetReceiptEvidenceExport';

const NOW = Date.parse('2026-09-07T03:00:00.000Z');

function analysisJson(partial: {
  items?: unknown[];
  discounts?: unknown[];
  reconciliation?: Record<string, unknown>;
  ocr_raw_text?: string;
}): string {
  return JSON.stringify({
    items: partial.items ?? [],
    discounts: partial.discounts ?? [],
    reconciliation: partial.reconciliation ?? {
      ok: true,
      itemsPositiveSum: 760,
      discountsSum: -76,
      tax: 0,
      total: 684,
      expectedTotal: 684,
      diff: 0,
    },
    ...(partial.ocr_raw_text ? { ocr_raw_text: partial.ocr_raw_text } : {}),
  });
}

function item0(overrides: Record<string, unknown> = {}) {
  return {
    name: '鶏肉',
    quantity: 1,
    lineTotal: 378,
    discountAllocated: 0,
    effectiveLineTotal: 378,
    ...overrides,
  };
}

function item1(overrides: Record<string, unknown> = {}) {
  return {
    name: '鶏肉',
    quantity: 1,
    lineTotal: 378,
    discountAllocated: 0,
    effectiveLineTotal: 378,
    ...overrides,
  };
}

describe('targetReceiptEvidenceExport', () => {
  it('A — target receipt row is projected narrowly (no full analysis dump)', () => {
    const ocrBlob = 'FULL OCR TEXT MUST NOT APPEAR '.repeat(20);
    const payload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      app: { version: '1.0.0', build: '110' },
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({
          items: [item0(), item1(), { name: 'unrelated-item-2', lineTotal: 99 }],
          discounts: [
            {
              label: '割引 10%',
              amount: -38,
              adjacentPrecedingItemIndex: 0,
            },
          ],
          ocr_raw_text: ocrBlob,
        }),
        user_items_json: null,
      },
      persistedItemRows: [],
    });

    expect(payload.targetReceiptId).toBe(TARGET_RECEIPT_EVIDENCE_RECEIPT_ID);
    expect(payload.receipt.found).toBe(true);
    expect(payload.analysis.items).toHaveLength(2);
    expect(payload.analysis.items.map((i) => i.sourceIndex)).toEqual([0, 1]);
    expect(payload.analysis.items.some((i) => i.name === 'unrelated-item-2')).toBe(
      false
    );
    const json = JSON.stringify(payload);
    expect(json).not.toContain(ocrBlob.slice(0, 40));
    expect(json).not.toContain('ocr_raw_text');
    assertTargetReceiptEvidenceJsonSafe(payload);
  });

  it('B — analysis JSON with two -38 discounts exports both', () => {
    const payload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({
          items: [item0(), item1()],
          discounts: [
            {
              label: '割引 10%',
              amount: -38,
              adjacentPrecedingItemIndex: 0,
              kind: 'adjacent',
            },
            {
              label: '割引 10%',
              amount: -38,
              adjacentPrecedingItemIndex: 1,
              type: 'percent',
            },
          ],
        }),
        user_items_json: null,
      },
      persistedItemRows: [],
    });
    expect(payload.analysis.discounts).toHaveLength(2);
    expect(payload.analysis.discounts.map((d) => d.amount)).toEqual([-38, -38]);
    expect(
      payload.analysis.discounts.map((d) => d.adjacentPrecedingItemIndex)
    ).toEqual([0, 1]);
    expect(payload.analysis.discounts[0]?.kind).toBe('adjacent');
    expect(payload.analysis.discounts[1]?.type).toBe('percent');
  });

  it('C — analysis JSON with one -38 exports one', () => {
    const payload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({
          items: [item0(), item1()],
          discounts: [
            {
              label: '割引 10%',
              amount: -38,
              adjacentPrecedingItemIndex: 0,
            },
          ],
        }),
        user_items_json: null,
      },
      persistedItemRows: [],
    });
    expect(payload.analysis.discounts).toHaveLength(1);
    expect(payload.analysis.discounts[0]?.amount).toBe(-38);
  });

  it('D — analysis JSON with no discounts exports empty array', () => {
    const payload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({
          items: [item0(), item1()],
          discounts: [],
        }),
        user_items_json: null,
      },
      persistedItemRows: [],
    });
    expect(payload.analysis.discounts).toEqual([]);
  });

  it('E — user_items_json NULL is distinguished from []', () => {
    const nullClass = classifyUserItemsJsonRaw(null);
    expect(nullClass.rawKind).toBe('null');
    expect(nullClass.present).toBe(false);
    expect(nullClass.parseableArray).toBe(false);

    const emptyArrClass = classifyUserItemsJsonRaw('[]');
    expect(emptyArrClass.rawKind).toBe('array');
    expect(emptyArrClass.present).toBe(true);
    expect(emptyArrClass.parseableArray).toBe(true);
    expect(emptyArrClass.arrayLength).toBe(0);

    const nullPayload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({ items: [item0()] }),
        user_items_json: null,
      },
      persistedItemRows: [],
    });
    expect(nullPayload.receipt.userItemsJsonRawKind).toBe('null');
    expect(nullPayload.receipt.userItemsJsonPresent).toBe(false);
    expect(nullPayload.receipt.userItemsJsonParseableArray).toBe(false);

    const emptyPayload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({ items: [item0()] }),
        user_items_json: '[]',
      },
      persistedItemRows: [],
    });
    expect(emptyPayload.receipt.userItemsJsonRawKind).toBe('array');
    expect(emptyPayload.receipt.userItemsJsonPresent).toBe(true);
    expect(emptyPayload.receipt.userItemsJsonParseableArray).toBe(true);
    expect(emptyPayload.receipt.userItemsArrayLength).toBe(0);
    expect(emptyPayload.userItems.items).toEqual([]);
  });

  it('F — valid non-empty user_items array is reported accurately', () => {
    const payload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({ items: [item0(), item1()] }),
        user_items_json: JSON.stringify([
          {
            name: 'edited-0',
            quantity: 1,
            lineTotal: 372,
            amountUserEdited: true,
          },
          {
            name: 'edited-1',
            quantity: 1,
            lineTotal: 378,
            amountUserEdited: false,
          },
          { name: 'ignored-2', lineTotal: 1 },
        ]),
      },
      persistedItemRows: [],
    });
    expect(payload.receipt.userItemsJsonRawKind).toBe('array');
    expect(payload.receipt.userItemsJsonParseableArray).toBe(true);
    expect(payload.receipt.userItemsArrayLength).toBe(3);
    expect(payload.userItems.parseableArray).toBe(true);
    expect(payload.userItems.items).toHaveLength(2);
    expect(payload.userItems.items[0]?.name).toBe('edited-0');
    expect(payload.userItems.items[0]?.amountUserEdited).toBe(true);
    expect(payload.userItems.items[0]?.lineTotal).toBe(372);
    expect(payload.userItems.items[1]?.name).toBe('edited-1');
  });

  it('G — malformed user_items_json fails closed in export metadata', () => {
    const empty = classifyUserItemsJsonRaw('   ');
    expect(empty.rawKind).toBe('empty');
    expect(empty.parseableArray).toBe(false);

    const malformed = classifyUserItemsJsonRaw('{not-json');
    expect(malformed.rawKind).toBe('malformed');
    expect(malformed.parseableArray).toBe(false);

    const nonArray = classifyUserItemsJsonRaw('{"a":1}');
    expect(nonArray.rawKind).toBe('non_array');
    expect(nonArray.parseableArray).toBe(false);

    const payload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({ items: [item0()] }),
        user_items_json: '{broken',
      },
      persistedItemRows: [],
    });
    expect(payload.receipt.userItemsJsonRawKind).toBe('malformed');
    expect(payload.receipt.userItemsJsonParseableArray).toBe(false);
    expect(payload.userItems.items).toEqual([]);
  });

  it('H — persisted receipt_items are raw DB values (no monetary recovery)', () => {
    const exportSource = fs.readFileSync(
      path.join(__dirname, 'targetReceiptEvidenceExport.ts'),
      'utf8'
    );
    expect(exportSource).not.toContain('resolveCurrentAnalysisItemMonetaryTruth');
    expect(exportSource).not.toContain('enrichProductRowsWithCurrentItemMonetaryTruth');
    expect(exportSource).not.toContain('buildPriceObservationTruth');
    expect(exportSource).not.toContain('ProductPriceHistory');

    // Stale stored row that recovery would normally rewrite — export must keep raw.
    const payload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({
          items: [
            item0({ discountAllocated: 0, effectiveLineTotal: 378 }),
            item1(),
          ],
          discounts: [
            {
              label: '割引 10%',
              amount: -38,
              adjacentPrecedingItemIndex: 0,
            },
            {
              label: '割引 10%',
              amount: -38,
              adjacentPrecedingItemIndex: 1,
            },
          ],
        }),
        user_items_json: null,
      },
      persistedItemRows: [
        {
          source_index: 0,
          raw_name: '鶏肉',
          purchase_quantity: 1,
          gross_line_amount: null,
          effective_line_amount: 372,
          discount_allocated: null,
          amount_provenance: 'user_corrected',
          item_amount_evidence_state: 'selected_only',
          price_observation_version: 1,
        },
        {
          source_index: 1,
          raw_name: '鶏肉',
          purchase_quantity: 1,
          gross_line_amount: 378,
          effective_line_amount: 378,
          discount_allocated: 0,
          amount_provenance: 'ocr',
          item_amount_evidence_state: 'coherent',
          price_observation_version: 1,
        },
      ],
    });

    expect(payload.persistedReceiptItems[0]).toMatchObject({
      sourceIndex: 0,
      grossLineAmount: null,
      effectiveLineAmount: 372,
      discountAllocated: null,
      amountProvenance: 'user_corrected',
      itemAmountEvidenceState: 'selected_only',
    });
    // Must NOT look like recovered 378/-38/340.
    expect(payload.persistedReceiptItems[0]?.discountAllocated).not.toBe(-38);
    expect(payload.persistedReceiptItems[0]?.grossLineAmount).toBeNull();
  });

  it('I — only sourceIndex 0/1 are exported for analysis, userItems, and receipt_items', () => {
    const payload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({
          items: [item0(), item1(), { name: 'idx2', lineTotal: 10 }],
        }),
        user_items_json: JSON.stringify([
          item0({ name: 'u0' }),
          item1({ name: 'u1' }),
          { name: 'u2', lineTotal: 1 },
        ]),
      },
      persistedItemRows: [
        {
          source_index: 0,
          raw_name: 'a',
          purchase_quantity: 1,
          gross_line_amount: 1,
          effective_line_amount: 1,
          discount_allocated: 0,
          amount_provenance: 'ocr',
          item_amount_evidence_state: 'coherent',
          price_observation_version: 1,
        },
        {
          source_index: 1,
          raw_name: 'b',
          purchase_quantity: 1,
          gross_line_amount: 2,
          effective_line_amount: 2,
          discount_allocated: 0,
          amount_provenance: 'ocr',
          item_amount_evidence_state: 'coherent',
          price_observation_version: 1,
        },
        {
          source_index: 2,
          raw_name: 'c',
          purchase_quantity: 1,
          gross_line_amount: 3,
          effective_line_amount: 3,
          discount_allocated: 0,
          amount_provenance: 'ocr',
          item_amount_evidence_state: 'coherent',
          price_observation_version: 1,
        },
      ],
    });
    expect(payload.analysis.items.map((i) => i.sourceIndex)).toEqual([0, 1]);
    expect(payload.userItems.items.map((i) => i.sourceIndex)).toEqual([0, 1]);
    expect(payload.persistedReceiptItems.map((i) => i.sourceIndex)).toEqual([
      0, 1,
    ]);
    expect(TARGET_RECEIPT_ITEMS_SELECT_SQL).toMatch(/source_index IN \(0, 1\)/);
  });

  it('J — no forbidden broad raw fields appear in serialized JSON', () => {
    const payload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({ items: [item0()] }),
        user_items_json: null,
      },
      persistedItemRows: [],
    });
    const json = JSON.stringify(payload);
    for (const needle of TARGET_RECEIPT_EVIDENCE_FORBIDDEN_JSON_SUBSTRINGS) {
      expect(json.includes(needle)).toBe(false);
    }
    expect(json).not.toContain('image_uri');
    expect(json).not.toContain('recognition_snapshot_json');
    expect(json).not.toMatch(/"receipts"\s*:\s*\[/);
    assertTargetReceiptEvidenceJsonSafe(payload);
  });

  it('K — export is observational / SELECT-only and uses initialized DB helper', async () => {
    expect(TARGET_RECEIPT_SELECT_SQL).toMatch(/^SELECT\b/i);
    expect(TARGET_RECEIPT_SELECT_SQL).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i
    );
    expect(TARGET_RECEIPT_ITEMS_SELECT_SQL).toMatch(/^SELECT\b/i);
    expect(TARGET_RECEIPT_ITEMS_SELECT_SQL).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i
    );

    const exportSource = fs.readFileSync(
      path.join(__dirname, 'targetReceiptEvidenceExport.ts'),
      'utf8'
    );
    expect(exportSource).toContain('getInitializedReceiptsDatabaseOrThrow');
    expect(exportSource).not.toContain('initIfNeeded');

    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const db: TargetReceiptEvidenceDatabase = {
      async getFirstAsync<T>(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        return {
          id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
          analysis_json: analysisJson({ items: [item0()], discounts: [] }),
          user_items_json: null,
        } as T;
      },
      async getAllAsync<T>(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        return [] as T[];
      },
    };

    const payload = await loadTargetReceiptEvidenceWithDb(db, {
      nowMs: NOW,
      app: { version: '1.0.0', build: '110' },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toBe(TARGET_RECEIPT_SELECT_SQL);
    expect(calls[0]?.params).toEqual([TARGET_RECEIPT_EVIDENCE_RECEIPT_ID]);
    expect(calls[1]?.sql).toBe(TARGET_RECEIPT_ITEMS_SELECT_SQL);
    expect(calls[1]?.params).toEqual([TARGET_RECEIPT_EVIDENCE_RECEIPT_ID]);
    expect(payload.receipt.found).toBe(true);
    expect(payload.analysis.reconciliation).toMatchObject({
      ok: true,
      itemsPositiveSum: 760,
      discountsSum: -76,
      diff: 0,
    });
  });

  it('L — existing all-receipts DB export remains __DEV__-only', () => {
    expect(() => assertReceiptsDbExportAllowed(false)).toThrow(
      /development builds/i
    );
    expect(() => assertReceiptsDbExportAllowed(true)).not.toThrow();

    const settingsSource = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/settings/index.tsx'),
      'utf8'
    );
    expect(settingsSource).toMatch(
      /\{__DEV__\s*\?[\s\S]*Export receipts DB \(JSON\)/
    );
    expect(settingsSource).toContain('Export Target Receipt Evidence');
    expect(settingsSource).toContain('exportAndShareTargetReceiptEvidence');
    // Target evidence lives under Internal / Validation gating, not __DEV__.
    expect(settingsSource).toContain('showTargetReceiptEvidence');
    expect(settingsSource).toMatch(
      /showAnalysisDDiagnostics \|\| showExperimentSnapshot/
    );
    // Must not weaken the broad exporter into the Internal section as a substitute.
    const internalBlock = settingsSource.split('Internal / Validation')[1] ?? '';
    const beforeDevTools = internalBlock.split('Developer Tools')[0] ?? '';
    expect(beforeDevTools).toContain('Export Target Receipt Evidence');
    expect(beforeDevTools).not.toContain('Export receipts DB (JSON)');
  });

  it('missing receipt fails closed with found=false', () => {
    const payload = buildTargetReceiptEvidenceExport({
      nowMs: NOW,
      receipt: null,
      persistedItemRows: [],
    });
    expect(payload.receipt.found).toBe(false);
    expect(payload.analysis.items).toEqual([]);
    expect(payload.analysis.discounts).toEqual([]);
    expect(payload.persistedReceiptItems).toEqual([]);
  });

  describe('A1 — reconciliation allowlist privacy', () => {
    it('CASE A — known scalar reconciliation fields are retained correctly', () => {
      const payload = buildTargetReceiptEvidenceExport({
        nowMs: NOW,
        receipt: {
          id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
          analysis_json: analysisJson({
            items: [item0()],
            reconciliation: {
              ok: false,
              itemsPositiveSum: 760,
              discountsSum: -38,
              tax: 10,
              total: 732,
              expectedTotal: 732,
              diff: 0,
            },
          }),
          user_items_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.analysis.reconciliation).toEqual({
        ok: false,
        itemsPositiveSum: 760,
        discountsSum: -38,
        tax: 10,
        total: 732,
        expectedTotal: 732,
        diff: 0,
      });
      expect(Object.keys(payload.analysis.reconciliation!).sort()).toEqual(
        [
          'diff',
          'discountsSum',
          'expectedTotal',
          'itemsPositiveSum',
          'ok',
          'tax',
          'total',
        ].sort()
      );
    });

    it('CASE B — warnings nested payloads are omitted; scalars kept', () => {
      const payload = buildTargetReceiptEvidenceExport({
        nowMs: NOW,
        receipt: {
          id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
          analysis_json: analysisJson({
            items: [item0()],
            reconciliation: {
              ok: true,
              diff: 0,
              warnings: [
                {
                  ocrText: 'PRIVATE',
                  secretNested: { x: 1 },
                },
              ],
            },
          }),
          user_items_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.analysis.reconciliation).toEqual({
        ok: true,
        diff: 0,
      });
      expect(payload.analysis.reconciliation).not.toHaveProperty('warnings');
      const json = JSON.stringify(payload);
      expect(json).not.toContain('warnings');
      expect(json).not.toContain('ocrText');
      expect(json).not.toContain('secretNested');
      expect(json).not.toContain('PRIVATE');
    });

    it('CASE C — warnings-only reconciliation exports null', () => {
      const payload = buildTargetReceiptEvidenceExport({
        nowMs: NOW,
        receipt: {
          id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
          analysis_json: analysisJson({
            items: [item0()],
            reconciliation: {
              warnings: [
                {
                  ocrText: 'PRIVATE',
                  secretNested: { x: 1 },
                },
              ],
            },
          }),
          user_items_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.analysis.reconciliation).toBeNull();
      const json = JSON.stringify(payload);
      expect(json).not.toContain('warnings');
      expect(json).not.toContain('ocrText');
      expect(json).not.toContain('secretNested');
      expect(json).not.toContain('PRIVATE');
    });

    it('CASE D — serialized JSON must not contain warnings/ocrText/secretNested', () => {
      const payload = buildTargetReceiptEvidenceExport({
        nowMs: NOW,
        receipt: {
          id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
          analysis_json: analysisJson({
            items: [item0()],
            reconciliation: {
              ok: true,
              total: 100,
              warnings: [{ ocrText: 'PRIVATE', secretNested: { z: 1 } }],
              unexpectedBlob: 'x',
              ocrText: 'y',
              secretNested: { z: 1 },
            },
          }),
          user_items_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.analysis.reconciliation).toEqual({
        ok: true,
        total: 100,
      });
      const json = JSON.stringify(payload);
      expect(json).not.toContain('warnings');
      expect(json).not.toContain('ocrText');
      expect(json).not.toContain('secretNested');
      expect(json).not.toContain('unexpectedBlob');
      expect(json).not.toContain('PRIVATE');
    });

    it('unknown-only reconciliation still exports null; secrets absent', () => {
      const payload = buildTargetReceiptEvidenceExport({
        nowMs: NOW,
        receipt: {
          id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
          analysis_json: analysisJson({
            items: [item0()],
            reconciliation: {
              unexpectedBlob: 'LEAK-BLOB',
              ocrText: 'LEAK-OCR',
              secretNested: { token: 'LEAK-TOKEN' },
            },
          }),
          user_items_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.analysis.reconciliation).toBeNull();
      const json = JSON.stringify(payload);
      expect(json).not.toContain('unexpectedBlob');
      expect(json).not.toContain('ocrText');
      expect(json).not.toContain('secretNested');
      expect(json).not.toContain('LEAK-BLOB');
      expect(json).not.toContain('LEAK-OCR');
      expect(json).not.toContain('LEAK-TOKEN');
    });

    it('mixed known+unknown keeps known and omits unknown', () => {
      const payload = buildTargetReceiptEvidenceExport({
        nowMs: NOW,
        receipt: {
          id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
          analysis_json: analysisJson({
            items: [item0()],
            reconciliation: {
              ok: true,
              diff: 38,
              unexpectedBlob: 'LEAK-BLOB',
              ocrText: 'LEAK-OCR',
              secretNested: { a: 1 },
            },
          }),
          user_items_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.analysis.reconciliation).toEqual({
        ok: true,
        diff: 38,
      });
      const json = JSON.stringify(payload);
      expect(json).not.toContain('unexpectedBlob');
      expect(json).not.toContain('ocrText');
      expect(json).not.toContain('secretNested');
    });

    it('missing reconciliation exports null', () => {
      const payload = buildTargetReceiptEvidenceExport({
        nowMs: NOW,
        receipt: {
          id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
          analysis_json: JSON.stringify({
            items: [item0()],
            discounts: [],
          }),
          user_items_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.analysis.reconciliation).toBeNull();
    });

    it('source has no warnings allowlist and no unrestricted reconciliation spread', () => {
      const source = fs.readFileSync(
        path.join(__dirname, 'targetReceiptEvidenceExport.ts'),
        'utf8'
      );
      expect(source).not.toContain('{ ...src }');
      expect(source).not.toMatch(
        /const keys = \[[^\]]*['"]warnings['"][^\]]*\]/s
      );
      expect(source).not.toMatch(/picked\[['\"]warnings['\"]\]/);
    });
  });
});
