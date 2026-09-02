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
  pickReconciledDuplicateRepresentative,
  evaluateReconciledStructuralExactPair,
  evaluateSemanticRescanExactPair,
  areSemanticRescanItemNamesCompatible,
  hasExactTransactionTime,
  hasValidTransactionAt,
  selectExactDedupedReceipts,
  summarizeReceiptForDuplicateAudit,
  ANALYSIS_D_KNOWN_COSTCO_9534_FORENSIC_TARGET_RECEIPT_IDS,
  auditKnownStructuralCostco9534Case,
} from './analysisDDuplicateAudit';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { buildCanonicalReceiptGroups } from './analysisFoundation/canonicalReceipt';
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
  merchant_product_id?: string;
  canonical_product_id?: string;
  identity_source?: string;
  identity_confidence?: number;
  normalized_full_name?: string;
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
  userEdited?: number;
  note?: string | null;
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
    user_edited: args.userEdited ?? 0,
    final_total: null,
    final_category: null,
    note: args.note ?? null,
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




describe('D2-E3 RECONCILED_STRUCTURAL_EXACT_DUPLICATE', () => {
  const txAt = 1688611486000; // 2023-07-06 11:44:46+09:00

  const costcoCoreItems: FixtureItem[] = [
    { name: 'A', category: 'other', lineTotal: 418, quantity: 1 },
    { name: 'B', category: 'other', lineTotal: 698, quantity: 1 },
    { name: 'C', category: 'other', lineTotal: 428, quantity: 1 },
    { name: 'D', category: 'other', lineTotal: 899, quantity: 1 },
    { name: 'E', category: 'other', lineTotal: 488, quantity: 1 },
    { name: 'F', category: 'other', lineTotal: 298, quantity: 1 },
    { name: 'G', category: 'other', lineTotal: 998, quantity: 1 },
    { name: 'H', category: 'other', lineTotal: 698, quantity: 1 },
    { name: 'I', category: 'other', lineTotal: 777, quantity: 1 },
    { name: 'J', category: 'other', lineTotal: 3484, quantity: 1 },
    { name: 'K', category: 'other', lineTotal: 348, quantity: 1 },
  ];

  const trailingArtifacts: FixtureItem[] = [
    { name: 'コストコ コネクション', category: 'other', lineTotal: 1, quantity: 1 },
    { name: 'コストコ コネクション ムリョウ', category: 'other', lineTotal: 1, quantity: 1 },
  ];

  function cleanCostco(id: string, createdAt: number, nameSuffix = '') {
    return makeReceipt({
      id,
      at: txAt,
      createdAt,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      transactionAt: txAt,
      total: 9534,
      tax: 706,
      taxIsKnown: 1,
      items: costcoCoreItems.map((it, idx) => ({
        ...it,
        name: `${it.name}${nameSuffix}${idx}`,
      })),
    });
  }

  function noisyCostco(id: string, createdAt: number, tax = 708) {
    return makeReceipt({
      id,
      at: txAt,
      createdAt,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      transactionAt: txAt,
      total: 9534,
      tax,
      taxIsKnown: 1,
      items: [
        ...costcoCoreItems.map((it, idx) => ({
          ...it,
          name: `${it.name}_n${idx}`,
        })),
        ...trailingArtifacts,
      ],
    });
  }

  test('A — four-scan Costco fixture collapses to 1 candidate', () => {
    const receipts = [
      cleanCostco('2bDvMWs3dkCKagyrYWyxA', 2000),
      noisyCostco('C_aMA69ijcqNLhGI76Y5Q', 1000),
      cleanCostco('n6_vGM5c8X255Psyiup4k', 3000, '_b'),
      cleanCostco('NEHGZCkqd8MiBCyKO-fWd', 4000, '_c'),
    ];
    const selection = selectAnalyticsReceipts(receipts);
    expect(selection.analyticsPurchaseCandidateCount).toBe(1);
    expect(selection.excludedDuplicateReceiptIds.size).toBe(3);
    expect(selection.analyticsReceipts).toHaveLength(1);
    expect(selection.analyticsReceipts[0]!.id).not.toBe('C_aMA69ijcqNLhGI76Y5Q');

    const known = auditKnownStructuralCostco9534Case(receipts)!;
    expect(known.storedScanCount).toBe(4);
    expect(known.purchaseCandidateCount).toBe(1);
    expect(known.reconciledConfidence).toBe(
      'RECONCILED_STRUCTURAL_EXACT_DUPLICATE'
    );
    expect(known.reconciledEvidence?.noisyReceiptIds).toEqual(
      expect.arrayContaining(['C_aMA69ijcqNLhGI76Y5Q'])
    );
  });

  test('B — 11-row exact core + 2 trailing artifacts is high confidence', () => {
    const clean = cleanCostco('clean', 2000);
    const noisy = noisyCostco('noisy', 1000);
    const link = evaluateReconciledStructuralExactPair(
      summarizeReceiptForDuplicateAudit(clean),
      summarizeReceiptForDuplicateAudit(noisy)
    );
    expect(link).not.toBeNull();
    expect(link!.trailingExtraCount).toBe(2);
    expect(link!.overage).toBe(2);
    expect(link!.taxDelta).toBe(2);

    const groups = buildHighConfidenceDuplicateGroups(
      [clean, noisy].map(summarizeReceiptForDuplicateAudit)
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.confidence).toBe(
      'RECONCILED_STRUCTURAL_EXACT_DUPLICATE'
    );
  });

  test('C — clean wins representative even when noisy has earlier createdAt', () => {
    const clean = cleanCostco('clean-late', 9000);
    const noisy = noisyCostco('noisy-early', 1000);
    const summaries = [clean, noisy].map(summarizeReceiptForDuplicateAudit);
    const groups = buildHighConfidenceDuplicateGroups(summaries, [clean, noisy]);
    expect(groups[0]!.representativeReceiptId).toBe('clean-late');
    expect(pickReconciledDuplicateRepresentative(summaries)).toBe('clean-late');
  });

  test('D — same merchant/day/total alone does not merge', () => {
    const sameDayDifferentItems = [
      makeReceipt({
        id: 'd3',
        at: txAt,
        merchantType: 'supermarket',
        merchantNormalized: 'コストコ',
        transactionAt: txAt + 1000,
        total: 9534,
        taxIsKnown: 0,
        items: [
          { name: 'P1', category: 'other', lineTotal: 5000, quantity: 1 },
          { name: 'P2', category: 'other', lineTotal: 4534, quantity: 1 },
        ],
      }),
      makeReceipt({
        id: 'd4',
        at: txAt,
        createdAt: txAt + 2,
        merchantType: 'supermarket',
        merchantNormalized: 'コストコ',
        transactionAt: txAt + 2000,
        total: 9534,
        taxIsKnown: 0,
        items: [
          { name: 'Q1', category: 'other', lineTotal: 4000, quantity: 1 },
          { name: 'Q2', category: 'other', lineTotal: 5534, quantity: 1 },
        ],
      }),
    ];
    expect(
      buildHighConfidenceDuplicateGroups(
        sameDayDifferentItems.map(summarizeReceiptForDuplicateAudit)
      )
    ).toHaveLength(0);
    expect(
      selectAnalyticsReceipts(sameDayDifferentItems)
        .analyticsPurchaseCandidateCount
    ).toBe(2);
  });

  test('E — same merchant/exact timestamp/total with different item vectors does not merge', () => {
    const a = makeReceipt({
      id: 'e1',
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      transactionAt: txAt,
      total: 9534,
      tax: 706,
      taxIsKnown: 1,
      items: costcoCoreItems,
    });
    const b = makeReceipt({
      id: 'e2',
      at: txAt,
      createdAt: txAt + 1,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      transactionAt: txAt,
      total: 9534,
      tax: 706,
      taxIsKnown: 1,
      items: [
        ...costcoCoreItems.slice(0, 10),
        { name: 'DIFF', category: 'other', lineTotal: 349, quantity: 1 },
      ],
    });
    expect(
      evaluateReconciledStructuralExactPair(
        summarizeReceiptForDuplicateAudit(a),
        summarizeReceiptForDuplicateAudit(b)
      )
    ).toBeNull();
    expect(
      buildHighConfidenceDuplicateGroups(
        [a, b].map(summarizeReceiptForDuplicateAudit)
      )
    ).toHaveLength(0);
  });

  test('F — prefix without exact total reconciliation does not merge', () => {
    const coreBad = makeReceipt({
      id: 'f3',
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      transactionAt: txAt,
      total: 1000,
      taxIsKnown: 0,
      items: [
        { name: 'A', category: 'other', lineTotal: 400, quantity: 1 },
        { name: 'B', category: 'other', lineTotal: 500, quantity: 1 },
      ],
    });
    const longer2 = makeReceipt({
      id: 'f4',
      at: txAt,
      createdAt: txAt + 1,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      transactionAt: txAt,
      total: 1000,
      taxIsKnown: 0,
      items: [
        { name: 'A', category: 'other', lineTotal: 400, quantity: 1 },
        { name: 'B', category: 'other', lineTotal: 500, quantity: 1 },
        { name: 'TRAIL', category: 'other', lineTotal: 100, quantity: 1 },
      ],
    });
    expect(
      evaluateReconciledStructuralExactPair(
        summarizeReceiptForDuplicateAudit(coreBad),
        summarizeReceiptForDuplicateAudit(longer2)
      )
    ).toBeNull();
  });

  test('G — trailing amount that does not exactly explain overage does not merge', () => {
    const core = makeReceipt({
      id: 'g1',
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      transactionAt: txAt,
      total: 1000,
      taxIsKnown: 0,
      items: [
        { name: 'A', category: 'other', lineTotal: 400, quantity: 1 },
        { name: 'B', category: 'other', lineTotal: 599, quantity: 1 },
      ],
    });
    const noisy = makeReceipt({
      id: 'g2',
      at: txAt,
      createdAt: txAt + 1,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      transactionAt: txAt,
      total: 1000,
      taxIsKnown: 0,
      items: [
        { name: 'A', category: 'other', lineTotal: 400, quantity: 1 },
        { name: 'B', category: 'other', lineTotal: 599, quantity: 1 },
        { name: 'TRAIL', category: 'other', lineTotal: 5, quantity: 1 },
      ],
    });
    expect(
      evaluateReconciledStructuralExactPair(
        summarizeReceiptForDuplicateAudit(core),
        summarizeReceiptForDuplicateAudit(noisy)
      )
    ).toBeNull();
  });

  test('H — known tax mismatch outside safe relation does not merge', () => {
    const clean = cleanCostco('h1', 2000);
    const noisy = noisyCostco('h2', 1000, 800);
    expect(
      evaluateReconciledStructuralExactPair(
        summarizeReceiptForDuplicateAudit(clean),
        summarizeReceiptForDuplicateAudit(noisy)
      )
    ).toBeNull();
  });

  test('I — different transaction_at does not merge', () => {
    const clean = cleanCostco('i1', 2000);
    const noisy = makeReceipt({
      id: 'i2',
      at: txAt,
      createdAt: 1000,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      transactionAt: txAt + 1000,
      total: 9534,
      tax: 708,
      taxIsKnown: 1,
      items: [...costcoCoreItems, ...trailingArtifacts],
    });
    expect(
      evaluateReconciledStructuralExactPair(
        summarizeReceiptForDuplicateAudit(clean),
        summarizeReceiptForDuplicateAudit(noisy)
      )
    ).toBeNull();
  });

  test('J — no fuzzy/name similarity participates', () => {
    const auditSrc = fs.readFileSync(
      path.join(__dirname, 'analysisDDuplicateAudit.ts'),
      'utf8'
    );
    expect(auditSrc).not.toMatch(
      /levenshtein|stringSimilarity|fuse\.js|cosine|embedding/i
    );
    const clean = cleanCostco('j1', 2000);
    const noisy = noisyCostco('j2', 1000);
    expect(
      evaluateReconciledStructuralExactPair(
        summarizeReceiptForDuplicateAudit(clean),
        summarizeReceiptForDuplicateAudit(noisy)
      )
    ).not.toBeNull();
  });

  test('K — existing CONTENT_EXACT behavior unchanged', () => {
    const a = makeReceipt({
      id: 'k1',
      at: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
      createdAt: nowMs,
    });
    const b = makeReceipt({
      id: 'k2',
      at: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
      createdAt: nowMs + 1,
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [a, b].map(summarizeReceiptForDuplicateAudit)
    );
    expect(groups[0]!.confidence).toBe('CONTENT_EXACT_DUPLICATE');
  });

  test('L — existing STRUCTURAL_EXACT behavior unchanged', () => {
    const a = makeReceipt({
      id: 'l1',
      at: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
      createdAt: nowMs,
    });
    const b = makeReceipt({
      id: 'l2',
      at: nowMs,
      merchantType: 'supermarket',
      items: [{ ...milkItems[0]!, name: '明治おいしい牛乳（別名）' }],
      createdAt: nowMs + 1,
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [a, b].map(summarizeReceiptForDuplicateAudit)
    );
    expect(groups[0]!.confidence).toBe('STRUCTURAL_EXACT_DUPLICATE');
  });

  test('M — selection is read-only on stored receipts (History consumer projects separately)', () => {
    const receipts = [
      cleanCostco('2bDvMWs3dkCKagyrYWyxA', 2000),
      noisyCostco('C_aMA69ijcqNLhGI76Y5Q', 1000),
      cleanCostco('n6_vGM5c8X255Psyiup4k', 3000, '_b'),
      cleanCostco('NEHGZCkqd8MiBCyKO-fWd', 4000, '_c'),
    ];
    const before = JSON.stringify(receipts);
    const selection = selectAnalyticsReceipts(receipts);
    expect(selection.storedReceipts).toHaveLength(4);
    expect(receipts.map((r) => r.id).sort()).toEqual(
      selection.storedReceipts.map((r) => r.id).sort()
    );
    expect(JSON.stringify(receipts)).toBe(before);
    expect(selection.analyticsPurchaseCandidateCount).toBe(1);
  });

  test('N — category conservation gap remains 0 after reconciled selection', () => {
    const receipts = [
      cleanCostco('2bDvMWs3dkCKagyrYWyxA', 2000),
      noisyCostco('C_aMA69ijcqNLhGI76Y5Q', 1000),
      cleanCostco('n6_vGM5c8X255Psyiup4k', 3000, '_b'),
      cleanCostco('NEHGZCkqd8MiBCyKO-fWd', 4000, '_c'),
    ];
    const selection = selectAnalyticsReceipts(receipts);
    const report = analysisDReport.buildAnalysisDReport({
      receipts: selection.analyticsReceipts,
      nowMs: txAt + 86400000 * 400,
    });
    const categoryAll =
      report.categoryValue.find((w) => w.window === 'all') ?? null;
    const composition = categoryAll?.categoryCompositionTotal ?? 0;
    const activeSum = (categoryAll?.categories ?? []).reduce(
      (sum, c) => sum + (c.amount ?? 0),
      0
    );
    expect(composition - activeSum).toBe(0);
  });

  test('O — Home/Analysis/History production parity (single selection boundary)', () => {
    const srcHome = fs.readFileSync(
      path.join(__dirname, '..', 'app', '(tabs)', 'index.tsx'),
      'utf8'
    );
    const srcAnalysis = fs.readFileSync(
      path.join(__dirname, '..', 'app', '(tabs)', 'analysis.tsx'),
      'utf8'
    );
    const srcHistory = fs.readFileSync(
      path.join(__dirname, '..', 'app', '(tabs)', 'history', 'index.tsx'),
      'utf8'
    );
    expect(srcHome).toContain('selectAnalyticsReceipts');
    expect(srcAnalysis).toContain('selectAnalyticsReceipts');
    expect(srcHistory).toContain('buildHistoryPurchaseTruthView');
    expect(srcHistory).toContain('resolveHistoryPurchaseDeleteIds');
    expect(srcHistory).toContain('listAllReceiptsForCurrentOwnerPurchaseTruth');
  });

  test('P — price observation / occurrence counts use selected receipt IDs only', () => {
    const receipts = [
      cleanCostco('2bDvMWs3dkCKagyrYWyxA', 2000),
      noisyCostco('C_aMA69ijcqNLhGI76Y5Q', 1000),
      cleanCostco('n6_vGM5c8X255Psyiup4k', 3000, '_b'),
      cleanCostco('NEHGZCkqd8MiBCyKO-fWd', 4000, '_c'),
    ];
    const selection = selectAnalyticsReceipts(receipts);
    expect(selection.excludedDuplicateReceiptIds.has('C_aMA69ijcqNLhGI76Y5Q')).toBe(
      true
    );
    const selectedIds = new Set(selection.analyticsReceipts.map((r) => r.id));
    expect(selectedIds.has('C_aMA69ijcqNLhGI76Y5Q')).toBe(false);
    expect(selectedIds.size).toBe(1);
  });
});

describe('A1.3 SEMANTIC_RESCAN_EXACT_DUPLICATE', () => {
  const txAt = Date.parse('2024-08-15T18:42:11+09:00');

  function semanticPair(args: {
    idA: string;
    idB: string;
    itemsA: FixtureItem[];
    itemsB: FixtureItem[];
    total: number;
    taxA?: number;
    taxKnownA?: number;
    taxB?: number;
    taxKnownB?: number;
    transactionAtA?: number | null;
    transactionAtB?: number | null;
    createdAtA?: number;
    createdAtB?: number;
  }) {
    const a = makeReceipt({
      id: args.idA,
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: args.itemsA,
      total: args.total,
      tax: args.taxA ?? 0,
      taxIsKnown: args.taxKnownA ?? 0,
      transactionAt: args.transactionAtA === undefined ? txAt : args.transactionAtA,
      createdAt: args.createdAtA ?? txAt,
    });
    const b = makeReceipt({
      id: args.idB,
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: args.itemsB,
      total: args.total,
      tax: args.taxB ?? 330,
      taxIsKnown: args.taxKnownB ?? 1,
      transactionAt: args.transactionAtB === undefined ? txAt : args.transactionAtB,
      createdAt: args.createdAtB ?? txAt + 5000,
    });
    return { a, b };
  }

  test('A: same merchant/time/total but different ordered line amounts => not merged', () => {
    const { a, b } = semanticPair({
      idA: 'a-line',
      idB: 'b-line',
      total: 500,
      itemsA: [
        { name: 'Product A', category: 'other', lineTotal: 200, quantity: 1 },
        { name: 'Product B', category: 'other', lineTotal: 300, quantity: 1 },
      ],
      itemsB: [
        { name: 'Product A', category: 'other', lineTotal: 250, quantity: 1 },
        { name: 'Product B', category: 'other', lineTotal: 250, quantity: 1 },
      ],
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [a, b].map(summarizeReceiptForDuplicateAudit)
    );
    expect(groups).toHaveLength(0);
  });

  test('B: same amounts but clearly different item names => not merged', () => {
    const { a, b } = semanticPair({
      idA: 'a-name',
      idB: 'b-name',
      total: 794,
      itemsA: [
        { name: 'Product A', category: 'other', lineTotal: 794, quantity: 1 },
      ],
      itemsB: [
        { name: 'Product B', category: 'other', lineTotal: 794, quantity: 2 },
      ],
    });
    expect(
      evaluateSemanticRescanExactPair(
        summarizeReceiptForDuplicateAudit(a),
        summarizeReceiptForDuplicateAudit(b)
      )
    ).toBeNull();
    expect(
      buildHighConfidenceDuplicateGroups(
        [a, b].map(summarizeReceiptForDuplicateAudit)
      )
    ).toHaveLength(0);
  });

  test('C: both tax known but tax differs => reject semantic path', () => {
    const { a, b } = semanticPair({
      idA: 'a-tax',
      idB: 'b-tax',
      total: 794,
      taxA: 100,
      taxKnownA: 1,
      taxB: 200,
      taxKnownB: 1,
      itemsA: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
      ],
      itemsB: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
      ],
    });
    expect(
      evaluateSemanticRescanExactPair(
        summarizeReceiptForDuplicateAudit(a),
        summarizeReceiptForDuplicateAudit(b)
      )
    ).toBeNull();
  });

  test('D: missing transaction time => not merged', () => {
    const { a, b } = semanticPair({
      idA: 'a-notime',
      idB: 'b-notime',
      total: 794,
      transactionAtA: null,
      transactionAtB: null,
      itemsA: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
      ],
      itemsB: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
      ],
    });
    expect(
      buildHighConfidenceDuplicateGroups(
        [a, b].map(summarizeReceiptForDuplicateAudit)
      )
    ).toHaveLength(0);
  });

  test('E: date-only midnight => not semantic rescan path', () => {
    const dateOnly = Date.parse('2024-08-15T00:00:00+09:00');
    const { a, b } = semanticPair({
      idA: 'a-date',
      idB: 'b-date',
      total: 794,
      transactionAtA: dateOnly,
      transactionAtB: dateOnly,
      itemsA: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
      ],
      itemsB: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
      ],
    });
    expect(
      evaluateSemanticRescanExactPair(
        summarizeReceiptForDuplicateAudit(a),
        summarizeReceiptForDuplicateAudit(b)
      )
    ).toBeNull();
  });

  test('F: same names, quantity differs, line amounts same => reconcile', () => {
    const { a, b } = semanticPair({
      idA: 'a-qty',
      idB: 'b-qty',
      total: 794,
      itemsA: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
      ],
      itemsB: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
      ],
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [a, b].map(summarizeReceiptForDuplicateAudit)
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.confidence).toBe('SEMANTIC_RESCAN_EXACT_DUPLICATE');
    expect(groups[0]!.receiptIds.sort()).toEqual(['a-qty', 'b-qty']);
    expect(groups[0]!.semanticRescanEvidence!.quantityConflicts).toEqual([
      expect.objectContaining({
        leftReceiptId: 'a-qty',
        rightReceiptId: 'b-qty',
        itemIndex: 0,
        leftQuantity: 1,
        rightQuantity: 2,
        lineAmount: 794,
      }),
    ]);
  });

  test('G: name differs only by pack/count structural suffix => reconcile', () => {
    expect(
      areSemanticRescanItemNamesCompatible(
        canonicalizeReceiptItemName('Product A'),
        canonicalizeReceiptItemName('Product A 4個')
      ).compatible
    ).toBe(true);
    const { a, b } = semanticPair({
      idA: 'a-pack',
      idB: 'b-pack',
      total: 393,
      itemsA: [
        { name: 'Product A', category: 'other', lineTotal: 393, quantity: 4 },
      ],
      itemsB: [
        {
          name: 'Product A 4個',
          category: 'other',
          lineTotal: 393,
          quantity: 1,
        },
      ],
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [a, b].map(summarizeReceiptForDuplicateAudit)
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.confidence).toBe('SEMANTIC_RESCAN_EXACT_DUPLICATE');
  });

  test('H: input order reverse => identical grouping / evidence', () => {
    const { a, b } = semanticPair({
      idA: 'a-ord',
      idB: 'b-ord',
      total: 794,
      itemsA: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
      ],
      itemsB: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
      ],
    });
    const g1 = buildHighConfidenceDuplicateGroups(
      [a, b].map(summarizeReceiptForDuplicateAudit)
    );
    const g2 = buildHighConfidenceDuplicateGroups(
      [b, a].map(summarizeReceiptForDuplicateAudit)
    );
    expect(g1[0]!.fingerprint).toBe(g2[0]!.fingerprint);
    expect(g1[0]!.receiptIds).toEqual(g2[0]!.receiptIds);
    expect(g1[0]!.differenceEvidence).toEqual(g2[0]!.differenceEvidence);
    expect(g1[0]!.semanticRescanEvidence!.quantityConflicts).toEqual(
      g2[0]!.semanticRescanEvidence!.quantityConflicts
    );
  });

  test('I: 3 scans (2 semantic + 1 exact variant) => one canonical group', () => {
    const itemsA: FixtureItem[] = [
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
    ];
    const itemsB: FixtureItem[] = [
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
    ];
    const a = makeReceipt({
      id: 'scan-a',
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: itemsA,
      total: 794,
      taxIsKnown: 0,
      createdAt: txAt,
    });
    const b = makeReceipt({
      id: 'scan-b',
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: itemsB,
      total: 794,
      tax: 60,
      taxIsKnown: 1,
      createdAt: txAt + 1000,
    });
    // Exact structural/content clone of A (same qty interpretation)
    const c = makeReceipt({
      id: 'scan-c',
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: itemsA,
      total: 794,
      taxIsKnown: 0,
      createdAt: txAt + 2000,
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [a, b, c].map(summarizeReceiptForDuplicateAudit)
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.receiptIds.sort()).toEqual([
      'scan-a',
      'scan-b',
      'scan-c',
    ]);
    expect(groups[0]!.confidence).toBe('SEMANTIC_RESCAN_EXACT_DUPLICATE');
  });

  test('J: different transaction_at => distinct physical events', () => {
    const { a, b } = semanticPair({
      idA: 'a-time',
      idB: 'b-time',
      total: 794,
      transactionAtA: txAt,
      transactionAtB: txAt + 60_000,
      itemsA: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
      ],
      itemsB: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
      ],
    });
    expect(
      buildHighConfidenceDuplicateGroups(
        [a, b].map(summarizeReceiptForDuplicateAudit)
      )
    ).toHaveLength(0);
  });

  test('022 synthetic: 12-line receipt with qty/spec/tax disagreement => 1 group', () => {
    // total 4287 = 2707 front + 393 + 393 + 794
    const frontTarget = 2707;
    const frontItems: FixtureItem[] = Array.from({ length: 9 }, (_, i) => ({
      name: `Shared Item ${i + 1}`,
      category: 'other',
      lineTotal: i < 8 ? 300 : frontTarget - 300 * 8,
      quantity: 1,
    }));
    const receiptAItems: FixtureItem[] = [
      ...frontItems,
      { name: 'Battery AA', category: 'other', lineTotal: 393, quantity: 4 },
      { name: 'Battery AAA', category: 'other', lineTotal: 393, quantity: 4 },
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
    ];
    const receiptBItems: FixtureItem[] = [
      ...frontItems,
      {
        name: 'Battery AA 4-count',
        category: 'other',
        lineTotal: 393,
        quantity: 1,
      },
      {
        name: 'Battery AAA 4-count',
        category: 'other',
        lineTotal: 393,
        quantity: 1,
      },
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
    ];
    expect(receiptAItems.reduce((s, it) => s + it.lineTotal, 0)).toBe(4287);
    const a = makeReceipt({
      id: '022-a',
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: receiptAItems,
      total: 4287,
      taxIsKnown: 0,
      createdAt: txAt,
    });
    const b = makeReceipt({
      id: '022-b',
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: receiptBItems,
      total: 4287,
      tax: 330,
      taxIsKnown: 1,
      createdAt: txAt + 10_000,
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [a, b].map(summarizeReceiptForDuplicateAudit),
      [a, b]
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.confidence).toBe('SEMANTIC_RESCAN_EXACT_DUPLICATE');
    expect(groups[0]!.receiptIds.sort()).toEqual(['022-a', '022-b']);
    expect(groups[0]!.representativeReceiptId).toBe('022-b');
    expect(
      groups[0]!.semanticRescanEvidence!.quantityConflicts.length
    ).toBeGreaterThanOrEqual(3);
    expect(
      groups[0]!.relationEvidence.find(
        (r) => r.path === 'SEMANTIC_RESCAN_EXACT_DUPLICATE'
      )?.semanticRescanEvidence?.taxCompatibility
    ).toBe('one_known_one_unknown');

    const selection = selectAnalyticsReceipts([a, b]);
    expect(selection.analyticsReceipts.map((r) => r.id)).toEqual(['022-b']);
  });
});

