/**
 * Target receipt evidence export — narrow INTERNAL/Validation instrumentation.
 * Schema v5: observational / SELECT-only; no monetary recovery on persisted rows.
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
  TARGET_RECEIPT_EVIDENCE_SCHEMA_VERSION,
  TARGET_RECEIPT_ITEMS_SELECT_SQL,
  TARGET_RECEIPT_SELECT_SQL,
  assertTargetReceiptEvidenceJsonSafe,
  buildRecognitionTextWindow,
  buildTargetReceiptEvidenceExport,
  buildTargetReceiptEvidenceFromLocalDb,
  buildTargetReceiptItemsSelectSqlForTarget,
  buildTargetReceiptSelectSql,
  classifyJsonColumnState,
  classifyNestedJsonValueState,
  classifyUserItemsJsonRaw,
  clipRecognitionTextLinePreservingAnchor,
  diagnosticFieldFromValue,
  loadTargetReceiptEvidenceWithDb,
  readDiagnosticField,
  recognitionTextWindowJoinedLength,
  resolveRecognitionMappingFromReviewIndex,
  resolveTargetReceiptEvidenceSpec,
  UnknownTargetReceiptEvidenceTargetKeyError,
  type TargetReceiptEvidenceDatabase,
} from './targetReceiptEvidenceExport';

const NOW = Date.parse('2026-09-07T03:00:00.000Z');
const AUQ = resolveTargetReceiptEvidenceSpec('auq_poultry');
const R063 = resolveTargetReceiptEvidenceSpec('receipt063_seiyu_inline_markdown');
const R061 = resolveTargetReceiptEvidenceSpec('receipt061_aeon_quantity');

const SETTINGS_SOURCE = fs.readFileSync(
  path.join(__dirname, '../app/(tabs)/settings/index.tsx'),
  'utf8'
);

function analysisJson(partial: {
  items?: unknown[];
  discounts?: unknown[];
  reconciliation?: Record<string, unknown>;
  review_meta?: Record<string, unknown>;
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
    ...(partial.review_meta ? { review_meta: partial.review_meta } : {}),
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

function finiteQty(value: number) {
  return { kind: 'finite_number' as const, value };
}

function baseReceiptInput(
  receiptId: string,
  overrides: {
    analysis_json?: string | null;
    user_items_json?: string | null;
    recognition_snapshot_json?: string | null;
  } = {}
) {
  return {
    id: receiptId,
    analysis_json: overrides.analysis_json ?? null,
    user_items_json: overrides.user_items_json ?? null,
    recognition_snapshot_json: overrides.recognition_snapshot_json ?? null,
  };
}

describe('targetReceiptEvidenceExport — schema v5', () => {
  describe('STATIC HARDENING', () => {
    it('authoritative registry is NOT exported', () => {
      const source = fs.readFileSync(
        path.join(__dirname, 'targetReceiptEvidenceExport.ts'),
        'utf8'
      );
      expect(source).toMatch(/\bconst TARGET_RECEIPT_EVIDENCE_SPECS = \{/);
      expect(source).not.toMatch(/export const TARGET_RECEIPT_EVIDENCE_SPECS\b/);
      expect(source).not.toMatch(/export \{[^}]*TARGET_RECEIPT_EVIDENCE_SPECS/);
      expect(TargetReceiptEvidenceExport).not.toHaveProperty(
        'TARGET_RECEIPT_EVIDENCE_SPECS'
      );
    });

    it('resolves auq [0,1], receipt063 [8,9], receipt061 [1,2,3] primary 2', () => {
      expect(AUQ.receiptId).toBe('auq8r7qU-EN_l38Y2xDea');
      expect(AUQ.sourceIndices).toEqual([0, 1]);
      expect(AUQ.primarySourceIndex).toBe(0);

      expect(R063.receiptId).toBe('xQCDD8d8OAAewZdYpTs4p');
      expect(R063.sourceIndices).toEqual([8, 9]);
      expect(R063.primarySourceIndex).toBe(8);

      expect(R061.receiptId).toBe('Lgo6ObHsTqXTc8h1WOz7-');
      expect(R061.sourceIndices).toEqual([1, 2, 3]);
      expect(R061.primarySourceIndex).toBe(2);
      expect(R061.diagnosticMerchantProductId).toBe('mp_d3153e4f0c0bc8bb');
    });

    it('unknown key and arbitrary receipt id fail-closed', () => {
      for (const bad of [
        'not_a_real_target',
        'unknown',
        '__proto__',
        'constructor',
        'toString',
        '',
        'Lgo6ObHsTqXTc8h1WOz7-',
        'receipt061_other',
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

    it('mutating resolver result cannot alter later authority', () => {
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

    it('SELECT-only SQL includes review_source_index and purchase_unit_price', () => {
      for (const sql of [
        buildTargetReceiptSelectSql(),
        TARGET_RECEIPT_SELECT_SQL,
        buildTargetReceiptItemsSelectSqlForTarget('auq_poultry'),
        buildTargetReceiptItemsSelectSqlForTarget('receipt063_seiyu_inline_markdown'),
        buildTargetReceiptItemsSelectSqlForTarget('receipt061_aeon_quantity'),
        TARGET_RECEIPT_ITEMS_SELECT_SQL,
      ]) {
        expect(sql).toMatch(/^SELECT\b/i);
        expect(sql).not.toMatch(
          /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i
        );
      }
      expect(buildTargetReceiptSelectSql()).toMatch(/recognition_snapshot_json/);
      expect(buildTargetReceiptItemsSelectSqlForTarget('receipt061_aeon_quantity')).toMatch(
        /review_source_index/
      );
      expect(buildTargetReceiptItemsSelectSqlForTarget('receipt061_aeon_quantity')).toMatch(
        /purchase_unit_price/
      );
    });

    it('Settings Internal/Validation: Receipt061 export, targetKey, no legacy chain keys', () => {
      expect(SETTINGS_SOURCE).toContain('Export Receipt061 Evidence');
      expect(SETTINGS_SOURCE).toContain("targetKey: 'receipt061_aeon_quantity'");
      expect(SETTINGS_SOURCE).not.toContain('firstQty1');
      expect(SETTINGS_SOURCE).not.toContain('quantityChain');
      expect(
        SETTINGS_SOURCE.includes('quantityEvidence') ||
          SETTINGS_SOURCE.includes('mapping=')
      ).toBe(true);

      const internalBlock = SETTINGS_SOURCE.split('Internal / Validation')[1] ?? '';
      const beforeDevTools = internalBlock.split('Developer Tools')[0] ?? '';
      expect(beforeDevTools).toContain('Export Receipt063 Evidence');
      expect(beforeDevTools).toContain('Export Receipt061 Evidence');
      expect(beforeDevTools).not.toContain('Export receipts DB (JSON)');
    });

    it('assertTargetReceiptEvidenceJsonSafe rejects forbidden substrings', () => {
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: baseReceiptInput(TARGET_RECEIPT_EVIDENCE_RECEIPT_ID, {
          analysis_json: analysisJson({ items: [item0()] }),
        }),
        persistedItemRows: [],
      });
      const json = JSON.stringify(payload);
      for (const needle of TARGET_RECEIPT_EVIDENCE_FORBIDDEN_JSON_SUBSTRINGS) {
        expect(json.includes(needle)).toBe(false);
      }
      assertTargetReceiptEvidenceJsonSafe(payload);
    });

    it('schemaVersion is 5', () => {
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: null,
        persistedItemRows: [],
      });
      expect(TARGET_RECEIPT_EVIDENCE_SCHEMA_VERSION).toBe(5);
      expect(payload.schemaVersion).toBe(5);
    });

    it('loadTargetReceiptEvidenceWithDb uses initialized DB helper path', async () => {
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

    it('uninitialized DB fails without init/migration/backfill', async () => {
      await expect(
        buildTargetReceiptEvidenceFromLocalDb({
          requireInitializedDb: () => {
            throw new Error('Receipts database is not initialized');
          },
        })
      ).rejects.toThrow(/not initialized/i);
    });

    it('all-receipts DB export remains __DEV__-only', () => {
      expect(() => assertReceiptsDbExportAllowed(false)).toThrow(/development builds/i);
      expect(SETTINGS_SOURCE).toMatch(
        /\{__DEV__\s*\?[\s\S]*Export receipts DB \(JSON\)/
      );
      expect(SETTINGS_SOURCE).toContain('Export Target Receipt Evidence');
    });
  });

  describe('FIELD STATE', () => {
    it('diagnosticFieldFromValue classifies absent/null/finite/string/non_finite', () => {
      expect(diagnosticFieldFromValue(undefined)).toEqual({ kind: 'absent' });
      expect(diagnosticFieldFromValue(null)).toEqual({ kind: 'null' });
      expect(diagnosticFieldFromValue(1)).toEqual(finiteQty(1));
      expect(diagnosticFieldFromValue(-3)).toEqual(finiteQty(-3));
      expect(diagnosticFieldFromValue(1.5)).toEqual(finiteQty(1.5));
      expect(diagnosticFieldFromValue('1')).toEqual({ kind: 'string', value: '1' });
      expect(diagnosticFieldFromValue(true)).toEqual({ kind: 'boolean', value: true });
      expect(diagnosticFieldFromValue(false)).toEqual({ kind: 'boolean', value: false });
      expect(diagnosticFieldFromValue({ a: 1 })).toEqual({
        kind: 'other_type',
        typeofValue: 'object',
      });
      expect(diagnosticFieldFromValue([1, 2])).toEqual({
        kind: 'other_type',
        typeofValue: 'object',
      });
      expect(diagnosticFieldFromValue(Number.NaN)).toEqual({
        kind: 'non_finite_number',
        value: Number.NaN,
      });
      expect(diagnosticFieldFromValue(Number.POSITIVE_INFINITY)).toEqual({
        kind: 'non_finite_number',
        value: Number.POSITIVE_INFINITY,
      });
    });

    it('readDiagnosticField distinguishes absent key from null value', () => {
      expect(readDiagnosticField({}, 'quantity')).toEqual({ kind: 'absent' });
      expect(readDiagnosticField(null, 'quantity')).toEqual({ kind: 'absent' });
      expect(readDiagnosticField({ quantity: null }, 'quantity')).toEqual({
        kind: 'null',
      });
      expect(readDiagnosticField({ quantity: 1 }, 'quantity')).toEqual(finiteQty(1));
    });

    it('unitPrice and unit_price are independent — no synthesis', () => {
      const onlySnake = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: { name: 'tea', unit_price: 108, quantity: 1, lineTotal: 108 },
            }),
          }),
        }),
        persistedItemRows: [],
      });
      const snakePrimary = onlySnake.analysis.items.find((i) => i.arrayIndex === 2)!;
      expect(snakePrimary.fields.unitPrice).toEqual({ kind: 'absent' });
      expect(snakePrimary.fields.unit_price).toEqual(finiteQty(108));

      const onlyCamel = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: { name: 'tea', unitPrice: 109, quantity: 1, lineTotal: 109 },
            }),
          }),
        }),
        persistedItemRows: [],
      });
      const camelPrimary = onlyCamel.analysis.items.find((i) => i.arrayIndex === 2)!;
      expect(camelPrimary.fields.unitPrice).toEqual(finiteQty(109));
      expect(camelPrimary.fields.unit_price).toEqual({ kind: 'absent' });

      const both = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: {
                name: 'tea',
                unitPrice: 108,
                unit_price: 109,
                quantity: 1,
                lineTotal: 108,
              },
            }),
          }),
        }),
        persistedItemRows: [],
      });
      const bothPrimary = both.analysis.items.find((i) => i.arrayIndex === 2)!;
      expect(bothPrimary.fields.unitPrice).toEqual(finiteQty(108));
      expect(bothPrimary.fields.unit_price).toEqual(finiteQty(109));
    });

    it('lineTotal and line_total are independent — no synthesis', () => {
      const onlySnake = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: { name: 'tea', line_total: 216, quantity: 1 },
            }),
          }),
        }),
        persistedItemRows: [],
      });
      const snakePrimary = onlySnake.analysis.items.find((i) => i.arrayIndex === 2)!;
      expect(snakePrimary.fields.lineTotal).toEqual({ kind: 'absent' });
      expect(snakePrimary.fields.line_total).toEqual(finiteQty(216));

      const onlyCamel = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: { name: 'tea', lineTotal: 217, quantity: 1 },
            }),
          }),
        }),
        persistedItemRows: [],
      });
      const camelPrimary = onlyCamel.analysis.items.find((i) => i.arrayIndex === 2)!;
      expect(camelPrimary.fields.lineTotal).toEqual(finiteQty(217));
      expect(camelPrimary.fields.line_total).toEqual({ kind: 'absent' });
    });
  });

  describe('JSON COLUMN', () => {
    it('classifyJsonColumnState covers null/empty/whitespace/unparseable/parseable', () => {
      expect(classifyJsonColumnState(null)).toEqual({ kind: 'column_null' });
      expect(classifyJsonColumnState('')).toEqual({ kind: 'empty_string' });
      expect(classifyJsonColumnState('   ')).toEqual({ kind: 'whitespace_only' });
      expect(classifyJsonColumnState('{broken')).toEqual({ kind: 'unparseable' });
      expect(classifyJsonColumnState('{"a":1}')).toEqual({
        kind: 'parseable',
        shape: 'object',
      });
      expect(classifyJsonColumnState('[1,2]')).toEqual({
        kind: 'parseable',
        shape: 'array',
      });
      expect(classifyJsonColumnState('"hello"')).toEqual({
        kind: 'parseable',
        shape: 'primitive',
        primitiveType: 'string',
      });
    });

    it('classifyUserItemsJsonRaw maps column states to rawKind', () => {
      expect(classifyUserItemsJsonRaw(null).rawKind).toBe('null');
      expect(classifyUserItemsJsonRaw('').rawKind).toBe('empty');
      expect(classifyUserItemsJsonRaw('   ').rawKind).toBe('empty');
      expect(classifyUserItemsJsonRaw('{x').rawKind).toBe('malformed');
      expect(classifyUserItemsJsonRaw('{"a":1}').rawKind).toBe('non_array');
      expect(classifyUserItemsJsonRaw('[]').rawKind).toBe('array');
    });
  });

  describe('ROW MAPPING', () => {
    it('maps recognition via review_source_index with neighborhood', () => {
      const recognitionItems = padItems(6, {
        4: { name: 'before', quantity: 1, lineTotal: 10 },
        5: {
          name: '世界teaチャイラテ',
          quantity: 2,
          unitPrice: 108,
          lineTotal: 216,
        },
        6: { name: '2個 × 単108', quantity: 1, lineTotal: 0 },
      });

      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: {
                name: '世界teaチャイラテ',
                quantity: 1,
                review_source_index: 5,
              },
            }),
          }),
          recognition_snapshot_json: JSON.stringify({ items: recognitionItems }),
        }),
        persistedItemRows: [],
      });

      const ev = payload.quantityEvidence;
      expect(ev.primaryFinalSourceIndex).toBe(2);
      expect(ev.mapping.status).toBe('mapped_via_review_source_index');
      expect(ev.mapping.recognitionArrayIndex).toBe(5);
      expect(ev.mapping.recognitionItemCount).toBe(7);
      expect(ev.mapping.reviewSourceIndexField).toEqual(finiteQty(5));
      expect(ev.recognitionMappedNeighborhood).not.toBeNull();
      expect(ev.recognitionMappedNeighborhood!.map((i) => i.arrayIndex)).toEqual([
        4, 5, 6,
      ]);
      const center = ev.recognitionMappedNeighborhood!.find((i) => i.arrayIndex === 5)!;
      expect(center.fields.quantity).toEqual(finiteQty(2));
      expect(center.fields.unitPrice).toEqual(finiteQty(108));
      const multiplier = ev.recognitionMappedNeighborhood!.find((i) => i.arrayIndex === 6)!;
      expect(multiplier.fields.name).toEqual({
        kind: 'string',
        value: '2個 × 単108',
      });
    });

    it('review_source_index absent → cannot_determine, neighborhood null', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: { name: '世界teaチャイラテ', quantity: 1, lineTotal: 216 },
            }),
          }),
          recognition_snapshot_json: JSON.stringify({
            items: padItems(3, {
              2: { name: '世界teaチャイラテ', quantity: 2, unitPrice: 108 },
            }),
          }),
        }),
        persistedItemRows: [],
      });

      expect(payload.quantityEvidence.mapping.status).toBe('cannot_determine');
      expect(payload.quantityEvidence.mapping.recognitionArrayIndex).toBeNull();
      expect(payload.quantityEvidence.recognitionMappedNeighborhood).toBeNull();
    });

    function mappingWithReviewIndex(
      reviewSourceIndex: unknown,
      recognitionItems: unknown[]
    ) {
      return buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: {
                name: '世界teaチャイラテ',
                quantity: 1,
                review_source_index: reviewSourceIndex,
              },
            }),
          }),
          recognition_snapshot_json: JSON.stringify({ items: recognitionItems }),
        }),
        persistedItemRows: [],
      }).quantityEvidence;
    }

    it('invalid / out-of-range review_source_index → cannot_determine', () => {
      const items3 = padItems(2, {
        0: { name: 'a', quantity: 1 },
        1: { name: 'b', quantity: 1 },
        2: { name: 'c', quantity: 1 },
      });

      for (const bad of [-1, 1.5, 3, 999]) {
        const ev = mappingWithReviewIndex(bad, items3);
        expect(ev.mapping.status).toBe('cannot_determine');
        expect(ev.mapping.recognitionArrayIndex).toBeNull();
        expect(ev.recognitionMappedNeighborhood).toBeNull();
      }

      const emptyEv = mappingWithReviewIndex(0, []);
      expect(emptyEv.mapping.status).toBe('cannot_determine');
      expect(emptyEv.mapping.recognitionItemCount).toBe(0);
      expect(emptyEv.recognitionMappedNeighborhood).toBeNull();
    });

    it('literal NaN/Infinity review_source_index → cannot_determine (no JSON round-trip)', () => {
      const items3 = padItems(2, {
        0: { name: 'a', quantity: 1 },
        1: { name: 'b', quantity: 1 },
        2: { name: 'c', quantity: 1 },
      });
      for (const bad of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]) {
        const field = diagnosticFieldFromValue(bad);
        const resolved = resolveRecognitionMappingFromReviewIndex(field, items3);
        expect(field.kind).toBe('non_finite_number');
        expect(resolved.status).toBe('cannot_determine');
        expect(resolved.recognitionArrayIndex).toBeNull();
      }
    });

    it('valid bounds R=0 and R=last map; neighborhood does not fabricate rows', () => {
      const items3 = padItems(2, {
        0: { name: 'a', quantity: 1 },
        1: { name: 'b', quantity: 1 },
        2: { name: 'c', quantity: 1 },
      });

      const atStart = mappingWithReviewIndex(0, items3);
      expect(atStart.mapping.status).toBe('mapped_via_review_source_index');
      expect(atStart.mapping.recognitionArrayIndex).toBe(0);
      expect(atStart.recognitionMappedNeighborhood!.map((i) => i.arrayIndex)).toEqual([
        0, 1,
      ]);

      const atEnd = mappingWithReviewIndex(2, items3);
      expect(atEnd.mapping.status).toBe('mapped_via_review_source_index');
      expect(atEnd.mapping.recognitionArrayIndex).toBe(2);
      expect(atEnd.recognitionMappedNeighborhood!.map((i) => i.arrayIndex)).toEqual([
        1, 2,
      ]);
    });

    it('sparse hole at review_source_index → cannot_determine', () => {
      const sparse: unknown[] = [];
      sparse[0] = { name: 'a', quantity: 1 };
      sparse[2] = { name: 'c', quantity: 1 };
      // JSON round-trip turns the hole into null; null is not a mappable row.
      const ev = mappingWithReviewIndex(1, sparse);
      expect(ev.mapping.recognitionItemCount).toBe(3);
      expect(ev.mapping.status).toBe('cannot_determine');
      expect(ev.mapping.recognitionArrayIndex).toBeNull();
      expect(ev.recognitionMappedNeighborhood).toBeNull();

      const withNull = mappingWithReviewIndex(1, [
        { name: 'a', quantity: 1 },
        null,
        { name: 'c', quantity: 1 },
      ]);
      expect(withNull.mapping.status).toBe('cannot_determine');
    });
  });

  describe('RAW TEXT', () => {
    const targetBlob = [
      'header line',
      '世界teaチャイラテ',
      '2個 × 単108',
      '216',
      'footer',
    ].join('\n');

    function probeFromOcr(ocr: string) {
      return buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({ items: padItems(3, {}) }),
          recognition_snapshot_json: JSON.stringify({
            items: [],
            ocr_raw_text: ocr,
          }),
        }),
        persistedItemRows: [],
      }).quantityEvidence.recognitionTextProbe;
    }

    function expectAnchorRetained(probe: {
      state: string;
      windowLines: string[];
      maxChars: number;
      maxLines: number;
    }) {
      expect(probe.state).toBe('present_target_found');
      const joined = probe.windowLines.join('\n');
      expect(joined).toMatch(/世界tea|チャイラテ/);
      expect(recognitionTextWindowJoinedLength(probe.windowLines)).toBeLessThanOrEqual(
        probe.maxChars
      );
      expect(joined.length).toBeLessThanOrEqual(probe.maxChars);
      expect(probe.windowLines.length).toBeLessThanOrEqual(5);
      expect(probe.windowLines.length).toBeLessThanOrEqual(probe.maxLines);
    }

    function expectNoOcrBlobKeyDump(json: string) {
      expect(json).not.toMatch(/"ocr_raw_text"\s*:/);
      expect(json).not.toMatch(/"rawText"\s*:/);
      expect(json).not.toMatch(/"raw_text"\s*:/);
      expect(json).not.toMatch(/"recognizedText"\s*:/);
      expect(json).not.toMatch(/"text"\s*:/);
    }

    it('A: normal short anchor window retains anchor and adjacent multiplier', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({ items: padItems(3, {}) }),
          recognition_snapshot_json: JSON.stringify({
            items: [],
            ocr_raw_text: targetBlob,
          }),
        }),
        persistedItemRows: [],
      });

      const probe = payload.quantityEvidence.recognitionTextProbe;
      expect(probe.enabled).toBe(true);
      expect(probe.sourceField).toBe('ocr_raw_text');
      expect(probe.alsoPresentSupportedSourceFields).toEqual([]);
      expectAnchorRetained(probe);
      expect(probe.windowLines.some((l) => l.includes('2個'))).toBe(true);

      const json = JSON.stringify(payload);
      expectNoOcrBlobKeyDump(json);
      expect(json).toContain('"sourceField":"ocr_raw_text"');
      for (const needle of TARGET_RECEIPT_EVIDENCE_FORBIDDEN_JSON_SUBSTRINGS) {
        expect(json.includes(needle)).toBe(false);
      }
      assertTargetReceiptEvidenceJsonSafe(payload);
    });

    it('B: very long preceding line cannot evict the anchor', () => {
      const ocr = [
        'U'.repeat(450),
        '世界teaチャイラテ',
        '2個 × 単108',
        '216',
      ].join('\n');
      const probe = probeFromOcr(ocr);
      expectAnchorRetained(probe);
      expect(probe.windowLines.some((l) => l.includes('2個 × 単108'))).toBe(true);
      assertTargetReceiptEvidenceJsonSafe(
        buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
          nowMs: NOW,
          receipt: baseReceiptInput(R061.receiptId, {
            analysis_json: analysisJson({ items: padItems(3, {}) }),
            recognition_snapshot_json: JSON.stringify({
              items: [],
              ocr_raw_text: ocr,
            }),
          }),
          persistedItemRows: [],
        })
      );
    });

    it('C: very long following line cannot evict the anchor', () => {
      const ocr = [
        'pad',
        '世界teaチャイラテ',
        '2個 × 単108',
        'F'.repeat(450),
      ].join('\n');
      const probe = probeFromOcr(ocr);
      expectAnchorRetained(probe);
      expect(probe.windowLines.some((l) => l.includes('2個 × 単108'))).toBe(true);
    });

    it('D: very long anchor line still exports matched anchor substring', () => {
      const ocr = `${'P'.repeat(250)}世界teaチャイラテ${'S'.repeat(250)}`;
      const probe = probeFromOcr(ocr);
      expectAnchorRetained(probe);
      expect(probe.windowLines).toHaveLength(1);
      expect(probe.windowLines[0]!).toMatch(/世界tea|チャイラテ/);
      expect(probe.windowLines[0]!.startsWith('P'.repeat(250))).toBe(false);
      const direct = buildRecognitionTextWindow(ocr);
      expect(direct.state).toBe('present_target_found');
      expect(direct.windowLines.join('\n')).toMatch(/世界tea|チャイラテ/);
      expect(
        clipRecognitionTextLinePreservingAnchor(ocr, 400)
      ).toMatch(/世界tea|チャイラテ/);
    });

    it('E: multiplier adjacent below is included when budget permits', () => {
      const probe = probeFromOcr(
        ['世界teaチャイラテ', '2個 × 単108', '216'].join('\n')
      );
      expectAnchorRetained(probe);
      expect(probe.windowLines.some((l) => l.includes('2個 × 単108'))).toBe(true);
    });

    it('F: multiplier adjacent above is included when budget permits', () => {
      const probe = probeFromOcr(
        ['2個 × 単108', '世界teaチャイラテ', '216'].join('\n')
      );
      expectAnchorRetained(probe);
      expect(probe.windowLines.some((l) => l.includes('2個 × 単108'))).toBe(true);
    });

    it('G: newline separators count toward the 400-char hard limit', () => {
      // Content alone sums to 400; three newlines would make joined 403 if forgotten.
      const lines = [
        'A'.repeat(130),
        '世界teaチャイラテ', // 10
        'C'.repeat(130),
        'D'.repeat(130),
      ];
      const contentSum = lines.reduce((n, l) => n + l.length, 0);
      expect(contentSum).toBe(400);
      const window = buildRecognitionTextWindow(lines.join('\n'));
      expect(window.state).toBe('present_target_found');
      expect(window.windowLines.join('\n')).toMatch(/世界tea|チャイラテ/);
      const joinedLen = recognitionTextWindowJoinedLength(window.windowLines);
      expect(joinedLen).toBeLessThanOrEqual(400);
      expect(joinedLen).toBe(window.windowLines.join('\n').length);
      // Must not keep all four full lines (that would be 403 with newlines).
      const ifUnclipped =
        contentSum + Math.max(0, window.windowLines.length - 1);
      if (window.windowLines.length === 4) {
        expect(joinedLen).toBeLessThan(ifUnclipped);
      }
    });

    it('H: multiple anchors → first deterministic window only', () => {
      const longLine = 'X'.repeat(500);
      const multi = [
        longLine,
        '世界teaチャイラテ first',
        '2個 × 単108',
        '216',
        longLine,
        '世界teaチャイラテ second',
        'more',
      ].join('\n');
      const probe = probeFromOcr(multi);
      expectAnchorRetained(probe);
      expect(probe.multipleAnchorsDetected).toBe(true);
      expect(probe.windowLines.some((l) => l.includes('second'))).toBe(false);
      expect(probe.windowLines.some((l) => /世界tea|チャイラテ/.test(l))).toBe(true);
    });

    it('I: target not found → no broad text export', () => {
      const probe = probeFromOcr('unrelated product\nno anchor here\n' + 'Z'.repeat(500));
      expect(probe.state).toBe('present_target_not_found');
      expect(probe.sourceField).toBe('ocr_raw_text');
      expect(probe.windowLines).toEqual([]);
    });

    it('J: unsupported text/recognizedText/raw_text are ignored', () => {
      for (const key of ['text', 'recognizedText', 'raw_text'] as const) {
        const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
          nowMs: NOW,
          receipt: baseReceiptInput(R061.receiptId, {
            analysis_json: analysisJson({ items: padItems(3, {}) }),
            recognition_snapshot_json: JSON.stringify({
              items: [],
              [key]: '世界teaチャイラテ\n2個 × 単108\n216',
            }),
          }),
          persistedItemRows: [],
        });
        const probe = payload.quantityEvidence.recognitionTextProbe;
        expect(probe.state).toBe('absent');
        expect(probe.sourceField).toBeNull();
        expect(probe.windowLines).toEqual([]);
      }
    });

    it('K: canonical ocr_raw_text works', () => {
      const probe = probeFromOcr(targetBlob);
      expect(probe.sourceField).toBe('ocr_raw_text');
      expectAnchorRetained(probe);
    });

    it('L: legacy rawText works when ocr_raw_text absent', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({ items: padItems(3, {}) }),
          recognition_snapshot_json: JSON.stringify({
            items: [],
            rawText: targetBlob,
          }),
        }),
        persistedItemRows: [],
      });
      const probe = payload.quantityEvidence.recognitionTextProbe;
      expect(probe.sourceField).toBe('rawText');
      expectAnchorRetained(probe);
      assertTargetReceiptEvidenceJsonSafe(payload);
    });

    it('ocr_raw_text precedes rawText; does not merge strings', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({ items: padItems(3, {}) }),
          recognition_snapshot_json: JSON.stringify({
            items: [],
            ocr_raw_text: targetBlob,
            rawText: 'OTHER_ANCHOR_世界teaチャイラテ_SHOULD_NOT_MERGE',
          }),
        }),
        persistedItemRows: [],
      });
      const probe = payload.quantityEvidence.recognitionTextProbe;
      expect(probe.sourceField).toBe('ocr_raw_text');
      expect(probe.alsoPresentSupportedSourceFields).toEqual(['rawText']);
      expect(probe.windowLines.join('\n')).not.toContain('OTHER_ANCHOR');
    });

    it('absent recognition text → absent probe state', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({ items: padItems(3, {}) }),
          recognition_snapshot_json: JSON.stringify({ items: [] }),
        }),
        persistedItemRows: [],
      });
      expect(payload.quantityEvidence.recognitionTextProbe.state).toBe('absent');
      expect(payload.quantityEvidence.recognitionTextProbe.sourceField).toBeNull();
    });

    it('text probe disabled for non-receipt061 targets', () => {
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: baseReceiptInput(AUQ.receiptId, {
          analysis_json: analysisJson({ items: [item0()] }),
          recognition_snapshot_json: JSON.stringify({
            items: [],
            ocr_raw_text: '世界teaチャイラテ',
          }),
        }),
        persistedItemRows: [],
      });
      expect(payload.quantityEvidence.recognitionTextProbe.enabled).toBe(false);
    });
  });

  describe('USER / INDEX', () => {
    it('user_items primary present vs absent at primarySourceIndex', () => {
      const withUser = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: { name: '世界teaチャイラテ', quantity: 2, lineTotal: 216 },
            }),
          }),
          user_items_json: JSON.stringify(
            padItems(3, {
              2: {
                name: '世界teaチャイラテ',
                quantity: 1,
                lineTotal: 216,
                amountUserEdited: true,
              },
            })
          ),
        }),
        persistedItemRows: [],
      });
      expect(withUser.userItems.primarySourceIndexPresent).toBe(true);
      expect(withUser.quantityEvidence.userItemsPrimary).not.toBeNull();
      expect(withUser.quantityEvidence.userItemsPrimary!.arrayIndex).toBe(2);
      expect(withUser.quantityEvidence.userItemsPrimary!.fields.quantity).toEqual(
        finiteQty(1)
      );

      const noUser = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: { name: '世界teaチャイラテ', quantity: 1, lineTotal: 216 },
            }),
          }),
          user_items_json: null,
        }),
        persistedItemRows: [],
      });
      expect(noUser.userItems.primarySourceIndexPresent).toBe(false);
      expect(noUser.quantityEvidence.userItemsPrimary).toBeNull();
    });

    it('reviewMeta quantityEditDetermination is cannot_determine with state fidelity', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: JSON.stringify({
            items: padItems(3, {
              2: { name: '世界teaチャイラテ', quantity: 1, lineTotal: 216 },
            }),
            discounts: [],
            review_meta: { error_tags: ['CATEGORY_ERROR'] },
            reviewMeta: { errorTags: ['OTHER'] },
          }),
        }),
        persistedItemRows: [],
      });
      expect(payload.receipt.reviewMetaPresent).toBe(true);
      expect(payload.reviewMeta.review_meta).toEqual({ kind: 'object' });
      expect(payload.reviewMeta.reviewMeta).toEqual({ kind: 'object' });
      expect(payload.reviewMeta.quantityEditDetermination).toBe(
        'cannot_determine_from_review_metadata'
      );
      expect(payload.reviewMeta.errorTagsFromReview_meta).toEqual(['CATEGORY_ERROR']);
      expect(payload.reviewMeta.errorTagsFromReviewMeta).toEqual(['OTHER']);
    });

    it('review_meta nested states distinguish null/empty/whitespace/malformed/shapes', () => {
      expect(classifyNestedJsonValueState(null, 'review_meta')).toEqual({
        kind: 'key_absent',
      });
      expect(classifyNestedJsonValueState({}, 'review_meta')).toEqual({
        kind: 'key_absent',
      });
      expect(classifyNestedJsonValueState({ review_meta: null }, 'review_meta')).toEqual({
        kind: 'null',
      });
      expect(classifyNestedJsonValueState({ review_meta: '' }, 'review_meta')).toEqual({
        kind: 'empty_string',
      });
      expect(classifyNestedJsonValueState({ review_meta: '  ' }, 'review_meta')).toEqual({
        kind: 'whitespace_only',
      });
      expect(classifyNestedJsonValueState({ review_meta: '{x' }, 'review_meta')).toEqual({
        kind: 'unparseable_string',
      });
      expect(classifyNestedJsonValueState({ review_meta: '{}' }, 'review_meta')).toEqual({
        kind: 'parseable_string',
        shape: 'object',
      });
      expect(classifyNestedJsonValueState({ review_meta: '[]' }, 'review_meta')).toEqual({
        kind: 'parseable_string',
        shape: 'array',
      });
      expect(
        classifyNestedJsonValueState({ review_meta: '"string"' }, 'review_meta')
      ).toEqual({
        kind: 'parseable_string',
        shape: 'primitive',
        primitiveType: 'string',
      });
      expect(classifyNestedJsonValueState({ review_meta: {} }, 'review_meta')).toEqual({
        kind: 'object',
      });
      expect(classifyNestedJsonValueState({ review_meta: [] }, 'review_meta')).toEqual({
        kind: 'array',
      });
      expect(
        classifyNestedJsonValueState({ review_meta: 'plain' }, 'review_meta')
      ).toEqual({ kind: 'unparseable_string' });

      const onlyCamel = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: JSON.stringify({
            items: padItems(3, {}),
            reviewMeta: { corrected: true },
          }),
        }),
        persistedItemRows: [],
      });
      expect(onlyCamel.reviewMeta.review_meta.kind).toBe('key_absent');
      expect(onlyCamel.reviewMeta.reviewMeta.kind).toBe('object');
      expect(onlyCamel.reviewMeta.quantityEditDetermination).toBe(
        'cannot_determine_from_review_metadata'
      );
    });

    it('persisted items report purchaseQuantityOriginDetermination', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({ items: padItems(3, {}) }),
        }),
        persistedItemRows: [
          {
            source_index: 2,
            raw_name: '世界teaチャイラテ',
            purchase_quantity: 1,
            purchase_unit_price: 216,
            line_total: 216,
            gross_line_amount: 216,
            effective_line_amount: 216,
            discount_allocated: 0,
            amount_provenance: 'ocr_observed',
            item_amount_evidence_state: 'coherent',
            price_observation_version: 1,
          },
        ],
      });
      expect(payload.persistedReceiptItems[0]?.purchaseQuantityOriginDetermination).toBe(
        'cannot_determine_from_index_row_alone'
      );
      expect(payload.quantityEvidence.receiptItemsIndex?.sourceIndex).toBe(2);
    });

    it('quantityEvidence has no firstStoredStageWhereQuantityIsOne', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: { name: 'tea', quantity: 1, lineTotal: 216 },
            }),
          }),
        }),
        persistedItemRows: [],
      });
      expect(payload).toHaveProperty('quantityEvidence');
      expect(payload).not.toHaveProperty('quantityChain');
      expect(
        (payload.quantityEvidence as Record<string, unknown>).firstStoredStageWhereQuantityIsOne
      ).toBeUndefined();
      const json = JSON.stringify(payload);
      expect(json).not.toContain('firstStoredStageWhereQuantityIsOne');
      expect(json).not.toContain('quantityChain');
    });
  });

  describe('PPH B1', () => {
    it('discounted fixture: derived gross unit follows gross/qty not indexed unit', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({ items: padItems(3, {}) }),
        }),
        persistedItemRows: [
          {
            source_index: 2,
            raw_name: '世界teaチャイラテ',
            purchase_quantity: 1,
            purchase_unit_price: 288,
            line_total: 288,
            gross_line_amount: 399,
            effective_line_amount: 288,
            discount_allocated: -111,
            amount_provenance: 'ocr_observed',
            item_amount_evidence_state: 'coherent',
            price_observation_version: 1,
          },
        ],
      });
      const idx = payload.pphDiagnostic.indexDerived;
      expect(idx.grossLineAmount).toBe(399);
      expect(payload.persistedReceiptItems[0]?.fields.effective_line_amount).toEqual(
        finiteQty(288)
      );
      expect(payload.persistedReceiptItems[0]?.fields.discount_allocated).toEqual(
        finiteQty(-111)
      );
      expect(idx.purchaseQuantity).toBe(1);
      expect(idx.purchaseUnitPriceStored).toBe(288);
      expect(idx.grossPurchaseUnitPriceDerived).toBe(399);
      expect(idx.qualityLevel).toBeNull();
      expect(idx.note).toBe('quality_not_persisted_in_sql_index_derived_only');
      expect(payload.pphDiagnostic.targetMerchantProductId).toBe(
        'mp_d3153e4f0c0bc8bb'
      );
    });
  });

  describe('EXISTING TARGETS', () => {
    it('auq target projects narrowly with bounded analysis items', () => {
      const ocrBlob = 'FULL OCR TEXT MUST NOT APPEAR '.repeat(20);
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        app: { version: '1.0.0', build: '110' },
        receipt: baseReceiptInput(TARGET_RECEIPT_EVIDENCE_RECEIPT_ID, {
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
        }),
        persistedItemRows: [],
      });

      expect(payload.targetReceiptId).toBe(TARGET_RECEIPT_EVIDENCE_RECEIPT_ID);
      expect(payload.targetKey).toBe('auq_poultry');
      expect(payload.receipt.found).toBe(true);
      expect(payload.analysis.items).toHaveLength(2);
      expect(payload.analysis.items.map((i) => i.arrayIndex)).toEqual([0, 1]);
      expect(
        payload.analysis.items.some(
          (i) => i.fields.name.kind === 'string' && i.fields.name.value === 'unrelated-item-2'
        )
      ).toBe(false);
      const json = JSON.stringify(payload);
      expect(json).not.toContain(ocrBlob.slice(0, 40));
      expect(json).not.toMatch(/"ocr_raw_text"\s*:/);
      assertTargetReceiptEvidenceJsonSafe(payload);
    });

    it('auq resolves same ids/indices and discounts export', () => {
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: baseReceiptInput(AUQ.receiptId, {
          analysis_json: analysisJson({
            items: [item0(), item1()],
            discounts: [
              { label: '割引 10%', amount: -38, adjacentPrecedingItemIndex: 0 },
              { label: '割引 10%', amount: -38, adjacentPrecedingItemIndex: 1 },
            ],
          }),
        }),
        persistedItemRows: [],
      });
      expect(payload.sourceIndices).toEqual([0, 1]);
      expect(payload.primarySourceIndex).toBe(0);
      expect(payload.analysis.discounts).toHaveLength(2);
      expect(payload.pphDiagnostic.targetMerchantProductId).toBeNull();
    });

    it('receipt063 resolves same ids/indices and loads via DB', async () => {
      expect(R063.sourceIndices).toEqual([8, 9]);
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

    it('receipt063 analysis items 8/9 projected with fields.lineTotal finite', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt063_seiyu_inline_markdown', {
        nowMs: NOW,
        receipt: baseReceiptInput(R063.receiptId, {
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
        }),
        persistedItemRows: [],
      });
      expect(payload.sourceIndices).toEqual([8, 9]);
      expect(payload.analysis.items.map((i) => i.arrayIndex)).toEqual([8, 9]);
      expect(payload.analysis.items[0]?.fields.lineTotal).toEqual(finiteQty(553));
      expect(payload.analysis.items.some((i) => i.arrayIndex === 0)).toBe(false);
    });

    it('receipt061 basic analysis projection with fields.quantity finite', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: {
                name: '世界teaチャイラテ',
                quantity: 1,
                unitPrice: 108,
                lineTotal: 216,
                discountAllocated: 0,
                effectiveLineTotal: 216,
              },
            }),
          }),
        }),
        persistedItemRows: [],
      });
      const primary = payload.analysis.items.find((i) => i.arrayIndex === 2)!;
      expect(primary.fields.quantity).toEqual(finiteQty(1));
      expect(primary.fields.unitPrice).toEqual(finiteQty(108));
      expect(primary.fields.lineTotal).toEqual(finiteQty(216));
      expect(payload.quantityEvidence.analysisPrimary?.fields.quantity).toEqual(
        finiteQty(1)
      );
    });

    it('missing receipt fails closed with found=false', () => {
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: null,
        persistedItemRows: [],
      });
      expect(payload.receipt.found).toBe(false);
      expect(payload.analysis.items.map((i) => i.arrayIndex)).toEqual([0, 1]);
      expect(payload.analysis.items.every((i) => i.fields.quantity.kind === 'absent')).toBe(
        true
      );
      expect(payload.recognition.jsonColumnState).toEqual({ kind: 'column_null' });
    });

    it('persisted receipt_items are raw DB values (no monetary recovery)', () => {
      const exportSource = fs.readFileSync(
        path.join(__dirname, 'targetReceiptEvidenceExport.ts'),
        'utf8'
      );
      expect(exportSource).not.toContain('resolveCurrentAnalysisItemMonetaryTruth');
      expect(exportSource).not.toContain('enrichProductRowsWithCurrentItemMonetaryTruth');
      expect(exportSource).not.toContain('buildPriceObservationTruth');

      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: baseReceiptInput(TARGET_RECEIPT_EVIDENCE_RECEIPT_ID, {
          analysis_json: analysisJson({ items: [item0(), item1()] }),
        }),
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
      expect(payload.persistedReceiptItems[0]?.fields.discount_allocated).toEqual({
        kind: 'null',
      });
      expect(payload.persistedReceiptItems[0]?.fields.gross_line_amount).toEqual({
        kind: 'null',
      });
    });

    it('recognition snapshot metadata without item row export', () => {
      const snap = {
        merchant: 'SEIYU',
        items: padItems(9, {
          8: { name: 'ブタカタブロック', quantity: 1, lineTotal: 553, kind: 'item' },
        }),
        discounts: [{ label: '値引', amount: -10 }],
        reconciliation: { ok: false, diff: 1, unexpectedBlob: 'NO' },
        ocr_raw_text: '値下（元 ¥651） SECRET OCR BLOB',
      };
      const payload = buildTargetReceiptEvidenceExport('receipt063_seiyu_inline_markdown', {
        nowMs: NOW,
        receipt: baseReceiptInput(R063.receiptId, {
          analysis_json: analysisJson({ items: padItems(9, {}) }),
          recognition_snapshot_json: JSON.stringify(snap),
        }),
        persistedItemRows: [],
      });
      expect(payload.recognition.jsonColumnState.kind).toBe('parseable');
      expect(payload.recognition.itemCount).toBe(10);
      expect(payload.recognition.items).toEqual([]);
      expect(payload.recognition.discounts).toHaveLength(1);
      expect(payload.recognition.reconciliation).toEqual({ ok: false, diff: 1 });
      expect(payload.recognition.unboundedTextFieldsOmitted).toBe(true);
      const json = JSON.stringify(payload);
      expect(json).not.toContain('SECRET OCR BLOB');
      assertTargetReceiptEvidenceJsonSafe(payload);
    });

    it('reconciliation allowlist privacy in analysis', () => {
      const payload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: baseReceiptInput(TARGET_RECEIPT_EVIDENCE_RECEIPT_ID, {
          analysis_json: analysisJson({
            items: [item0()],
            reconciliation: {
              ok: true,
              diff: 0,
              warnings: [{ ocrText: 'PRIVATE', secretNested: { x: 1 } }],
            },
          }),
        }),
        persistedItemRows: [],
      });
      expect(payload.analysis.reconciliation).toEqual({ ok: true, diff: 0 });
      const json = JSON.stringify(payload);
      expect(json).not.toContain('warnings');
      expect(json).not.toContain('PRIVATE');
    });

    it('user_items_json NULL distinguished from []', () => {
      const nullPayload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: baseReceiptInput(TARGET_RECEIPT_EVIDENCE_RECEIPT_ID, {
          analysis_json: analysisJson({ items: [item0()] }),
          user_items_json: null,
        }),
        persistedItemRows: [],
      });
      expect(nullPayload.receipt.userItemsJsonRawKind).toBe('null');

      const emptyPayload = buildTargetReceiptEvidenceExport('auq_poultry', {
        nowMs: NOW,
        receipt: baseReceiptInput(TARGET_RECEIPT_EVIDENCE_RECEIPT_ID, {
          analysis_json: analysisJson({ items: [item0()] }),
          user_items_json: '[]',
        }),
        persistedItemRows: [],
      });
      expect(emptyPayload.receipt.userItemsJsonRawKind).toBe('array');
      expect(emptyPayload.receipt.userItemsArrayLength).toBe(0);
    });
  });

  describe('ROUND3 ALIAS / INDEX VALUE FIDELITY', () => {
    it('gross/effective alias pairs stay independent on analysis items', () => {
      const onlySnake = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: {
                name: 'tea',
                quantity: 1,
                gross_line_amount: 399,
                effective_line_amount: 288,
              },
            }),
          }),
        }),
        persistedItemRows: [],
      });
      const snake = onlySnake.analysis.items.find((i) => i.arrayIndex === 2)!;
      expect(snake.fields.gross_line_amount).toEqual(finiteQty(399));
      expect(snake.fields.grossLineAmount).toEqual({ kind: 'absent' });
      expect(snake.fields.effective_line_amount).toEqual(finiteQty(288));
      expect(snake.fields.effectiveLineAmount).toEqual({ kind: 'absent' });

      const both = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: {
                name: 'tea',
                quantity: 1,
                grossLineAmount: 399,
                gross_line_amount: 400,
                effectiveLineAmount: 288,
                effective_line_amount: 289,
              },
            }),
          }),
        }),
        persistedItemRows: [],
      });
      const row = both.analysis.items.find((i) => i.arrayIndex === 2)!;
      expect(row.fields.grossLineAmount).toEqual(finiteQty(399));
      expect(row.fields.gross_line_amount).toEqual(finiteQty(400));
      expect(row.fields.effectiveLineAmount).toEqual(finiteQty(288));
      expect(row.fields.effective_line_amount).toEqual(finiteQty(289));
    });

    it('user_items and recognition neighborhood preserve unitPrice / unit_price independently', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: {
                name: 'tea',
                quantity: 1,
                review_source_index: 1,
              },
            }),
          }),
          user_items_json: JSON.stringify(
            padItems(3, {
              2: {
                name: 'tea',
                quantity: 1,
                unitPrice: 108,
                unit_price: 109,
              },
            })
          ),
          recognition_snapshot_json: JSON.stringify({
            items: padItems(2, {
              0: { name: 'pad', quantity: 1 },
              1: {
                name: '世界teaチャイラテ',
                quantity: 2,
                unitPrice: 108,
                unit_price: 110,
              },
              2: { name: 'after', quantity: 1 },
            }),
          }),
        }),
        persistedItemRows: [],
      });
      const user = payload.quantityEvidence.userItemsPrimary!;
      expect(user.fields.unitPrice).toEqual(finiteQty(108));
      expect(user.fields.unit_price).toEqual(finiteQty(109));
      const center = payload.quantityEvidence.recognitionMappedNeighborhood!.find(
        (i) => i.arrayIndex === 1
      )!;
      expect(center.fields.unitPrice).toEqual(finiteQty(108));
      expect(center.fields.unit_price).toEqual(finiteQty(110));
    });

    it('review_source_index value 5 is projected on analysis/user/receipt_items', () => {
      const payload = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: {
                name: 'tea',
                quantity: 1,
                review_source_index: 5,
              },
            }),
          }),
          user_items_json: JSON.stringify(
            padItems(3, {
              2: {
                name: 'tea',
                quantity: 1,
                review_source_index: 5,
              },
            })
          ),
          recognition_snapshot_json: JSON.stringify({
            items: padItems(6, {
              5: { name: '世界teaチャイラテ', quantity: 2 },
            }),
          }),
        }),
        persistedItemRows: [
          {
            source_index: 2,
            review_source_index: 5,
            raw_name: 'tea',
            purchase_quantity: 1,
            purchase_unit_price: 216,
            line_total: 216,
            gross_line_amount: 216,
            effective_line_amount: 216,
            discount_allocated: 0,
            amount_provenance: 'ocr_observed',
            item_amount_evidence_state: 'coherent',
            price_observation_version: 1,
          },
        ],
      });
      expect(
        payload.quantityEvidence.analysisPrimary?.fields.review_source_index
      ).toEqual(finiteQty(5));
      expect(
        payload.quantityEvidence.userItemsPrimary?.fields.review_source_index
      ).toEqual(finiteQty(5));
      expect(
        payload.persistedReceiptItems[0]?.fields.review_source_index
      ).toEqual(finiteQty(5));
      expect(payload.quantityEvidence.mapping.recognitionArrayIndex).toBe(5);

      const absent = buildTargetReceiptEvidenceExport('receipt061_aeon_quantity', {
        nowMs: NOW,
        receipt: baseReceiptInput(R061.receiptId, {
          analysis_json: analysisJson({
            items: padItems(3, {
              2: { name: 'tea', quantity: 1 },
            }),
          }),
        }),
        persistedItemRows: [
          {
            source_index: 2,
            review_source_index: null,
            raw_name: 'tea',
            purchase_quantity: 1,
            gross_line_amount: 216,
            effective_line_amount: 216,
            discount_allocated: 0,
            amount_provenance: 'ocr',
            item_amount_evidence_state: 'coherent',
            price_observation_version: 1,
          },
        ],
      });
      expect(
        absent.quantityEvidence.analysisPrimary?.fields.review_source_index
      ).toEqual({ kind: 'absent' });
      expect(absent.persistedReceiptItems[0]?.fields.review_source_index).toEqual({
        kind: 'null',
      });
    });
  });
});
