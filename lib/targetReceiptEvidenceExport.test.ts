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
import * as TargetReceiptEvidenceExport from './targetReceiptEvidenceExport';
import {
  TARGET_RECEIPT_EVIDENCE_FORBIDDEN_JSON_SUBSTRINGS,
  TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
  TARGET_RECEIPT_ITEMS_SELECT_SQL,
  TARGET_RECEIPT_SELECT_SQL,
  assertTargetReceiptEvidenceJsonSafe,
  buildTargetReceiptEvidenceExport,
  buildTargetReceiptEvidenceFromLocalDb,
  buildTargetReceiptItemsSelectSqlForTarget,
  buildTargetReceiptSelectSql,
  classifyUserItemsJsonRaw,
  loadTargetReceiptEvidenceWithDb,
  resolveTargetReceiptEvidenceSpec,
  UnknownTargetReceiptEvidenceTargetKeyError,
  type TargetReceiptEvidenceDatabase,
} from './targetReceiptEvidenceExport';

const NOW = Date.parse('2026-09-07T03:00:00.000Z');
const AUQ = resolveTargetReceiptEvidenceSpec('auq_poultry');
const R063 = resolveTargetReceiptEvidenceSpec(
  'receipt063_seiyu_inline_markdown'
);

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

function padItems(toIndex: number, extras: Record<number, unknown>) {
  const items: unknown[] = [];
  for (let i = 0; i <= toIndex; i += 1) {
    items.push(
      extras[i] ?? {
        name: `pad-${i}`,
        quantity: 1,
        lineTotal: 100 + i,
        discountAllocated: 0,
        effectiveLineTotal: 100 + i,
      }
    );
  }
  return items;
}

