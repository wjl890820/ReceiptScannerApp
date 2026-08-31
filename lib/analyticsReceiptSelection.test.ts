/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import type { ReceiptRow } from './db';
import {
  filterProductRowsByExcludedReceiptIds,
  indexHighConfidenceDuplicateGroupsByReceiptId,
  selectAnalyticsReceipts,
} from './analyticsReceiptSelection';
import { generateAnalysisDDiagnosticsBundle } from './analysisDDiagnosticsGenerate';
import { buildAnalysisDDuplicateScanAudit } from './analysisDDuplicateAudit';

const nowMs = Date.parse('2026-08-22T12:00:00+09:00');

function makeReceipt(args: {
  id: string;
  createdAt?: number;
  name?: string;
}): ReceiptRow {
  return {
    id: args.id,
    created_at: args.createdAt ?? nowMs,
    transaction_at: nowMs,
    image_uri: '',
    total: 198,
    tax: 0,
    tax_is_known: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [
        {
          name: args.name ?? '明治おいしい牛乳',
          category: 'food_ingredients',
          lineTotal: 198,
          quantity: 1,
        },
      ],
    }),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  } as ReceiptRow;
}

describe('analyticsReceiptSelection', () => {
  test('selects analytics receipts excluding high-confidence extras', () => {
    const a = makeReceipt({ id: 'keep', createdAt: nowMs });
    const b = makeReceipt({ id: 'drop', createdAt: nowMs + 1 });
    const result = selectAnalyticsReceipts([a, b]);
    expect(result.storedReceipts).toHaveLength(2);
    expect(result.analyticsReceipts.map((r) => r.id)).toEqual(['keep']);
    expect([...result.excludedDuplicateReceiptIds]).toEqual(['drop']);
    expect(result.contentExactDuplicateExtras).toBe(1);
    expect(result.analyticsPurchaseCandidateCount).toBe(1);
    expect(result.probableDuplicateExtras).toBe(0);
    const membership = indexHighConfidenceDuplicateGroupsByReceiptId(
      result.highConfidenceDuplicateGroups
    );
    expect(membership.get('keep')).toEqual(
      expect.objectContaining({
        representativeReceiptId: 'keep',
        receiptIds: ['drop', 'keep'],
      })
    );
    expect(membership.get('drop')).toBe(membership.get('keep'));
  });

  test('fails closed when one receipt is assigned to conflicting groups', () => {
    const base = selectAnalyticsReceipts([
      makeReceipt({ id: 'a', createdAt: nowMs }),
      makeReceipt({ id: 'b', createdAt: nowMs + 1 }),
    ]).highConfidenceDuplicateGroups[0]!;
    expect(() =>
      indexHighConfidenceDuplicateGroupsByReceiptId([
        base,
        {
          ...base,
          representativeReceiptId: 'a',
          receiptIds: ['a', 'c'],
        },
      ])
    ).toThrow('conflicting_high_confidence_duplicate_membership');
  });

  test('keepSeparateReceiptIds preserves structural extras', () => {
    const a = makeReceipt({ id: 'rep', createdAt: nowMs, name: '牛乳A' });
    const b = makeReceipt({
      id: 'keep-sep',
      createdAt: nowMs + 1,
      name: '牛乳B',
    });
    const result = selectAnalyticsReceipts([a, b], {
      keepSeparateReceiptIds: new Set(['keep-sep']),
    });
    expect(result.analyticsReceipts.map((r) => r.id).sort()).toEqual([
      'keep-sep',
      'rep',
    ]);
    expect(result.excludedDuplicateReceiptIds.size).toBe(0);
    expect(result.analyticsPurchaseCandidateCount).toBe(2);
    expect(result.keepSeparateReceiptIds.has('keep-sep')).toBe(true);
  });

  test('filterProductRowsByExcludedReceiptIds', () => {
    const rows = [
      { receiptId: 'a', n: 1 },
      { receiptId: 'b', n: 2 },
      { receiptId: 'c', n: 3 },
    ];
    expect(
      filterProductRowsByExcludedReceiptIds(rows, new Set(['b']))
    ).toEqual([
      { receiptId: 'a', n: 1 },
      { receiptId: 'c', n: 3 },
    ]);
    expect(filterProductRowsByExcludedReceiptIds(rows, new Set())).toEqual(
      rows
    );
  });
});


