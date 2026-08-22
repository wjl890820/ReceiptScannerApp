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
  buildExactDuplicateGroups,
  buildExactReceiptFingerprint,
  buildProbableDuplicateGroups,
  canonicalizeReceiptItemName,
  selectExactDedupedReceipts,
  summarizeReceiptForDuplicateAudit,
} from './analysisDDuplicateAudit';
import * as analysisDReport from './analysisDReport';
import * as fs from 'fs';
import * as path from 'path';

const nowMs = Date.parse('2026-08-22T12:00:00+09:00');
const sweetPotatoAt = Date.parse('2023-07-06T11:44:00+09:00');

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

describe('Analysis D2-A duplicate / re-scan audit', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('A — identical merchant/time/total/items → exact duplicate candidate', () => {
    const a = makeReceipt({
      id: 'a1',
      at: nowMs,
      createdAt: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
      merchantNormalized: 'イオン',
    });
    const b = makeReceipt({
      id: 'a2',
      at: nowMs,
      createdAt: nowMs + 60_000,
      merchantType: 'supermarket',
      items: milkItems,
      merchantNormalized: 'イオン',
    });
    const summaries = [a, b].map(summarizeReceiptForDuplicateAudit);
    const groups = buildExactDuplicateGroups(summaries);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.confidence).toBe('EXACT_DUPLICATE_CANDIDATE');
    expect(groups[0]?.receiptIds.sort()).toEqual(['a1', 'a2']);
  });

  test('B — same merchant/total but different timestamp → not automatic duplicate', () => {
    const a = makeReceipt({
      id: 'b1',
      at: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
      transactionAt: nowMs,
    });
    const b = makeReceipt({
      id: 'b2',
      at: nowMs + 3600_000,
      merchantType: 'supermarket',
      items: milkItems,
      transactionAt: nowMs + 3600_000,
    });
    expect(buildExactReceiptFingerprint(a)).not.toBe(
      buildExactReceiptFingerprint(b)
    );
    expect(
      buildExactDuplicateGroups(
        [a, b].map(summarizeReceiptForDuplicateAudit)
      )
    ).toHaveLength(0);
  });

  test('C — same timestamp/merchant but different item structure → not exact', () => {
    const a = makeReceipt({
      id: 'c1',
      at: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const b = makeReceipt({
      id: 'c2',
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
      buildExactDuplicateGroups(
        [a, b].map(summarizeReceiptForDuplicateAudit)
      )
    ).toHaveLength(0);
  });

  test('D — different receipt DB ids → identical exact fingerprint', () => {
    const a = makeReceipt({
      id: 'd-left',
      at: nowMs,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const b = makeReceipt({
      id: 'd-right',
      at: nowMs,
      createdAt: nowMs + 5,
      merchantType: 'supermarket',
      items: milkItems,
    });
    expect(buildExactReceiptFingerprint(a)).toBe(
      buildExactReceiptFingerprint(b)
    );
    expect(buildExactReceiptFingerprint(a)).not.toContain('d-left');
    expect(buildExactReceiptFingerprint(a)).not.toContain('d-right');
  });

  test('E — created_at differences do not prevent exact matching', () => {
    const a = makeReceipt({
      id: 'e1',
      at: nowMs,
      createdAt: nowMs - 10_000,
      merchantType: 'supermarket',
      items: milkItems,
      transactionAt: nowMs,
    });
    const b = makeReceipt({
      id: 'e2',
      at: nowMs,
      createdAt: nowMs + 99_000,
      merchantType: 'supermarket',
      items: milkItems,
      transactionAt: nowMs,
    });
    expect(buildExactReceiptFingerprint(a)).toBe(
      buildExactReceiptFingerprint(b)
    );
  });

  test('F — invalid/missing transaction_at remains conservative', () => {
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
    expect(buildExactReceiptFingerprint(b)).toBeNull();
    expect(
      buildExactDuplicateGroups(
        [a, b].map(summarizeReceiptForDuplicateAudit)
      )
    ).toHaveLength(0);
    const audit = buildAnalysisDDuplicateScanAudit([a, b], nowMs);
    expect(audit.exactDuplicateReceiptCount).toBe(0);
    expect(audit.missingTransactionAtReceiptCount).toBe(2);
  });

  test('G — exact deduped analytics counts one visit, not two', () => {
    const a = makeReceipt({
      id: 'g1',
      at: nowMs - 2 * 86400000,
      merchantType: 'supermarket',
      items: milkItems,
      merchantNormalized: 'イオン',
    });
    const b = makeReceipt({
      id: 'g2',
      at: nowMs - 2 * 86400000,
      createdAt: nowMs - 2 * 86400000 + 1000,
      merchantType: 'supermarket',
      items: milkItems,
      merchantNormalized: 'イオン',
    });
    const audit = buildAnalysisDDuplicateScanAudit([a, b], nowMs);
    expect(audit.impact.before.merchantVisitCount).toBe(2);
    expect(audit.impact.exactDeduped.merchantVisitCount).toBe(1);
    expect(audit.impact.before.storedReceiptCount).toBe(2);
    expect(audit.impact.exactDeduped.storedReceiptCount).toBe(1);
  });

  test('H — exact duplicate items count one occurrence in deduped view', () => {
    const a = makeReceipt({
      id: 'h1',
      at: nowMs - 3 * 86400000,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const b = makeReceipt({
      id: 'h2',
      at: nowMs - 3 * 86400000,
      createdAt: nowMs - 3 * 86400000 + 50,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const audit = buildAnalysisDDuplicateScanAudit([a, b], nowMs);
    expect(audit.impact.before.itemOccurrenceCount).toBe(2);
    expect(audit.impact.exactDeduped.itemOccurrenceCount).toBe(1);
  });

  test('I — price observations dedupe exact receipt scans', () => {
    const a = makeReceipt({
      id: 'i1',
      at: nowMs - 4 * 86400000,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const b = makeReceipt({
      id: 'i2',
      at: nowMs - 4 * 86400000,
      createdAt: nowMs - 4 * 86400000 + 20,
      merchantType: 'supermarket',
      items: milkItems,
    });
    const audit = buildAnalysisDDuplicateScanAudit([a, b], nowMs);
    expect(audit.impact.exactDeduped.priceHistoryObservationCount).toBeLessThanOrEqual(
      audit.impact.before.priceHistoryObservationCount
    );
    // Deduped set has a single receipt; usable SKU rows should not double-count the scan.
    expect(audit.impact.exactDeduped.storedReceiptCount).toBe(1);
  });

  test('J — raw receipts remain untouched (audit is read-only)', () => {
    const receipts = [
      makeReceipt({
        id: 'j1',
        at: nowMs,
        merchantType: 'supermarket',
        items: milkItems,
      }),
      makeReceipt({
        id: 'j2',
        at: nowMs,
        createdAt: nowMs + 1,
        merchantType: 'supermarket',
        items: milkItems,
      }),
    ];
    const before = JSON.stringify(receipts);
    buildAnalysisDDuplicateScanAudit(receipts, nowMs);
    expect(JSON.stringify(receipts)).toBe(before);

    const source = fs.readFileSync(
      path.resolve(__dirname, 'analysisDDuplicateAudit.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /saveReceipt|updateReceipt|deleteReceipt|upsertReceipt/
    );
  });

  test('K — sweet-potato-style duplicate fixture', () => {
    const potato = {
      name: 'さつまいも 1.5kg',
      category: 'food_ingredients',
      lineTotal: 698,
      quantity: 1,
    };
    const scan1 = makeReceipt({
      id: 'potato-scan-1',
      at: sweetPotatoAt,
      createdAt: sweetPotatoAt,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      items: [potato],
      total: 698,
    });
    const scan2 = makeReceipt({
      id: 'potato-scan-2',
      at: sweetPotatoAt,
      createdAt: sweetPotatoAt + 30_000,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      items: [potato],
      total: 698,
    });
    const twoLines = makeReceipt({
      id: 'potato-two-lines',
      at: sweetPotatoAt,
      merchantType: 'supermarket',
      merchantNormalized: 'コストコ',
      items: [potato, potato],
      total: 1396,
    });

    const twice = auditSweetPotatoStyleObservations([scan1, scan2]);
    expect(twice.interpretation).toBe('SAME_RECEIPT_SCANNED_TWICE');
    expect(twice.matchedReceiptIds.sort()).toEqual([
      'potato-scan-1',
      'potato-scan-2',
    ]);

    const lines = auditSweetPotatoStyleObservations([twoLines]);
    expect(lines.interpretation).toBe('TWO_ITEM_LINES_ON_ONE_RECEIPT');
    expect(lines.matchedItemLineCount).toBe(2);
  });

  test('probable diagnostic groups when names differ but structure matches', () => {
    const a = makeReceipt({
      id: 'p1',
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
    });
    // Canonicalize is NFKC + trim + lower + collapse runs of whitespace only
    // (not approximate). Inserted spaces between Japanese tokens remain single spaces.
    expect(canonicalizeReceiptItemName('明治 おいしい 牛乳')).not.toBe(
      canonicalizeReceiptItemName('明治おいしい牛乳')
    );
    // Force a true name-canonical difference that is not whitespace-only.
    const b2 = makeReceipt({
      id: 'p2b',
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
    });
    const summaries = [a, b2].map(summarizeReceiptForDuplicateAudit);
    expect(buildExactDuplicateGroups(summaries)).toHaveLength(0);
    const probable = buildProbableDuplicateGroups(summaries, new Set());
    expect(probable).toHaveLength(1);
    expect(probable[0]?.confidence).toBe('PROBABLE_DUPLICATE_CANDIDATE');

    const audit = buildAnalysisDDuplicateScanAudit([a, b2], nowMs);
    expect(audit.recommendedV1AnalyticsPolicy).not.toBe(
      'C_EXCLUDE_EXACT_AND_PROBABLE'
    );
    expect(audit.probableDuplicateReceiptCount).toBe(1);
    // Probable must not change exact-deduped receipt set.
    expect(selectExactDedupedReceipts([a, b2], []).map((r) => r.id).sort()).toEqual(
      ['p1', 'p2b']
    );
  });

  test('audit version + recommended policy B when exact precision high', () => {
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
    expect(audit.recommendedExcludeExactDuplicatesFromV1Analytics).toBe(true);
    expect(audit.recommendedV1AnalyticsPolicy).toBe('B_EXCLUDE_EXACT_ONLY');
    expect(audit.exactDuplicateReceiptCount).toBe(1);
    expect(audit.exactUniquePurchaseCandidateCount).toBe(1);
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
    const source = fs.readFileSync(
      path.resolve(__dirname, 'analysisDDuplicateAudit.ts'),
      'utf8'
    );
    expect(source).toContain('buildAnalysisDReport');
    expect(source).not.toMatch(/levenshtein|string-similarity|diceCoefficient/i);
    expect(source).not.toMatch(/editDistance|jaroWinkler|approxMatch/i);
  });
});
