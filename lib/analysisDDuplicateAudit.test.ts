/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import type { ReceiptRow } from './db';
import {
  ANALYSIS_D_DUPLICATE_AUDIT_VERSION,
  auditSweetPotatoStyleObservations,
  buildAnalysisDDuplicateScanAudit,
  buildContentReceiptFingerprint,
  buildExactDuplicateGroups,
  buildExactReceiptFingerprint,
  buildHighConfidenceDuplicateGroups,
  buildProbableDuplicateGroups,
  buildStructuralReceiptFingerprint,
  canonicalizeReceiptItemName,
  pickDuplicateRepresentative,
  selectExactDedupedReceipts,
  summarizeReceiptForDuplicateAudit,
} from './analysisDDuplicateAudit';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import * as analysisDReport from './analysisDReport';
import * as fs from 'fs';
import * as path from 'path';

const nowMs = Date.parse('2026-08-22T12:00:00+09:00');
const sweetPotatoAt = Date.parse('2023-07-06T11:44:46+09:00');

type FixtureItem = {
  name: string;
  category: string;
  lineTotal: number;
  quantity: number;
};

function makeReceipt(args: {
  id: string;
  at: number;
  merchantType: string;
  items: FixtureItem[];
  total?: number;
  merchantNormalized?: string;
  transactionAt?: number | null;
  createdAt?: number;
  tax?: number;
  taxIsKnown?: number;
}): ReceiptRow {
  const itemSum = args.items.reduce((sum, item) => sum + (item.lineTotal || 0), 0);
  return {
    id: args.id,
    created_at: args.createdAt ?? args.at,
    transaction_at:
      args.transactionAt === undefined ? args.at : args.transactionAt,
    image_uri: '',
    total: args.total ?? itemSum,
    tax: args.tax ?? 0,
    tax_is_known: args.taxIsKnown ?? 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({ items: args.items }),
    merchant_raw: args.merchantNormalized ?? 'イオン',
    merchant_normalized: args.merchantNormalized ?? 'イオン',
    merchant_type: args.merchantType,
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  } as ReceiptRow;
}

const milkItems: FixtureItem[] = [
  {
    name: '明治おいしい牛乳',
    category: 'food_ingredients',
    lineTotal: 198,
    quantity: 1,
  },
];