describe('A1.3.1 Safe Semantic Rescan Grouping', () => {
  const txAt = Date.parse('2024-08-15T18:42:11+09:00');

  function baseReceipt(
    id: string,
    opts: {
      tax?: number;
      taxIsKnown?: number;
      items: FixtureItem[];
      total: number;
      createdAt?: number;
      transactionAt?: number | null;
    }
  ): ReceiptRow {
    return makeReceipt({
      id,
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: opts.items,
      total: opts.total,
      tax: opts.tax ?? 0,
      taxIsKnown: opts.taxIsKnown ?? 0,
      transactionAt:
        opts.transactionAt === undefined ? txAt : opts.transactionAt,
      createdAt: opts.createdAt ?? txAt,
    });
  }

  function groupSnapshot(groups: ReturnType<typeof buildHighConfidenceDuplicateGroups>) {
    return groups.map((g) => ({
      confidence: g.confidence,
      receiptIds: [...g.receiptIds].sort(),
      representativeReceiptId: g.representativeReceiptId,
      relationEvidence: g.relationEvidence.map((r) => ({
        leftReceiptId: r.leftReceiptId,
        rightReceiptId: r.rightReceiptId,
        path: r.path,
      })),
      quantityConflicts: g.semanticRescanEvidence?.quantityConflicts ?? [],
      noisyReceiptIds: g.reconciledEvidence?.noisyReceiptIds ?? [],
    }));
  }

  test('1+2: non-transitive tax bridge — no 3-member group; reverse input identical', () => {
    const items = [
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
    ];
    const itemsB = [
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
    ];
    const A = baseReceipt('A', {
      tax: 330,
      taxIsKnown: 1,
      items,
      total: 794,
      createdAt: txAt,
    });
    const B = baseReceipt('B', {
      taxIsKnown: 0,
      items: itemsB,
      total: 794,
      createdAt: txAt + 1,
    });
    const C = baseReceipt('C', {
      tax: 331,
      taxIsKnown: 1,
      items,
      total: 794,
      createdAt: txAt + 2,
    });

    expect(
      evaluateSemanticRescanExactPair(
        summarizeReceiptForDuplicateAudit(A),
        summarizeReceiptForDuplicateAudit(B)
      )
    ).not.toBeNull();
    expect(
      evaluateSemanticRescanExactPair(
        summarizeReceiptForDuplicateAudit(B),
        summarizeReceiptForDuplicateAudit(C)
      )
    ).not.toBeNull();
    expect(
      evaluateSemanticRescanExactPair(
        summarizeReceiptForDuplicateAudit(A),
        summarizeReceiptForDuplicateAudit(C)
      )
    ).toBeNull();

    const forward = buildHighConfidenceDuplicateGroups(
      [A, B, C].map(summarizeReceiptForDuplicateAudit),
      [A, B, C]
    );
    const reverse = buildHighConfidenceDuplicateGroups(
      [C, B, A].map(summarizeReceiptForDuplicateAudit),
      [C, B, A]
    );

    expect(forward.some((g) => g.receiptIds.length === 3)).toBe(false);
    expect(forward).toHaveLength(1);
    expect(forward[0]!.receiptIds.sort()).toEqual(['A', 'B']);
    expect(groupSnapshot(forward)).toEqual(groupSnapshot(reverse));
  });

  test('3: non-transitive name bridge — no unsafe 3-member group', () => {
    const A = baseReceipt('nA', {
      items: [
        { name: 'Product Alpha', category: 'other', lineTotal: 500, quantity: 1 },
      ],
      total: 500,
    });
    const B = baseReceipt('nB', {
      items: [
        {
          name: 'Product Alpha 2個',
          category: 'other',
          lineTotal: 500,
          quantity: 2,
        },
      ],
      total: 500,
    });
    const C = baseReceipt('nC', {
      items: [
        { name: 'Product Beta', category: 'other', lineTotal: 500, quantity: 1 },
      ],
      total: 500,
    });
    // A~B via pack suffix; B!~C and A!~C (different base names)
    expect(
      areSemanticRescanItemNamesCompatible(
        canonicalizeReceiptItemName('Product Alpha'),
        canonicalizeReceiptItemName('Product Alpha 2個')
      ).compatible
    ).toBe(true);
    const groups = buildHighConfidenceDuplicateGroups(
      [A, B, C].map(summarizeReceiptForDuplicateAudit),
      [A, B, C]
    );
    expect(groups.some((g) => g.receiptIds.length === 3)).toBe(false);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.receiptIds.sort()).toEqual(['nA', 'nB']);
  });

  test('4: cross-path A-B reconciled, B-C semantic, A-C none — no 3-group', () => {
    const coreItems: FixtureItem[] = [
      { name: 'P1', category: 'other', lineTotal: 400, quantity: 1 },
      { name: 'P2', category: 'other', lineTotal: 600, quantity: 1 },
    ];
    const noisyItems: FixtureItem[] = [
      ...coreItems,
      { name: 'OCR_TRAIL', category: 'other', lineTotal: 2, quantity: 1 },
    ];
    const semanticCore: FixtureItem[] = [
      { name: 'P1', category: 'other', lineTotal: 400, quantity: 2 },
      { name: 'P2', category: 'other', lineTotal: 600, quantity: 1 },
    ];
    // B=core, A=noisy(reconciled with B), C=semantic with B (qty differ)
    const B = baseReceipt('xB', {
      items: coreItems,
      total: 1000,
      tax: 80,
      taxIsKnown: 1,
    });
    const A = baseReceipt('xA', {
      items: noisyItems,
      total: 1000,
      tax: 82,
      taxIsKnown: 1,
      createdAt: txAt + 1,
    });
    const C = baseReceipt('xC', {
      items: semanticCore,
      total: 1000,
      tax: 80,
      taxIsKnown: 1,
      createdAt: txAt + 2,
    });

    expect(
      evaluateReconciledStructuralExactPair(
        summarizeReceiptForDuplicateAudit(A),
        summarizeReceiptForDuplicateAudit(B)
      )
    ).not.toBeNull();
    expect(
      evaluateSemanticRescanExactPair(
        summarizeReceiptForDuplicateAudit(B),
        summarizeReceiptForDuplicateAudit(C)
      )
    ).not.toBeNull();
    expect(
      evaluateReconciledStructuralExactPair(
        summarizeReceiptForDuplicateAudit(A),
        summarizeReceiptForDuplicateAudit(C)
      )
    ).toBeNull();
    expect(
      evaluateSemanticRescanExactPair(
        summarizeReceiptForDuplicateAudit(A),
        summarizeReceiptForDuplicateAudit(C)
      )
    ).toBeNull();

    const groups = buildHighConfidenceDuplicateGroups(
      [A, B, C].map(summarizeReceiptForDuplicateAudit),
      [A, B, C]
    );
    expect(groups.some((g) => g.receiptIds.length >= 3)).toBe(false);
    // Deterministic seed: A joins B first → {A,B}; C alone or {B,C} if B free — B assigned with A
    expect(groups).toHaveLength(1);
    expect(groups[0]!.receiptIds.sort()).toEqual(['xA', 'xB']);
    expect(groups[0]!.confidence).toBe('RECONCILED_STRUCTURAL_EXACT_DUPLICATE');
  });

  test('5: structural + semantic valid clique => one group; both path types retained', () => {
    const itemsSameQty: FixtureItem[] = [
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
    ];
    const itemsAltName: FixtureItem[] = [
      { name: 'Product X ', category: 'other', lineTotal: 794, quantity: 1 },
    ];
    const itemsQty2: FixtureItem[] = [
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
    ];
    // A/B: structural (qty+amount same; name whitespace may differ content fp)
    const A = baseReceipt('clA', { items: itemsSameQty, total: 794 });
    const B = baseReceipt('clB', {
      items: itemsAltName,
      total: 794,
      createdAt: txAt + 1,
    });
    const C = baseReceipt('clC', {
      items: itemsQty2,
      total: 794,
      tax: 60,
      taxIsKnown: 1,
      createdAt: txAt + 2,
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [A, B, C].map(summarizeReceiptForDuplicateAudit),
      [A, B, C]
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.receiptIds.sort()).toEqual(['clA', 'clB', 'clC']);
    const paths = new Set(groups[0]!.relationEvidence.map((r) => r.path));
    expect(paths.has('SEMANTIC_RESCAN_EXACT_DUPLICATE')).toBe(true);
    expect(
      paths.has('STRUCTURAL_EXACT_DUPLICATE') ||
        paths.has('CONTENT_EXACT_DUPLICATE')
    ).toBe(true);
    expect(groups[0]!.semanticRescanEvidence).toBeDefined();
  });

  test('6+7: reconciled confidence keeps semantic evidence when both present; noisy only from reconciled edges', () => {
    // Construct clique with RECONCILED + SEMANTIC is not possible under pair gates
    // (reconciled needs unequal length; semantic needs equal length).
    // Verify: pure reconciled noisyReceiptIds come from actual noisy edge only;
    // and emit path retains semanticRescanEvidence whenever hasSemantic (covered in test 5).
    const coreItems: FixtureItem[] = [
      { name: 'P1', category: 'other', lineTotal: 500, quantity: 1 },
      { name: 'P2', category: 'other', lineTotal: 500, quantity: 1 },
    ];
    const noisyItems: FixtureItem[] = [
      ...coreItems,
      { name: 'TRAIL', category: 'other', lineTotal: 5, quantity: 1 },
    ];
    // Extra longer receipt that is NOT reconciled with core (different line amounts)
    const unrelatedLong: FixtureItem[] = [
      { name: 'P1', category: 'other', lineTotal: 400, quantity: 1 },
      { name: 'P2', category: 'other', lineTotal: 600, quantity: 1 },
      { name: 'P3', category: 'other', lineTotal: 5, quantity: 1 },
    ];
    const core = baseReceipt('rn-core', {
      items: coreItems,
      total: 1000,
      tax: 80,
      taxIsKnown: 1,
    });
    const noisy = baseReceipt('rn-noisy', {
      items: noisyItems,
      total: 1000,
      tax: 85,
      taxIsKnown: 1,
      createdAt: txAt + 1,
    });
    const longerUnrelated = baseReceipt('rn-long', {
      items: unrelatedLong,
      total: 1005,
      createdAt: txAt + 2,
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [core, noisy, longerUnrelated].map(summarizeReceiptForDuplicateAudit),
      [core, noisy, longerUnrelated]
    );
    const reconciled = groups.find(
      (g) => g.confidence === 'RECONCILED_STRUCTURAL_EXACT_DUPLICATE'
    )!;
    expect(reconciled.reconciledEvidence!.noisyReceiptIds).toEqual(['rn-noisy']);
    expect(reconciled.reconciledEvidence!.noisyReceiptIds).not.toContain(
      'rn-long'
    );
  });

  test('8+9: 3 scans qty 1/2/3 — all conflict pairs retained; reverse identical', () => {
    const mk = (id: string, qty: number) =>
      baseReceipt(id, {
        items: [
          {
            name: 'Product X',
            category: 'other',
            lineTotal: 794,
            quantity: qty,
          },
        ],
        total: 794,
        createdAt: txAt + qty,
      });
    const a = mk('qA', 1);
    const b = mk('qB', 2);
    const c = mk('qC', 3);
    // All pairs compatible (tax unknown) → one clique with 3 conflict pairs
    const forward = buildHighConfidenceDuplicateGroups(
      [a, b, c].map(summarizeReceiptForDuplicateAudit),
      [a, b, c]
    );
    const reverse = buildHighConfidenceDuplicateGroups(
      [c, b, a].map(summarizeReceiptForDuplicateAudit),
      [c, b, a]
    );
    expect(forward).toHaveLength(1);
    expect(forward[0]!.receiptIds.sort()).toEqual(['qA', 'qB', 'qC']);
    const conflicts = forward[0]!.semanticRescanEvidence!.quantityConflicts;
    expect(conflicts).toHaveLength(3);
    expect(conflicts.map((x) => `${x.leftReceiptId}|${x.rightReceiptId}`).sort()).toEqual(
      ['qA|qB', 'qA|qC', 'qB|qC']
    );
    expect(conflicts).toEqual(
      reverse[0]!.semanticRescanEvidence!.quantityConflicts
    );
    for (const cfl of conflicts) {
      expect(cfl.leftReceiptId < cfl.rightReceiptId).toBe(true);
    }
  });

  test('10+11+12: audit / analytics / canonical representative SSOT on 022', () => {
    const frontTarget = 2707;
    const frontItems: FixtureItem[] = Array.from({ length: 9 }, (_, i) => ({
      name: `Shared Item ${i + 1}`,
      category: 'other',
      lineTotal: i < 8 ? 300 : frontTarget - 300 * 8,
      quantity: 1,
    }));
    const itemsA: FixtureItem[] = [
      ...frontItems,
      { name: 'Battery AA', category: 'other', lineTotal: 393, quantity: 4 },
      { name: 'Battery AAA', category: 'other', lineTotal: 393, quantity: 4 },
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
    ];
    const itemsB: FixtureItem[] = [
      ...frontItems,
      {
        name: 'Battery AA 4-count',
        category: 'other',
        lineTotal: 393,
        quantity: 1,
      },
      {
        name: 'Battery AAA 4-count',
        category: 'other',
        lineTotal: 393,
        quantity: 1,
      },
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
    ];
    const early = baseReceipt('022-a', {
      items: itemsA,
      total: 4287,
      taxIsKnown: 0,
      createdAt: txAt,
    });
    const rich = baseReceipt('022-b', {
      items: itemsB,
      total: 4287,
      tax: 330,
      taxIsKnown: 1,
      createdAt: txAt + 10_000,
    });

    const auditGroups = buildHighConfidenceDuplicateGroups(
      [early, rich].map(summarizeReceiptForDuplicateAudit),
      [early, rich]
    );
    expect(auditGroups[0]!.representativeReceiptId).toBe('022-b');

    const selection = selectAnalyticsReceipts([early, rich]);
    expect(selection.analyticsReceipts.map((r) => r.id)).toEqual(['022-b']);
    expect(
      selection.highConfidenceDuplicateGroups[0]!.representativeReceiptId
    ).toBe('022-b');

    const canonical = buildCanonicalReceiptGroups([early, rich]);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.representativeReceipt.id).toBe('022-b');
  });

  test('13+14+15: invalid timestamps fail closed; valid exact still passes', () => {
    const mkAt = (transactionAt: number) =>
      baseReceipt('ts', {
        items: [
          { name: 'Product X', category: 'other', lineTotal: 100, quantity: 1 },
        ],
        total: 100,
        transactionAt,
      });

    expect(hasValidTransactionAt(mkAt(9e15))).toBe(true);
    expect(hasExactTransactionTime(mkAt(9e15))).toBe(false);

    for (const bad of [NaN, Infinity, -Infinity, 0, -1]) {
      expect(hasValidTransactionAt(mkAt(bad))).toBe(false);
      expect(hasExactTransactionTime(mkAt(bad))).toBe(false);
    }

    const exact = mkAt(txAt);
    expect(hasExactTransactionTime(exact)).toBe(true);

    const dateOnly = mkAt(Date.parse('2024-08-15T00:00:00+09:00'));
    expect(hasExactTransactionTime(dateOnly)).toBe(false);

    const a = baseReceipt('ts-a', {
      items: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
      ],
      total: 794,
      transactionAt: 9e15,
    });
    const b = baseReceipt('ts-b', {
      items: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
      ],
      total: 794,
      tax: 60,
      taxIsKnown: 1,
      transactionAt: 9e15,
      createdAt: txAt + 1,
    });
    expect(
      buildHighConfidenceDuplicateGroups(
        [a, b].map(summarizeReceiptForDuplicateAudit),
        [a, b]
      )
    ).toHaveLength(0);
  });
});