describe('targetReceiptEvidenceExport', () => {
  it('A — target receipt row is projected narrowly (no full analysis dump)', () => {
    const ocrBlob = 'FULL OCR TEXT MUST NOT APPEAR '.repeat(20);
    const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
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
        recognition_snapshot_json: null,
      },
      persistedItemRows: [],
    });

    expect(payload.targetReceiptId).toBe(TARGET_RECEIPT_EVIDENCE_RECEIPT_ID);
    expect(payload.targetKey).toBe('auq_poultry');
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
    const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
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
        recognition_snapshot_json: null,
      },
      persistedItemRows: [],
    });
    expect(payload.analysis.discounts).toHaveLength(2);
    expect(payload.analysis.discounts.map((d) => d.amount)).toEqual([-38, -38]);
  });

  it('C — analysis JSON with one -38 exports one', () => {
    const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
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
        recognition_snapshot_json: null,
      },
      persistedItemRows: [],
    });
    expect(payload.analysis.discounts).toHaveLength(1);
  });

  it('D — analysis JSON with no discounts exports empty array', () => {
    const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({
          items: [item0(), item1()],
          discounts: [],
        }),
        user_items_json: null,
        recognition_snapshot_json: null,
      },
      persistedItemRows: [],
    });
    expect(payload.analysis.discounts).toEqual([]);
  });

  it('E — user_items_json NULL is distinguished from []', () => {
    const nullPayload = buildTargetReceiptEvidenceExport('auq_poultry', {
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({ items: [item0()] }),
        user_items_json: null,
        recognition_snapshot_json: null,
      },
      persistedItemRows: [],
    });
    expect(nullPayload.receipt.userItemsJsonRawKind).toBe('null');

    const emptyPayload = buildTargetReceiptEvidenceExport('auq_poultry', {
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({ items: [item0()] }),
        user_items_json: '[]',
        recognition_snapshot_json: null,
      },
      persistedItemRows: [],
    });
    expect(emptyPayload.receipt.userItemsJsonRawKind).toBe('array');
    expect(emptyPayload.receipt.userItemsArrayLength).toBe(0);
  });

  it('F — valid non-empty user_items array is reported accurately', () => {
    const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
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
        recognition_snapshot_json: null,
      },
      persistedItemRows: [],
    });
    expect(payload.userItems.items).toHaveLength(2);
    expect(payload.userItems.items[0]?.name).toBe('edited-0');
    expect(payload.userItems.items[0]?.amountUserEdited).toBe(true);
  });

  it('G — malformed user_items_json fails closed in export metadata', () => {
    expect(classifyUserItemsJsonRaw('{broken').rawKind).toBe('malformed');
    expect(classifyUserItemsJsonRaw('{"a":1}').rawKind).toBe('non_array');
    expect(classifyUserItemsJsonRaw('   ').rawKind).toBe('empty');
  });

  it('H — persisted receipt_items are raw DB values (no monetary recovery)', () => {
    const exportSource = fs.readFileSync(
      path.join(__dirname, 'targetReceiptEvidenceExport.ts'),
      'utf8'
    );
    expect(exportSource).not.toContain('resolveCurrentAnalysisItemMonetaryTruth');
    expect(exportSource).not.toContain('enrichProductRowsWithCurrentItemMonetaryTruth');
    expect(exportSource).not.toContain('buildPriceObservationTruth');

    const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({ items: [item0(), item1()] }),
        user_items_json: null,
        recognition_snapshot_json: null,
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
    expect(payload.persistedReceiptItems[0]?.discountAllocated).toBeNull();
    expect(payload.persistedReceiptItems[0]?.grossLineAmount).toBeNull();
  });

  it('I — only configured sourceIndices are exported', () => {
    expect(TARGET_RECEIPT_ITEMS_SELECT_SQL).toMatch(/source_index IN \(\?, \?\)/);
    expect(AUQ.sourceIndices).toEqual([0, 1]);
  });

  it('J — no forbidden broad raw fields appear in serialized JSON', () => {
    const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
      nowMs: NOW,
      receipt: {
        id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
        analysis_json: analysisJson({ items: [item0()] }),
        user_items_json: null,
        recognition_snapshot_json: null,
      },
      persistedItemRows: [],
    });
    const json = JSON.stringify(payload);
    for (const needle of TARGET_RECEIPT_EVIDENCE_FORBIDDEN_JSON_SUBSTRINGS) {
      expect(json.includes(needle)).toBe(false);
    }
    assertTargetReceiptEvidenceJsonSafe(payload);
  });

  it('K — export is observational / SELECT-only and uses initialized DB helper', async () => {
    expect(TARGET_RECEIPT_SELECT_SQL).toMatch(/^SELECT\b/i);
    expect(TARGET_RECEIPT_SELECT_SQL).toMatch(/recognition_snapshot_json/);
    expect(TARGET_RECEIPT_SELECT_SQL).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i
    );
    expect(TARGET_RECEIPT_ITEMS_SELECT_SQL).toMatch(/^SELECT\b/i);

    const exportSource = fs.readFileSync(
      path.join(__dirname, 'targetReceiptEvidenceExport.ts'),
      'utf8'
    );
    expect(exportSource).toContain('getInitializedReceiptsDatabaseOrThrow');
    expect(exportSource).not.toContain('initIfNeeded');

    const calls: Array<{ sql: string; params?: unknown }> = [];
    const db: TargetReceiptEvidenceDatabase = {
      async getFirstAsync<T>(sql: string, params?: unknown) {
        calls.push({ sql, params });
        return {
          id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
          analysis_json: analysisJson({ items: [item0()], discounts: [] }),
          user_items_json: null,
          recognition_snapshot_json: null,
        } as T;
      },
      async getAllAsync<T>(sql: string, params?: unknown) {
        calls.push({ sql, params });
        return [] as T[];
      },
    };

    const payload = await loadTargetReceiptEvidenceWithDb(db, {
      nowMs: NOW,
      app: { version: '1.0.0', build: '110' },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params).toEqual([AUQ.receiptId]);
    expect(calls[1]?.params).toEqual([AUQ.receiptId, 0, 1]);
    expect(payload.receipt.found).toBe(true);
  });

  it('L — existing all-receipts DB export remains __DEV__-only', () => {
    expect(() => assertReceiptsDbExportAllowed(false)).toThrow(
      /development builds/i
    );
    const settingsSource = fs.readFileSync(
      path.join(__dirname, '../app/(tabs)/settings/index.tsx'),
      'utf8'
    );
    expect(settingsSource).toMatch(
      /\{__DEV__\s*\?[\s\S]*Export receipts DB \(JSON\)/
    );
    expect(settingsSource).toContain('Export Target Receipt Evidence');
    expect(settingsSource).toContain('Export Receipt063 Evidence');
    const internalBlock = settingsSource.split('Internal / Validation')[1] ?? '';
    const beforeDevTools = internalBlock.split('Developer Tools')[0] ?? '';
    expect(beforeDevTools).toContain('Export Receipt063 Evidence');
    expect(beforeDevTools).not.toContain('Export receipts DB (JSON)');
  });

  it('M — uninitialized DB fails without init/migration/backfill', async () => {
    await expect(
      buildTargetReceiptEvidenceFromLocalDb({
        requireInitializedDb: () => {
          throw new Error('Receipts database is not initialized');
        },
      })
    ).rejects.toThrow(/not initialized/i);
  });

  it('missing receipt fails closed with found=false', () => {
    const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
      nowMs: NOW,
      receipt: null,
      persistedItemRows: [],
    });
    expect(payload.receipt.found).toBe(false);
    expect(payload.analysis.items).toEqual([]);
    expect(payload.recognition.present).toBe(false);
  });

  describe('Receipt063 SEIYU evidence target', () => {
    it('CASE A — Receipt063 target queries exact receipt id and indexes 8/9', async () => {
      expect(R063.receiptId).toBe('xQCDD8d8OAAewZdYpTs4p');
      expect(R063.sourceIndices).toEqual([8, 9]);
      const itemsSql = buildTargetReceiptItemsSelectSqlForTarget('receipt063_seiyu_inline_markdown');
      expect(itemsSql).toMatch(/source_index IN \(\?, \?\)/);
      expect(itemsSql).toMatch(/^SELECT\b/i);
      expect(buildTargetReceiptSelectSql()).toMatch(/recognition_snapshot_json/);

      const calls: Array<{ sql: string; params?: unknown }> = [];
      const db: TargetReceiptEvidenceDatabase = {
        async getFirstAsync<T>(sql: string, params?: unknown) {
          calls.push({ sql, params });
          return null;
        },
        async getAllAsync<T>(sql: string, params?: unknown) {
          calls.push({ sql, params });
          return [] as T[];
        },
      };
      await loadTargetReceiptEvidenceWithDb(db, {
        targetKey: 'receipt063_seiyu_inline_markdown',
        nowMs: NOW,
      });
      expect(calls[0]?.params).toEqual([R063.receiptId]);
      expect(calls[1]?.params).toEqual([R063.receiptId, 8, 9]);
    });

    it('CASE B — analysis target items 8/9 projected narrowly', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt063_seiyu_inline_markdown', {
        nowMs: NOW,
        receipt: {
          id: R063.receiptId,
          analysis_json: analysisJson({
            items: padItems(9, {
              8: {
                name: 'ブタカタブロック 値下（元 ¥651）',
                quantity: 1,
                lineTotal: 553,
                discountAllocated: 0,
                effectiveLineTotal: 553,
              },
              9: {
                name: 'ギュウカタキリオトシ',
                quantity: 1,
                lineTotal: 586,
                discountAllocated: 0,
                effectiveLineTotal: 586,
              },
            }),
            discounts: [],
          }),
          user_items_json: null,
          recognition_snapshot_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.sourceIndices).toEqual([8, 9]);
      expect(payload.analysis.items.map((i) => i.sourceIndex)).toEqual([8, 9]);
      expect(payload.analysis.items[0]?.lineTotal).toBe(553);
      expect(payload.analysis.items[0]?.name).toContain('651');
      expect(payload.analysis.items.some((i) => i.sourceIndex === 0)).toBe(false);
    });

    it('CASE C — all structured discounts preserved through bounded projection', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt063_seiyu_inline_markdown', {
        nowMs: NOW,
        receipt: {
          id: R063.receiptId,
          analysis_json: analysisJson({
            items: padItems(9, {}),
            discounts: [
              { label: '値引', amount: -50, adjacentPrecedingItemIndex: 3 },
              {
                label: '割引 10%',
                amount: -38,
                adjacentPrecedingItemIndex: 8,
                kind: 'adjacent',
              },
            ],
          }),
          user_items_json: null,
          recognition_snapshot_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.analysis.discounts).toHaveLength(2);
      expect(payload.analysis.discounts[1]?.adjacentPrecedingItemIndex).toBe(8);
    });

    it('CASE D — user_items null / malformed / non_array / array states preserved', () => {
      expect(classifyUserItemsJsonRaw(null).rawKind).toBe('null');
      expect(classifyUserItemsJsonRaw('').rawKind).toBe('empty');
      expect(classifyUserItemsJsonRaw('{x').rawKind).toBe('malformed');
      expect(classifyUserItemsJsonRaw('{"a":1}').rawKind).toBe('non_array');
      expect(classifyUserItemsJsonRaw('[]').rawKind).toBe('array');
    });

    it('CASE E — target user item projection is bounded to indexes 8/9', () => {
      const userItems = padItems(10, {
        8: {
          name: 'user-8',
          lineTotal: 651,
          amountUserEdited: true,
          discountAllocated: -98,
        },
        9: {
          name: 'user-9',
          lineTotal: 690,
          amountUserEdited: false,
        },
      });
      const payload = buildTargetReceiptEvidenceExport('receipt063_seiyu_inline_markdown', {
        nowMs: NOW,
        receipt: {
          id: R063.receiptId,
          analysis_json: analysisJson({ items: padItems(9, {}) }),
          user_items_json: JSON.stringify(userItems),
          recognition_snapshot_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.userItems.rawKind).toBe('array');
      expect(payload.userItems.items).toHaveLength(2);
      expect(payload.userItems.items.map((i) => i.sourceIndex)).toEqual([8, 9]);
      expect(payload.userItems.items[0]?.lineTotal).toBe(651);
      expect(payload.userItems.items[0]?.amountUserEdited).toBe(true);
      expect(payload.userItems.items.some((i) => i.name === 'pad-0')).toBe(false);
    });

    it('CASE F — recognition snapshot target evidence projected narrowly', () => {
      const snap = {
        merchant: 'SEIYU',
        items: padItems(9, {
          8: {
            name: 'ブタカタブロック',
            quantity: 1,
            lineTotal: 553,
            kind: 'item',
          },
          9: {
            name: 'ギュウカタキリオトシ',
            quantity: 1,
            lineTotal: 586,
            kind: 'item',
          },
        }),
        discounts: [{ label: '値引', amount: -10 }],
        reconciliation: { ok: false, diff: 1, unexpectedBlob: 'NO' },
        ocr_raw_text: '値下（元 ¥651） SECRET OCR BLOB',
      };
      const payload = buildTargetReceiptEvidenceExport('receipt063_seiyu_inline_markdown', {
        nowMs: NOW,
        receipt: {
          id: R063.receiptId,
          analysis_json: analysisJson({ items: padItems(9, {}) }),
          user_items_json: null,
          recognition_snapshot_json: JSON.stringify(snap),
        },
        persistedItemRows: [],
      });
      expect(payload.recognition.present).toBe(true);
      expect(payload.recognition.parseable).toBe(true);
      expect(payload.recognition.itemCount).toBe(10);
      expect(payload.recognition.items.map((i) => i.sourceIndex)).toEqual([8, 9]);
      expect(payload.recognition.items[0]?.lineTotal).toBe(553);
      expect(payload.recognition.items[0]?.kind).toBe('item');
      expect(payload.recognition.discounts).toHaveLength(1);
      expect(payload.recognition.reconciliation).toEqual({ ok: false, diff: 1 });
      expect(payload.recognition.unboundedTextFieldsOmitted).toBe(true);
    });

    it('CASE G — unknown nested recognition fields cannot leak', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt063_seiyu_inline_markdown', {
        nowMs: NOW,
        receipt: {
          id: R063.receiptId,
          analysis_json: analysisJson({ items: padItems(9, {}) }),
          user_items_json: null,
          recognition_snapshot_json: JSON.stringify({
            items: padItems(9, {
              8: {
                name: 'ok',
                lineTotal: 553,
                secretNested: { token: 'LEAK' },
                unexpectedBlob: 'NOPE',
              },
            }),
            secretTop: { a: 1 },
            reconciliation: {
              ok: true,
              unexpectedBlob: 'NO',
              warnings: [{ ocrText: 'PRIVATE' }],
            },
          }),
        },
        persistedItemRows: [],
      });
      const json = JSON.stringify(payload);
      expect(json).not.toContain('secretNested');
      expect(json).not.toContain('unexpectedBlob');
      expect(json).not.toContain('LEAK');
      expect(json).not.toContain('secretTop');
      expect(json).not.toContain('warnings');
      expect(json).not.toContain('PRIVATE');
      expect(payload.recognition.reconciliation).toEqual({ ok: true });
    });

    it('CASE H — full OCR/raw recognition blob cannot leak', () => {
      const blob = '値下（元 ¥651） FULL OCR '.repeat(30);
      const payload = buildTargetReceiptEvidenceExport('receipt063_seiyu_inline_markdown', {
        nowMs: NOW,
        receipt: {
          id: R063.receiptId,
          analysis_json: analysisJson({ items: padItems(9, {}) }),
          user_items_json: null,
          recognition_snapshot_json: JSON.stringify({
            items: padItems(9, { 8: { name: 'ブタカタブロック', lineTotal: 553 } }),
            ocr_raw_text: blob,
            rawText: blob,
            fullText: blob,
          }),
        },
        persistedItemRows: [],
      });
      const json = JSON.stringify(payload);
      expect(json).not.toContain(blob.slice(0, 20));
      expect(json).not.toContain('ocr_raw_text');
      expect(json).not.toContain('recognition_snapshot_json');
      expect(payload.recognition.unboundedTextFieldsOmitted).toBe(true);
      assertTargetReceiptEvidenceJsonSafe(payload);
    });

    it('CASE I — image_uri cannot leak', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt063_seiyu_inline_markdown', {
        nowMs: NOW,
        receipt: {
          id: R063.receiptId,
          analysis_json: analysisJson({ items: padItems(9, {}) }),
          user_items_json: null,
          recognition_snapshot_json: JSON.stringify({
            items: padItems(9, {}),
            image_uri: 'file:///secret.jpg',
            imageUri: 'file:///secret2.jpg',
          }),
        },
        persistedItemRows: [],
      });
      const json = JSON.stringify(payload);
      expect(json).not.toContain('image_uri');
      expect(json).not.toContain('secret.jpg');
      expect(payload.recognition.imageEvidenceOmitted).toBe(true);
      assertTargetReceiptEvidenceJsonSafe(payload);
    });

    it('CASE J — receipt_items are raw SELECT projections and not enriched', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt063_seiyu_inline_markdown', {
        nowMs: NOW,
        receipt: {
          id: R063.receiptId,
          analysis_json: analysisJson({
            items: padItems(9, {
              8: { name: 'x', lineTotal: 651, discountAllocated: -98 },
            }),
          }),
          user_items_json: null,
          recognition_snapshot_json: null,
        },
        persistedItemRows: [
          {
            source_index: 8,
            raw_name: 'ブタカタブロック',
            purchase_quantity: 1,
            gross_line_amount: 553,
            effective_line_amount: 553,
            discount_allocated: 0,
            amount_provenance: 'ocr_observed',
            item_amount_evidence_state: 'coherent',
            price_observation_version: 1,
          },
          {
            source_index: 9,
            raw_name: 'ギュウカタキリオトシ',
            purchase_quantity: 1,
            gross_line_amount: 586,
            effective_line_amount: 586,
            discount_allocated: 0,
            amount_provenance: 'ocr_observed',
            item_amount_evidence_state: 'coherent',
            price_observation_version: 1,
          },
          {
            source_index: 0,
            raw_name: 'ignored',
            purchase_quantity: 1,
            gross_line_amount: 1,
            effective_line_amount: 1,
            discount_allocated: 0,
            amount_provenance: 'ocr',
            item_amount_evidence_state: 'coherent',
            price_observation_version: 1,
          },
        ],
      });
      expect(payload.persistedReceiptItems.map((i) => i.sourceIndex)).toEqual([
        8, 9,
      ]);
      expect(payload.persistedReceiptItems[0]).toMatchObject({
        grossLineAmount: 553,
        effectiveLineAmount: 553,
        discountAllocated: 0,
      });
      // Must not invent 651/-98 from analysis.
      expect(payload.persistedReceiptItems[0]?.grossLineAmount).not.toBe(651);
    });

    it('CASE K — existing auq target behavior remains intact', () => {
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: {
          id: AUQ.receiptId,
          analysis_json: analysisJson({
            items: [item0(), item1()],
            discounts: [
              { label: '割引 10%', amount: -38, adjacentPrecedingItemIndex: 0 },
              { label: '割引 10%', amount: -38, adjacentPrecedingItemIndex: 1 },
            ],
          }),
          user_items_json: null,
          recognition_snapshot_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.targetKey).toBe('auq_poultry');
      expect(payload.targetReceiptId).toBe(AUQ.receiptId);
      expect(payload.sourceIndices).toEqual([0, 1]);
      expect(payload.analysis.discounts).toHaveLength(2);
    });

    it('CASE L — all SQLite statements remain SELECT-only', () => {
      for (const sql of [
        buildTargetReceiptSelectSql(),
        buildTargetReceiptItemsSelectSqlForTarget('auq_poultry'),
        buildTargetReceiptItemsSelectSqlForTarget('receipt063_seiyu_inline_markdown'),
      ]) {
        expect(sql).toMatch(/^SELECT\b/i);
        expect(sql).not.toMatch(
          /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i
        );
      }
    });
  });

  describe('A1 — static target key boundary / mutable-registry authority', () => {
    it('CASE A — authoritative registry is NOT exported', () => {
      const source = fs.readFileSync(
        path.join(__dirname, 'targetReceiptEvidenceExport.ts'),
        'utf8'
      );
      expect(source).toMatch(/\bconst TARGET_RECEIPT_EVIDENCE_SPECS = \{/);
      expect(source).not.toMatch(
        /export const TARGET_RECEIPT_EVIDENCE_SPECS\b/
      );
      expect(source).not.toMatch(
        /export \{[^}]*TARGET_RECEIPT_EVIDENCE_SPECS/
      );
      expect(TargetReceiptEvidenceExport).not.toHaveProperty(
        'TARGET_RECEIPT_EVIDENCE_SPECS'
      );
    });

    it('CASE B — auq key resolves exact receiptId and indexes [0,1]', () => {
      const spec = resolveTargetReceiptEvidenceSpec('auq_poultry');
      expect(spec.receiptId).toBe('auq8r7qU-EN_l38Y2xDea');
      expect(spec.sourceIndices).toEqual([0, 1]);
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: {
          id: AUQ.receiptId,
          analysis_json: analysisJson({ items: [item0(), item1()] }),
          user_items_json: null,
          recognition_snapshot_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.targetReceiptId).toBe('auq8r7qU-EN_l38Y2xDea');
      expect(payload.sourceIndices).toEqual([0, 1]);
    });

    it('CASE C — Receipt063 key resolves exact receiptId and indexes [8,9]', () => {
      const spec = resolveTargetReceiptEvidenceSpec(
        'receipt063_seiyu_inline_markdown'
      );
      expect(spec.receiptId).toBe('xQCDD8d8OAAewZdYpTs4p');
      expect(spec.sourceIndices).toEqual([8, 9]);
      const payload = buildTargetReceiptEvidenceExport(
        'receipt063_seiyu_inline_markdown',
        {
          nowMs: NOW,
          receipt: null,
          persistedItemRows: [],
        }
      );
      expect(payload.targetReceiptId).toBe('xQCDD8d8OAAewZdYpTs4p');
      expect(payload.sourceIndices).toEqual([8, 9]);
    });

    it('CASE D — mutating resolver result cannot alter later authority', () => {
      const first = resolveTargetReceiptEvidenceSpec('auq_poultry');
      (first.sourceIndices as number[])[0] = 99;
      first.receiptId = 'mutated-receipt-id';
      first.filenameSlug = 'mutated-slug';
      const second = resolveTargetReceiptEvidenceSpec('auq_poultry');
      expect(second.receiptId).toBe('auq8r7qU-EN_l38Y2xDea');
      expect(second.sourceIndices).toEqual([0, 1]);
      expect(second.filenameSlug).toBe('auq');
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: null,
        persistedItemRows: [],
      });
      expect(payload.targetReceiptId).toBe('auq8r7qU-EN_l38Y2xDea');
      expect(payload.sourceIndices).toEqual([0, 1]);
    });

    it('CASE E — invalid runtime keys remain fail-closed', () => {
      for (const bad of [
        'not_a_real_target',
        'unknown',
        '__proto__',
        'constructor',
        'toString',
        '',
      ]) {
        expect(() => resolveTargetReceiptEvidenceSpec(bad)).toThrow(
          UnknownTargetReceiptEvidenceTargetKeyError
        );
      }
      expect(() =>
        buildTargetReceiptEvidenceExport('not_a_real_target', {
          nowMs: NOW,
          receipt: null,
          persistedItemRows: [],
        })
      ).toThrow(/target_receipt_evidence_unknown_target_key/);
      expect(() =>
        buildTargetReceiptItemsSelectSqlForTarget('also_invalid')
      ).toThrow(UnknownTargetReceiptEvidenceTargetKeyError);
    });

    it('CASE F — UI uses target key, not spec object construction', () => {
      const settingsSource = fs.readFileSync(
        path.join(__dirname, '../app/(tabs)/settings/index.tsx'),
        'utf8'
      );
      expect(settingsSource).toContain("targetKey: 'auq_poultry'");
      expect(settingsSource).toContain(
        "targetKey: 'receipt063_seiyu_inline_markdown'"
      );
      expect(settingsSource).toContain('resolveTargetReceiptEvidenceSpec');
      expect(settingsSource).not.toMatch(
        /exportAndShareTargetReceiptEvidence\(\{[\s\S]*receiptId\s*:/
      );
      expect(settingsSource).not.toMatch(
        /exportAndShareTargetReceiptEvidence\(\{[\s\S]*sourceIndices\s*:/
      );
      expect(settingsSource).not.toContain('TARGET_RECEIPT_EVIDENCE_SPECS');
    });

    it('CASE G — no public production API accepting arbitrary receiptId/sourceIndices/Spec', () => {
      const source = fs.readFileSync(
        path.join(__dirname, 'targetReceiptEvidenceExport.ts'),
        'utf8'
      );
      expect(source).not.toMatch(/export type TargetReceiptEvidenceSpec/);
      expect(source).not.toMatch(/export interface TargetReceiptEvidenceSpec/);
      expect(source).toMatch(
        /export function buildTargetReceiptEvidenceExport\(\s*targetKey: string/
      );
      expect(source).not.toMatch(
        /export function buildTargetReceiptEvidenceExport\([^{]*spec\??:/
      );
      expect(source).toMatch(
        /function buildTargetReceiptItemsSelectSql\(\s*sourceIndices/
      );
      expect(source).not.toMatch(
        /export function buildTargetReceiptItemsSelectSql\(/
      );
      expect(source).toContain('buildTargetReceiptItemsSelectSqlForTarget');
      expect(TargetReceiptEvidenceExport).not.toHaveProperty(
        'TargetReceiptEvidenceSpec'
      );
    });
  });

  describe('A1 — reconciliation allowlist privacy', () => {
    it('CASE A — known scalar reconciliation fields are retained correctly', () => {
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
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
          recognition_snapshot_json: null,
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
    });

    it('CASE B — warnings nested payloads are omitted; scalars kept', () => {
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: {
          id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
          analysis_json: analysisJson({
            items: [item0()],
            reconciliation: {
              ok: true,
              diff: 0,
              warnings: [{ ocrText: 'PRIVATE', secretNested: { x: 1 } }],
            },
          }),
          user_items_json: null,
          recognition_snapshot_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.analysis.reconciliation).toEqual({ ok: true, diff: 0 });
      const json = JSON.stringify(payload);
      expect(json).not.toContain('warnings');
      expect(json).not.toContain('PRIVATE');
    });

    it('CASE C — warnings-only reconciliation exports null', () => {
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: {
          id: TARGET_RECEIPT_EVIDENCE_RECEIPT_ID,
          analysis_json: analysisJson({
            items: [item0()],
            reconciliation: {
              warnings: [{ ocrText: 'PRIVATE' }],
            },
          }),
          user_items_json: null,
          recognition_snapshot_json: null,
        },
        persistedItemRows: [],
      });
      expect(payload.analysis.reconciliation).toBeNull();
    });
  });
});