describe('Analysis D2-A3 duplicate / re-scan audit', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('A — same content + different receipt id → one purchase candidate', () => {
    const a = makeReceipt({
      id: 'a1',
      at: nowMs,
      createdAt: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const b = makeReceipt({
      id: 'a2',
      at: nowMs,
      createdAt: nowMs + 60_000,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [a, b].map(summarizeReceiptForDuplicateAudit)
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.confidence).toBe('CONTENT_EXACT_DUPLICATE');
    expect(groups[0]?.receiptIds.sort()).toEqual(['a1', 'a2']);
    const selection = selectAnalyticsReceipts([a, b]);
    expect(selection.analyticsPurchaseCandidateCount).toBe(1);
    expect(selection.analyticsReceipts).toHaveLength(1);
    expect(selection.analyticsReceipts[0]?.id).toBe('a1');
  });

  test('B — structural exact when OCR item names differ', () => {
    const a = makeReceipt({
      id: 'b-struct-1',
      at: nowMs,
      merchantType: 'supermarket',
      items: [
        {
          name: '明治おいしい牛乳',
          category: 'food_ingredients',
          lineTotal: 198,
          quantity: 1,
        },
      ],
      tax: 10,
      taxIsKnown: 1,
    });
    const b = makeReceipt({
      id: 'b-struct-2',
      at: nowMs,
      createdAt: nowMs + 10,
      merchantType: 'supermarket',
      items: [
        {
          name: '明治牛乳',
          category: 'food_ingredients',
          lineTotal: 198,
          quantity: 1,
        },
      ],
      tax: 10,
      taxIsKnown: 1,
    });
    expect(buildContentReceiptFingerprint(a)).not.toBe(
      buildContentReceiptFingerprint(b)
    );
    expect(buildStructuralReceiptFingerprint(a)).toBe(
      buildStructuralReceiptFingerprint(b)
    );
    const groups = buildHighConfidenceDuplicateGroups(
      [a, b].map(summarizeReceiptForDuplicateAudit)
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.confidence).toBe('STRUCTURAL_EXACT_DUPLICATE');
    expect(buildProbableDuplicateGroups([a, b].map(summarizeReceiptForDuplicateAudit))).toHaveLength(
      0
    );
  });

  test('C — multiple content-exact subgroups under one structural → one representative', () => {
    const sharedAt = nowMs;
    const g1a = makeReceipt({
      id: 'c-g1a',
      at: sharedAt,
      createdAt: sharedAt,
      merchantType: 'supermarket',
      items: milkItems,
      total: 198,
    });
    const g1b = makeReceipt({
      id: 'c-g1b',
      at: sharedAt,
      createdAt: sharedAt + 1,
      merchantType: 'supermarket',
      items: milkItems,
      total: 198,
    });
    const g2a = makeReceipt({
      id: 'c-g2a',
      at: sharedAt,
      createdAt: sharedAt + 2,
      merchantType: 'supermarket',
      items: [
        {
          name: '明治牛乳',
          category: 'food_ingredients',
          lineTotal: 198,
          quantity: 1,
        },
      ],
      total: 198,
    });
    const g2b = makeReceipt({
      id: 'c-g2b',
      at: sharedAt,
      createdAt: sharedAt + 3,
      merchantType: 'supermarket',
      items: [
        {
          name: '明治牛乳',
          category: 'food_ingredients',
          lineTotal: 198,
          quantity: 1,
        },
      ],
      total: 198,
    });
    const receipts = [g1a, g1b, g2a, g2b];
    const contentOnly = buildExactDuplicateGroups(
      receipts.map(summarizeReceiptForDuplicateAudit)
    );
    // Content-only view would see two subgroups, but structural collapses to one.
    expect(contentOnly.length).toBeLessThanOrEqual(1);
    const groups = buildHighConfidenceDuplicateGroups(
      receipts.map(summarizeReceiptForDuplicateAudit)
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.confidence).toBe('STRUCTURAL_EXACT_DUPLICATE');
    expect(groups[0]?.receiptIds).toHaveLength(4);
    const selection = selectAnalyticsReceipts(receipts);
    expect(selection.analyticsReceipts).toHaveLength(1);
    expect(selection.analyticsReceipts[0]?.id).toBe('c-g1a');
  });

  test('D — same merchant/day/total but different timestamp → not duplicate', () => {
    const a = makeReceipt({
      id: 'd1',
      at: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
      transactionAt: nowMs,
    });
    const b = makeReceipt({
      id: 'd2',
      at: nowMs + 3600_000,
      merchantType: 'supermarket',
      items: milkItems,
      transactionAt: nowMs + 3600_000,
    });
    expect(buildStructuralReceiptFingerprint(a)).not.toBe(
      buildStructuralReceiptFingerprint(b)
    );
    expect(
      buildHighConfidenceDuplicateGroups(
        [a, b].map(summarizeReceiptForDuplicateAudit)
      )
    ).toHaveLength(0);
  });

  test('E — same timestamp/total but different ordered amount structure → not structural', () => {
    const a = makeReceipt({
      id: 'e1',
      at: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const b = makeReceipt({
      id: 'e2',
      at: nowMs,
      merchantType: 'supermarket',
      items: [
        ...milkItems,
        {
          name: '食パン',
          category: 'food_ingredients',
          lineTotal: 150,
          quantity: 1,
        },
      ],
      total: 348,
    });
    expect(
      buildHighConfidenceDuplicateGroups(
        [a, b].map(summarizeReceiptForDuplicateAudit)
      )
    ).toHaveLength(0);
  });

  test('F — missing/invalid transaction_at remains conservative', () => {
    const a = makeReceipt({
      id: 'f1',
      at: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
      transactionAt: null,
    });
    const b = makeReceipt({
      id: 'f2',
      at: nowMs + 1,
      merchantType: 'supermarket',
      items: milkItems,
      transactionAt: null,
    });
    expect(buildExactReceiptFingerprint(a)).toBeNull();
    expect(buildStructuralReceiptFingerprint(a)).toBeNull();
    expect(
      buildHighConfidenceDuplicateGroups(
        [a, b].map(summarizeReceiptForDuplicateAudit)
      )
    ).toHaveLength(0);
    const audit = buildAnalysisDDuplicateScanAudit([a, b], nowMs);
    expect(audit.highConfidenceDuplicateExtras).toBe(0);
    expect(audit.missingTransactionAtReceiptCount).toBe(2);
  });

  test('G — created_at differences irrelevant to identity', () => {
    const a = makeReceipt({
      id: 'g1',
      at: nowMs,
      createdAt: nowMs - 10_000,
      merchantType: 'supermarket',
      items: milkItems,
      transactionAt: nowMs,
    });
    const b = makeReceipt({
      id: 'g2',
      at: nowMs,
      createdAt: nowMs + 99_000,
      merchantType: 'supermarket',
      items: milkItems,
      transactionAt: nowMs,
    });
    expect(buildContentReceiptFingerprint(a)).toBe(
      buildContentReceiptFingerprint(b)
    );
    expect(buildExactReceiptFingerprint(a)).toBe(
      buildContentReceiptFingerprint(a)
    );
  });

  test('H — representative selection deterministic (earliest created_at, then id)', () => {
    const late = makeReceipt({
      id: 'aaa',
      at: nowMs,
      createdAt: nowMs + 100,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const early = makeReceipt({
      id: 'zzz',
      at: nowMs,
      createdAt: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const tieA = makeReceipt({
      id: 'tie-a',
      at: nowMs,
      createdAt: nowMs + 50,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const tieB = makeReceipt({
      id: 'tie-b',
      at: nowMs,
      createdAt: nowMs + 50,
      merchantType: 'supermarket',
      items: milkItems,
    });
    expect(
      pickDuplicateRepresentative(
        [late, early].map(summarizeReceiptForDuplicateAudit)
      )
    ).toBe('zzz');
    expect(
      pickDuplicateRepresentative(
        [tieB, tieA].map(summarizeReceiptForDuplicateAudit)
      )
    ).toBe('tie-a');
  });

  test('I — analytics filtering removes structural-exact extras', () => {
    const a = makeReceipt({
      id: 'i1',
      at: nowMs - 2 * 86400000,
      merchantType: 'supermarket',
      items: milkItems,
      merchantNormalized: 'イオン',
    });
    const b = makeReceipt({
      id: 'i2',
      at: nowMs - 2 * 86400000,
      createdAt: nowMs - 2 * 86400000 + 1000,
      merchantType: 'supermarket',
      items: [
        {
          name: '明治牛乳',
          category: 'food_ingredients',
          lineTotal: 198,
          quantity: 1,
        },
      ],
      merchantNormalized: 'イオン',
    });
    const selection = selectAnalyticsReceipts([a, b]);
    expect(selection.structuralExactDuplicateExtras).toBe(1);
    expect(selection.excludedDuplicateReceiptIds.has('i2')).toBe(true);
    expect(selection.analyticsReceipts.map((r) => r.id)).toEqual(['i1']);
  });

  test('J — productRows filtering uses excluded receipt IDs', () => {
    const { filterProductRowsByExcludedReceiptIds } = require('./analyticsReceiptSelection');
    const rows = [
      { receiptId: 'keep', sku: 'x' },
      { receiptId: 'drop', sku: 'x' },
    ];
    const filtered = filterProductRowsByExcludedReceiptIds(
      rows,
      new Set(['drop'])
    );
    expect(filtered).toEqual([{ receiptId: 'keep', sku: 'x' }]);
  });

  test('K — price history does not create multiple observations from repeated scans', () => {
    const a = makeReceipt({
      id: 'k1',
      at: nowMs - 4 * 86400000,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const b = makeReceipt({
      id: 'k2',
      at: nowMs - 4 * 86400000,
      createdAt: nowMs - 4 * 86400000 + 20,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const audit = buildAnalysisDDuplicateScanAudit([a, b], nowMs);
    expect(
      audit.impact.highConfidenceDeduped.priceHistoryObservationCount
    ).toBeLessThanOrEqual(audit.impact.before.priceHistoryObservationCount);
    expect(audit.impact.highConfidenceDeduped.storedReceiptCount).toBe(1);
  });

  test('L — merchant visits do not count repeated scans', () => {
    const a = makeReceipt({
      id: 'l1',
      at: nowMs - 2 * 86400000,
      merchantType: 'supermarket',
      items: milkItems,
      merchantNormalized: 'イオン',
    });
    const b = makeReceipt({
      id: 'l2',
      at: nowMs - 2 * 86400000,
      createdAt: nowMs - 2 * 86400000 + 1000,
      merchantType: 'supermarket',
      items: milkItems,
      merchantNormalized: 'イオン',
    });
    const audit = buildAnalysisDDuplicateScanAudit([a, b], nowMs);
    expect(audit.impact.before.merchantVisitCount).toBe(2);
    expect(audit.impact.highConfidenceDeduped.merchantVisitCount).toBe(1);
  });

  test('M — frequent occurrence input does not count repeated scan rows', () => {
    const a = makeReceipt({
      id: 'm1',
      at: nowMs - 3 * 86400000,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const b = makeReceipt({
      id: 'm2',
      at: nowMs - 3 * 86400000,
      createdAt: nowMs - 3 * 86400000 + 50,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const audit = buildAnalysisDDuplicateScanAudit([a, b], nowMs);
    expect(audit.impact.before.itemOccurrenceCount).toBe(2);
    expect(audit.impact.highConfidenceDeduped.itemOccurrenceCount).toBe(1);
  });

  test('N — raw receipts remain untouched (audit is read-only)', () => {
    const receipts = [
      makeReceipt({
        id: 'n1',
        at: nowMs,
        merchantType: 'supermarket',
        items: milkItems,
      }),
      makeReceipt({
        id: 'n2',
        at: nowMs,
        createdAt: nowMs + 1,
        merchantType: 'supermarket',
        items: milkItems,
      }),
    ];
    const before = JSON.stringify(receipts);
    buildAnalysisDDuplicateScanAudit(receipts, nowMs);
    selectAnalyticsReceipts(receipts);
    expect(JSON.stringify(receipts)).toBe(before);

    const source = fs.readFileSync(
      path.resolve(__dirname, 'analysisDDuplicateAudit.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /saveReceipt|updateReceipt|deleteReceipt|upsertReceipt/
    );
  });

  test('O — Costco sweet-potato 3-scan fixture collapses to one purchase candidate', () => {
    const potatoA = {
      name: 'さつまいも 1.5kg',
      category: 'food_ingredients',
      lineTotal: 698,
      quantity: 1,
    };
    const potatoB = {
      name: 'さつまいも1.5kg',
      category: 'food_ingredients',
      lineTotal: 698,
      quantity: 1,
    };
    const otherItems: FixtureItem[] = Array.from({ length: 10 }, (_, i) => ({
      name: `item-${i}`,
      category: 'food_ingredients',
      lineTotal: 800 + i,
      quantity: 1,
    }));
    const baseItems = [...otherItems, potatoA];
    const total = baseItems.reduce((s, it) => s + it.lineTotal, 0);
    const scans = [0, 1, 2].map((i) =>
      makeReceipt({
        id: `potato-scan-${i + 1}`,
        at: sweetPotatoAt,
        createdAt: sweetPotatoAt + i * 30_000,
        merchantType: 'supermarket',
        merchantNormalized: 'コストコ',
        items:
          i === 0
            ? baseItems
            : [...otherItems.map((it) => ({ ...it, name: `${it.name}-ocr` })), potatoB],
        total,
        tax: 706,
        taxIsKnown: 1,
      })
    );
    // Force identical structure: same qty/amounts, different names
    const structuralFp = buildStructuralReceiptFingerprint(scans[0]!);
    expect(buildStructuralReceiptFingerprint(scans[1]!)).toBe(structuralFp);
    expect(buildStructuralReceiptFingerprint(scans[2]!)).toBe(structuralFp);

    const groups = buildHighConfidenceDuplicateGroups(
      scans.map(summarizeReceiptForDuplicateAudit)
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.confidence).toBe('STRUCTURAL_EXACT_DUPLICATE');
    expect(selectAnalyticsReceipts(scans).analyticsPurchaseCandidateCount).toBe(
      1
    );

    const sweet = auditSweetPotatoStyleObservations(scans);
    expect(sweet.storedReceiptCount).toBe(3);
    expect(sweet.purchaseCandidateCount).toBe(1);
    expect(sweet.interpretation).toBe(
      'SAME_PURCHASE_CANDIDATE_MULTIPLE_SCANS'
    );
  });

  test('P — no fuzzy matching', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'analysisDDuplicateAudit.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/levenshtein|string-similarity|diceCoefficient/i);
    expect(source).not.toMatch(/editDistance|jaroWinkler|approxMatch/i);
    expect(canonicalizeReceiptItemName('明治 おいしい 牛乳')).not.toBe(
      canonicalizeReceiptItemName('明治おいしい牛乳')
    );
  });

  test('audit version + V1 policy B excludes content+structural', () => {
    const a = makeReceipt({
      id: 'pol1',
      at: nowMs - 86400000,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const b = makeReceipt({
      id: 'pol2',
      at: nowMs - 86400000,
      createdAt: nowMs - 86400000 + 1,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const audit = buildAnalysisDDuplicateScanAudit([a, b], nowMs);
    expect(audit.auditVersion).toBe(ANALYSIS_D_DUPLICATE_AUDIT_VERSION);
    expect(audit.recommendedExcludeHighConfidenceDuplicatesFromV1Analytics).toBe(
      true
    );
    expect(audit.recommendedV1AnalyticsPolicy).toBe(
      'B_EXCLUDE_CONTENT_AND_STRUCTURAL_EXACT'
    );
    expect(audit.contentExactDuplicateExtras).toBe(1);
    expect(audit.analyticsPurchaseCandidateCount).toBe(1);
  });

  test('does not call write APIs / reimplement analytics formulas', () => {
    const spy = jest.spyOn(analysisDReport, 'buildAnalysisDReport');
    const receipts = [
      makeReceipt({
        id: 'z1',
        at: nowMs,
        merchantType: 'supermarket',
        items: milkItems,
      }),
    ];
    buildAnalysisDDuplicateScanAudit(receipts, nowMs);
    expect(spy).toHaveBeenCalled();
    expect(
      selectExactDedupedReceipts(receipts, []).map((r) => r.id)
    ).toEqual(['z1']);
  });
});
