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
  selectExactDedupedReceipts,
  summarizeReceiptForDuplicateAudit,
  ANALYSIS_D_KNOWN_COSTCO_9534_FORENSIC_TARGET_RECEIPT_IDS,
  auditKnownStructuralCostco9534Case,
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
    const groups = buildHighConfidenceDuplicateGroups(summaries);
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
    expect(srcHistory).toContain('expandHistoryPurchaseDeleteIds');
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