describe('A1.3.2 Final Representative & Evidence Seal', () => {
  const txAt = Date.parse('2024-08-15T18:42:11+09:00');

  test('representative: newer richer/user-edited beats older weak when closure+tax equal', () => {
    const old = makeReceipt({
      id: 'rep-old',
      at: txAt,
      createdAt: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      total: 794,
      tax: 60,
      taxIsKnown: 1,
      userEdited: 0,
      items: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
      ],
    });
    const neu = makeReceipt({
      id: 'rep-new',
      at: txAt,
      createdAt: txAt + 60_000,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      total: 794,
      tax: 60,
      taxIsKnown: 1,
      userEdited: 1,
      note: 'corrected',
      items: [
        {
          name: 'Product X',
          category: 'other',
          lineTotal: 794,
          quantity: 1,
          merchant_product_id: 'mp_rich',
          canonical_product_id: 'cp_rich',
          identity_source: 'merchant_catalog',
          identity_confidence: 0.95,
          normalized_full_name: 'Product X Rich Spec',
        },
      ],
    });

    const forward = buildHighConfidenceDuplicateGroups(
      [old, neu].map(summarizeReceiptForDuplicateAudit),
      [old, neu]
    );
    const reverse = buildHighConfidenceDuplicateGroups(
      [neu, old].map(summarizeReceiptForDuplicateAudit),
      [neu, old]
    );
    expect(forward).toHaveLength(1);
    expect(forward[0]!.representativeReceiptId).toBe('rep-new');
    expect(reverse[0]!.representativeReceiptId).toBe('rep-new');

    const selection = selectAnalyticsReceipts([old, neu]);
    expect(selection.analyticsReceipts.map((r) => r.id)).toEqual(['rep-new']);
    expect(
      selection.highConfidenceDuplicateGroups[0]!.representativeReceiptId
    ).toBe('rep-new');

    const canonical = buildCanonicalReceiptGroups([old, neu]);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.representativeReceipt.id).toBe('rep-new');
  });

  test('representative tie: equal quality → earlier createdAt, reverse identical', () => {
    const a = makeReceipt({
      id: 'tie-a',
      at: txAt,
      createdAt: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      total: 500,
      tax: 40,
      taxIsKnown: 1,
      items: [
        { name: 'Product Y', category: 'other', lineTotal: 500, quantity: 1 },
      ],
    });
    const b = makeReceipt({
      id: 'tie-b',
      at: txAt,
      createdAt: txAt + 1000,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      total: 500,
      tax: 40,
      taxIsKnown: 1,
      items: [
        { name: 'Product Y', category: 'other', lineTotal: 500, quantity: 1 },
      ],
    });
    const g1 = buildHighConfidenceDuplicateGroups(
      [a, b].map(summarizeReceiptForDuplicateAudit),
      [a, b]
    );
    const g2 = buildHighConfidenceDuplicateGroups(
      [b, a].map(summarizeReceiptForDuplicateAudit),
      [b, a]
    );
    expect(g1[0]!.representativeReceiptId).toBe('tie-a');
    expect(g2[0]!.representativeReceiptId).toBe('tie-a');
  });

  test('mixed clique A-B/A-C reconciled + B-C semantic — semantic provenance is B-C', () => {
    const core: FixtureItem[] = [
      { name: 'P1', category: 'other', lineTotal: 500, quantity: 1 },
      { name: 'P2', category: 'other', lineTotal: 500, quantity: 1 },
    ];
    const noisyB: FixtureItem[] = [
      ...core,
      { name: 'TRAIL', category: 'other', lineTotal: 5, quantity: 1 },
    ];
    const noisyC: FixtureItem[] = [
      ...core,
      { name: 'TRAIL', category: 'other', lineTotal: 5, quantity: 2 },
    ];
    const A = makeReceipt({
      id: 'mxA',
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: core,
      total: 1000,
      tax: 80,
      taxIsKnown: 1,
    });
    const B = makeReceipt({
      id: 'mxB',
      at: txAt,
      createdAt: txAt + 1,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: noisyB,
      total: 1000,
      tax: 85,
      taxIsKnown: 1,
    });
    const C = makeReceipt({
      id: 'mxC',
      at: txAt,
      createdAt: txAt + 2,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: noisyC,
      total: 1000,
      tax: 85,
      taxIsKnown: 1,
    });

    expect(
      evaluateReconciledStructuralExactPair(
        summarizeReceiptForDuplicateAudit(A),
        summarizeReceiptForDuplicateAudit(B)
      )
    ).not.toBeNull();
    expect(
      evaluateReconciledStructuralExactPair(
        summarizeReceiptForDuplicateAudit(A),
        summarizeReceiptForDuplicateAudit(C)
      )
    ).not.toBeNull();
    expect(
      evaluateSemanticRescanExactPair(
        summarizeReceiptForDuplicateAudit(B),
        summarizeReceiptForDuplicateAudit(C)
      )
    ).not.toBeNull();

    const forward = buildHighConfidenceDuplicateGroups(
      [A, B, C].map(summarizeReceiptForDuplicateAudit),
      [A, B, C]
    );
    const reverse = buildHighConfidenceDuplicateGroups(
      [C, B, A].map(summarizeReceiptForDuplicateAudit),
      [C, B, A]
    );

    expect(forward).toHaveLength(1);
    expect(forward[0]!.receiptIds.sort()).toEqual(['mxA', 'mxB', 'mxC']);
    expect(forward[0]!.confidence).toBe(
      'RECONCILED_STRUCTURAL_EXACT_DUPLICATE'
    );
    expect(forward[0]!.semanticRescanEvidence).toBeDefined();
    // Aggregate must not pretend a unique pair via member[0]/member[1].
    expect(
      (forward[0]!.semanticRescanEvidence as { leftReceiptId?: string })
        .leftReceiptId
    ).toBeUndefined();
    expect(
      (forward[0]!.semanticRescanEvidence as { rightReceiptId?: string })
        .rightReceiptId
    ).toBeUndefined();

    const semanticRels = forward[0]!.relationEvidence.filter(
      (r) => r.path === 'SEMANTIC_RESCAN_EXACT_DUPLICATE'
    );
    expect(semanticRels).toHaveLength(1);
    expect(semanticRels[0]!.leftReceiptId).toBe('mxB');
    expect(semanticRels[0]!.rightReceiptId).toBe('mxC');
    expect(forward[0]!.semanticRescanEvidence!.quantityConflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leftReceiptId: 'mxB',
          rightReceiptId: 'mxC',
          itemIndex: 2,
        }),
      ])
    );

    expect(forward[0]!.relationEvidence).toEqual(reverse[0]!.relationEvidence);
    expect(forward[0]!.semanticRescanEvidence).toEqual(
      reverse[0]!.semanticRescanEvidence
    );
  });

  test('three semantic pairs retained on relationEvidence; aggregate has no fake pair ids', () => {
    const mk = (id: string, qty: number) =>
      makeReceipt({
        id,
        at: txAt,
        createdAt: txAt + qty,
        merchantType: 'supermarket',
        merchantNormalized: 'Merchant A',
        total: 794,
        items: [
          {
            name: 'Product X',
            category: 'other',
            lineTotal: 794,
            quantity: qty,
          },
        ],
      });
    const a = mk('sA', 1);
    const b = mk('sB', 2);
    const c = mk('sC', 3);
    const groups = buildHighConfidenceDuplicateGroups(
      [a, b, c].map(summarizeReceiptForDuplicateAudit),
      [a, b, c]
    );
    expect(groups).toHaveLength(1);
    const semanticRels = groups[0]!.relationEvidence.filter(
      (r) => r.path === 'SEMANTIC_RESCAN_EXACT_DUPLICATE'
    );
    expect(semanticRels.map((r) => `${r.leftReceiptId}|${r.rightReceiptId}`)).toEqual(
      ['sA|sB', 'sA|sC', 'sB|sC']
    );
    expect(
      (groups[0]!.semanticRescanEvidence as { leftReceiptId?: string })
        .leftReceiptId
    ).toBeUndefined();
    expect(groups[0]!.semanticRescanEvidence!.quantityConflicts).toHaveLength(3);
  });

  test('022 regression: tax-known richer observation still selected', () => {
    const frontTarget = 2707;
    const frontItems: FixtureItem[] = Array.from({ length: 9 }, (_, i) => ({
      name: `Shared Item ${i + 1}`,
      category: 'other',
      lineTotal: i < 8 ? 300 : frontTarget - 300 * 8,
      quantity: 1,
    }));
    const itemsA: FixtureItem[] = [
      ...frontItems,
      { name: 'Battery AA', category: 'other', lineTotal: 393, quantity: 4 },
      { name: 'Battery AAA', category: 'other', lineTotal: 393, quantity: 4 },
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
    ];
    const itemsB: FixtureItem[] = [
      ...frontItems,
      {
        name: 'Battery AA 4-count',
        category: 'other',
        lineTotal: 393,
        quantity: 1,
      },
      {
        name: 'Battery AAA 4-count',
        category: 'other',
        lineTotal: 393,
        quantity: 1,
      },
      { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
    ];
    const early = makeReceipt({
      id: '022-a',
      at: txAt,
      createdAt: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: itemsA,
      total: 4287,
      taxIsKnown: 0,
    });
    const rich = makeReceipt({
      id: '022-b',
      at: txAt,
      createdAt: txAt + 10_000,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      items: itemsB,
      total: 4287,
      tax: 330,
      taxIsKnown: 1,
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [early, rich].map(summarizeReceiptForDuplicateAudit),
      [early, rich]
    );
    expect(groups[0]!.representativeReceiptId).toBe('022-b');
    expect(selectAnalyticsReceipts([early, rich]).analyticsReceipts[0]!.id).toBe(
      '022-b'
    );
    expect(buildCanonicalReceiptGroups([early, rich])[0]!.representativeReceipt.id).toBe(
      '022-b'
    );
  });
});