describe('D2-E4 highConfidenceDuplicateExtras diagnostic invariant', () => {
  const txAt = 1688611486000;

  const costcoCore = [
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

  function receipt(args: {
    id: string;
    createdAt: number;
    merchant?: string;
    transactionAt?: number;
    total?: number;
    tax?: number;
    taxIsKnown?: number;
    items: Array<{
      name: string;
      category: string;
      lineTotal: number;
      quantity: number;
    }>;
  }): ReceiptRow {
    const sum = args.items.reduce((s, it) => s + it.lineTotal, 0);
    return {
      id: args.id,
      created_at: args.createdAt,
      transaction_at: args.transactionAt ?? nowMs,
      image_uri: '',
      total: args.total ?? sum,
      tax: args.tax ?? 0,
      tax_is_known: args.taxIsKnown ?? 0,
      currency: 'JPY',
      analysis_json: JSON.stringify({ items: args.items }),
      merchant_raw: args.merchant ?? 'イオン',
      merchant_normalized: args.merchant ?? 'イオン',
      merchant_type: 'supermarket',
      user_edited: 0,
      final_total: null,
      final_category: null,
      note: null,
      user_items_json: null,
    } as ReceiptRow;
  }

  test('stored - candidates === highConfidenceDuplicateExtras across CONTENT+STRUCTURAL+RECONCILED', () => {
    // CONTENT_EXACT pair
    const contentA = receipt({
      id: 'content-a',
      createdAt: nowMs,
      items: [
        {
          name: '明治おいしい牛乳',
          category: 'food_ingredients',
          lineTotal: 198,
          quantity: 1,
        },
      ],
    });
    const contentB = receipt({
      id: 'content-b',
      createdAt: nowMs + 1,
      items: [
        {
          name: '明治おいしい牛乳',
          category: 'food_ingredients',
          lineTotal: 198,
          quantity: 1,
        },
      ],
    });

    // STRUCTURAL_EXACT pair (same structure, different OCR names)
    const structuralA = receipt({
      id: 'struct-a',
      createdAt: nowMs + 10,
      merchant: 'スーパーX',
      transactionAt: nowMs + 10_000,
      items: [
        {
          name: '卵パック',
          category: 'food_ingredients',
          lineTotal: 250,
          quantity: 1,
        },
      ],
    });
    const structuralB = receipt({
      id: 'struct-b',
      createdAt: nowMs + 11,
      merchant: 'スーパーX',
      transactionAt: nowMs + 10_000,
      items: [
        {
          name: 'たまごパック',
          category: 'food_ingredients',
          lineTotal: 250,
          quantity: 1,
        },
      ],
    });

    // RECONCILED_STRUCTURAL_EXACT (clean + trailing-artifact noisy)
    const clean = receipt({
      id: 'recon-clean',
      createdAt: nowMs + 20,
      merchant: 'コストコ',
      transactionAt: txAt,
      total: 9534,
      tax: 706,
      taxIsKnown: 1,
      items: costcoCore.map((it, i) => ({ ...it, name: `${it.name}${i}` })),
    });
    const noisy = receipt({
      id: 'recon-noisy',
      createdAt: nowMs + 19, // earlier createdAt — must still be excluded
      merchant: 'コストコ',
      transactionAt: txAt,
      total: 9534,
      tax: 708,
      taxIsKnown: 1,
      items: [
        ...costcoCore.map((it, i) => ({ ...it, name: `${it.name}_n${i}` })),
        {
          name: 'コストコ コネクション',
          category: 'other',
          lineTotal: 1,
          quantity: 1,
        },
        {
          name: 'コストコ コネクション ムリョウ',
          category: 'other',
          lineTotal: 1,
          quantity: 1,
        },
      ],
    });

    // Unique singleton (not a duplicate)
    const unique = receipt({
      id: 'unique',
      createdAt: nowMs + 30,
      merchant: '別店舗',
      transactionAt: nowMs + 50_000,
      items: [
        {
          name: 'パン',
          category: 'food_ingredients',
          lineTotal: 120,
          quantity: 1,
        },
      ],
    });

    const receipts = [
      contentA,
      contentB,
      structuralA,
      structuralB,
      clean,
      noisy,
      unique,
    ];
    const beforeIds = receipts.map((r) => r.id).sort();
    const selection = selectAnalyticsReceipts(receipts);
    const afterIds = selection.storedReceipts.map((r) => r.id).sort();

    // Production universe / stored set unchanged
    expect(afterIds).toEqual(beforeIds);

    expect(selection.storedReceipts.length).toBe(7);
    expect(selection.contentExactDuplicateExtras).toBe(1);
    expect(selection.structuralExactDuplicateExtras).toBe(1);
    expect(selection.reconciledStructuralExactDuplicateExtras).toBe(1);

    // Authoritative invariant
    expect(selection.highConfidenceDuplicateExtras).toBe(
      selection.excludedDuplicateReceiptIds.size
    );
    expect(
      selection.storedReceipts.length -
        selection.analyticsPurchaseCandidateCount
    ).toBe(selection.highConfidenceDuplicateExtras);
    expect(selection.highConfidenceDuplicateExtras).toBe(3);
    expect(selection.analyticsPurchaseCandidateCount).toBe(4);

    // Bucket sum may equal excluded size when no keepSeparate — still prefer excluded.size
    expect(
      selection.contentExactDuplicateExtras +
        selection.structuralExactDuplicateExtras +
        selection.reconciledStructuralExactDuplicateExtras
    ).toBe(selection.highConfidenceDuplicateExtras);

    // Candidate IDs: one from each unique purchase + unique
    const candidateIds = selection.analyticsReceipts.map((r) => r.id).sort();
    expect(candidateIds).toContain('unique');
    expect(candidateIds).toContain('content-a');
    expect(candidateIds).toContain('struct-a');
    expect(candidateIds).toContain('recon-clean');
    expect(candidateIds).not.toContain('recon-noisy');
    expect(candidateIds).not.toContain('content-b');
    expect(candidateIds).not.toContain('struct-b');

    // duplicateScanAudit agrees with selection
    const audit = buildAnalysisDDuplicateScanAudit(receipts, nowMs);
    expect(audit.highConfidenceDuplicateExtras).toBe(
      selection.highConfidenceDuplicateExtras
    );
    expect(audit.analyticsPurchaseCandidateCount).toBe(
      selection.analyticsPurchaseCandidateCount
    );
  });

  test('diagnostics selection meta uses authoritative excluded size (includes reconciled)', async () => {
    const receipts = [
      receipt({
        id: 'c1',
        createdAt: nowMs,
        items: [
          {
            name: '明治おいしい牛乳',
            category: 'food_ingredients',
            lineTotal: 198,
            quantity: 1,
          },
        ],
      }),
      receipt({
        id: 'c2',
        createdAt: nowMs + 1,
        items: [
          {
            name: '明治おいしい牛乳',
            category: 'food_ingredients',
            lineTotal: 198,
            quantity: 1,
          },
        ],
      }),
      receipt({
        id: 'recon-clean',
        createdAt: nowMs + 20,
        merchant: 'コストコ',
        transactionAt: txAt,
        total: 9534,
        tax: 706,
        taxIsKnown: 1,
        items: costcoCore.map((it, i) => ({ ...it, name: `${it.name}${i}` })),
      }),
      receipt({
        id: 'recon-noisy',
        createdAt: nowMs + 19,
        merchant: 'コストコ',
        transactionAt: txAt,
        total: 9534,
        tax: 708,
        taxIsKnown: 1,
        items: [
          ...costcoCore.map((it, i) => ({ ...it, name: `${it.name}_n${i}` })),
          {
            name: 'コストコ コネクション',
            category: 'other',
            lineTotal: 1,
            quantity: 1,
          },
          {
            name: 'コストコ コネクション ムリョウ',
            category: 'other',
            lineTotal: 1,
            quantity: 1,
          },
        ],
      }),
    ];

    const direct = selectAnalyticsReceipts(receipts);
    const bundle = await generateAnalysisDDiagnosticsBundle({
      listReceiptsFn: async () => receipts,
      nowMs,
    });

    expect(bundle.selection.highConfidenceDuplicateExtras).toBe(
      direct.highConfidenceDuplicateExtras
    );
    expect(bundle.selection.highConfidenceDuplicateExtras).toBe(
      direct.excludedDuplicateReceiptIds.size
    );
    expect(
      bundle.selection.storedReceiptCount -
        bundle.selection.analyticsPurchaseCandidateCount
    ).toBe(bundle.selection.highConfidenceDuplicateExtras);
    // Must include reconciled (would be undercounted as 1 if only CONTENT+STRUCTURAL)
    expect(bundle.selection.reconciledStructuralExactDuplicateExtras).toBe(1);
    expect(bundle.selection.highConfidenceDuplicateExtras).toBe(2);

    expect(bundle.duplicateScanAudit.highConfidenceDuplicateExtras).toBe(
      bundle.selection.highConfidenceDuplicateExtras
    );

    // Production candidate set unchanged vs direct selection
    expect(
      bundle.productionAnalytics.dataset.totalLocalReceiptCount
    ).toBe(direct.analyticsPurchaseCandidateCount);
    expect(direct.analyticsReceipts.map((r) => r.id).sort()).toEqual(
      ['c1', 'recon-clean'].sort()
    );
  });
});