describe('A1.3.3 Remove Ambiguous Aggregate Tax Compatibility', () => {
  const txAt = Date.parse('2024-08-15T18:42:11+09:00');

  test('A+C: multi-semantic group keeps pair tax states; aggregate has no taxCompatibility', () => {
    // A tax known, B unknown, C unknown → A-B one_known_one_unknown, B-C both_unknown
    // A-C: tax known vs unknown → also one_known_one_unknown (all pairs form a clique)
    const mk = (
      id: string,
      qty: number,
      taxOpts: { tax?: number; taxIsKnown?: number }
    ) =>
      makeReceipt({
        id,
        at: txAt,
        createdAt: txAt + qty,
        merchantType: 'supermarket',
        merchantNormalized: 'Merchant A',
        total: 794,
        tax: taxOpts.tax ?? 0,
        taxIsKnown: taxOpts.taxIsKnown ?? 0,
        items: [
          {
            name: 'Product X',
            category: 'other',
            lineTotal: 794,
            quantity: qty,
          },
        ],
      });
    const a = mk('tA', 1, { tax: 60, taxIsKnown: 1 });
    const b = mk('tB', 2, { taxIsKnown: 0 });
    const c = mk('tC', 3, { taxIsKnown: 0 });

    const forward = buildHighConfidenceDuplicateGroups(
      [a, b, c].map(summarizeReceiptForDuplicateAudit),
      [a, b, c]
    );
    const reverse = buildHighConfidenceDuplicateGroups(
      [c, b, a].map(summarizeReceiptForDuplicateAudit),
      [c, b, a]
    );

    expect(forward).toHaveLength(1);
    expect('taxCompatibility' in (forward[0]!.semanticRescanEvidence ?? {})).toBe(
      false
    );
    expect(
      (forward[0]!.semanticRescanEvidence as { taxCompatibility?: string } | undefined)
        ?.taxCompatibility
    ).toBeUndefined();

    const taxByPair = Object.fromEntries(
      forward[0]!
        .relationEvidence.filter(
          (r) => r.path === 'SEMANTIC_RESCAN_EXACT_DUPLICATE'
        )
        .map((r) => [
          `${r.leftReceiptId}|${r.rightReceiptId}`,
          r.semanticRescanEvidence!.taxCompatibility,
        ])
    );
    expect(taxByPair['tA|tB']).toBe('one_known_one_unknown');
    expect(taxByPair['tB|tC']).toBe('both_unknown');
    expect(taxByPair['tA|tC']).toBe('one_known_one_unknown');

    const reverseTax = Object.fromEntries(
      reverse[0]!
        .relationEvidence.filter(
          (r) => r.path === 'SEMANTIC_RESCAN_EXACT_DUPLICATE'
        )
        .map((r) => [
          `${r.leftReceiptId}|${r.rightReceiptId}`,
          r.semanticRescanEvidence!.taxCompatibility,
        ])
    );
    expect(reverseTax).toEqual(taxByPair);
    expect(forward[0]!.relationEvidence).toEqual(reverse[0]!.relationEvidence);
  });

  test('B: single semantic relation — aggregate still has no taxCompatibility', () => {
    const a = makeReceipt({
      id: 'one-a',
      at: txAt,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      total: 794,
      taxIsKnown: 0,
      items: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 1 },
      ],
    });
    const b = makeReceipt({
      id: 'one-b',
      at: txAt,
      createdAt: txAt + 1,
      merchantType: 'supermarket',
      merchantNormalized: 'Merchant A',
      total: 794,
      tax: 60,
      taxIsKnown: 1,
      items: [
        { name: 'Product X', category: 'other', lineTotal: 794, quantity: 2 },
      ],
    });
    const groups = buildHighConfidenceDuplicateGroups(
      [a, b].map(summarizeReceiptForDuplicateAudit),
      [a, b]
    );
    expect(groups).toHaveLength(1);
    expect(
      (groups[0]!.semanticRescanEvidence as { taxCompatibility?: string } | undefined)
        ?.taxCompatibility
    ).toBeUndefined();
    expect(
      groups[0]!.relationEvidence[0]!.semanticRescanEvidence!.taxCompatibility
    ).toBe('one_known_one_unknown');

    const canonical = buildCanonicalReceiptGroups([a, b]);
    expect(
      canonical[0]!.evidence.some((e) => e.startsWith('tax_compatibility='))
    ).toBe(false);
  });
});
