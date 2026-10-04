/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from './db';
import {
  buildStructuralReceiptFingerprint,
  canonicalStructuralQtyAmountVector,
  summarizeReceiptForDuplicateAudit,
} from './analysisDDuplicateAudit';
import {
  buildCanonicalPurchaseOccurrenceIndex,
  evaluateCanonicalPurchaseOccurrencePair,
} from './canonicalPurchaseOccurrence';
import {
  pickBestRepresentativeReceiptId,
  type RepresentativeQualitySummary,
} from './receiptRepresentativeQuality';
import { compareStableString } from './stableStringOrder';

const TX = Date.parse('2026-06-30T13:36:00+09:00');

function tiedSummary(receiptId: string): RepresentativeQualitySummary {
  return {
    receiptId,
    merchandiseSum: 100,
    total: 100,
    itemCount: 1,
    hasExactTransactionTime: true,
    hasValidTransactionAt: true,
    taxKnown: true,
    structuralFingerprint: 'same-fingerprint',
    createdAt: 50,
  };
}

function makeReceipt(
  id: string,
  opts: {
    createdAt?: number;
    merchant?: string;
    merchantNormalized?: string;
    total?: number;
    tax?: number;
    items?: { name: string; quantity: number; lineTotal: number }[];
    verifiedId?: string | null;
  } = {}
): ReceiptRow {
  const items = opts.items ?? [{ name: 'GREEN CURRY', quantity: 1, lineTotal: 100 }];
  const total = opts.total ?? items.reduce((sum, item) => sum + item.lineTotal, 0);
  const tax = opts.tax ?? 10;
  const analysis = {
    merchant: opts.merchant ?? '合成商店',
    total,
    tax,
    tax_is_known: true,
    currency: 'JPY',
    is_grocery: true,
    merchant_type: 'supermarket',
    items,
    transaction_time_precision: 'second',
    transactionDate: '2026-06-30 13:36:00',
  };
  return {
    id,
    created_at: opts.createdAt ?? 50,
    transaction_at: TX,
    transaction_time_precision: 'second',
    image_uri: '',
    merchant_raw: opts.merchant ?? '合成商店',
    merchant_normalized: opts.merchantNormalized ?? opts.merchant ?? '合成商店',
    merchant_type: 'supermarket',
    total,
    tax,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify(analysis),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    verified_purchase_occurrence_id: opts.verifiedId ?? null,
    verified_purchase_occurrence_source: opts.verifiedId ? 'research_verified' : null,
    verified_purchase_occurrence_verified_at: opts.verifiedId ? 1_700_000_100_000 : null,
  };
}

function nonCliqueReceipts(): ReceiptRow[] {
  const items = [
    { name: 'GREEN CURRY', quantity: 1, lineTotal: 88 },
    { name: 'CHOPSTICKS', quantity: 1, lineTotal: 386 },
  ];
  return [
    makeReceipt('branch-a', {
      merchant: '業務スーパー 一吉店',
      merchantNormalized: '業務スーパー 一吉店',
      total: 474,
      tax: 61,
      items,
      createdAt: 1,
    }),
    makeReceipt('generic-b', {
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
      total: 474,
      tax: 61,
      items,
      createdAt: 2,
    }),
    makeReceipt('branch-c', {
      merchant: '業務スーパー 別店',
      merchantNormalized: '業務スーパー 別店',
      total: 474,
      tax: 61,
      items,
      createdAt: 3,
    }),
  ];
}

function groupSnapshot(receipts: readonly ReceiptRow[]) {
  return buildCanonicalPurchaseOccurrenceIndex(receipts).groups.map((group) => ({
    receiptIds: [...group.receiptIds],
    representativeReceiptId: group.representativeReceiptId,
    occurrenceKey: group.occurrenceKey,
  }));
}

const NON_CLIQUE_GROUPS = [
  {
    receiptIds: ['branch-a', 'generic-b'],
    representativeReceiptId: 'branch-a',
    occurrenceKey: 'derived:branch-a',
  },
  {
    receiptIds: ['branch-c'],
    representativeReceiptId: 'branch-c',
    occurrenceKey: 'derived:branch-c',
  },
];

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i]!;
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([head, ...tail]);
  }
  return out;
}

function withLocaleCompare<T>(
  impl: (this: string, other: string) => number,
  run: () => T
): T {
  const original = String.prototype.localeCompare;
  // The regression has to replace the runtime comparator for the duration of the call.
  // eslint-disable-next-line no-extend-native
  String.prototype.localeCompare = impl as typeof String.prototype.localeCompare;
  try {
    return run();
  } finally {
    // eslint-disable-next-line no-extend-native
    String.prototype.localeCompare = original;
  }
}

describe('locale-independent analytical order', () => {
  it('compares ids by code point, including case, digits, and punctuation', () => {
    expect(compareStableString('id', 'id')).toBe(0);
    expect(compareStableString('A', 'a')).toBe(-1);
    expect(compareStableString('a', 'A')).toBe(1);
    expect(compareStableString('Z-receipt', 'a-receipt')).toBe(-1);
    expect(compareStableString('9', 'A')).toBe(-1);
    expect(compareStableString('-', '_')).toBe(-1);
    expect(compareStableString('10', '2')).toBe(-1);
    expect(['a-receipt', 'Z-receipt'].sort(compareStableString)).toEqual([
      'Z-receipt',
      'a-receipt',
    ]);
    expect(
      ['a-receipt', 'Z-receipt'].sort((left, right) => left.localeCompare(right))
    ).toEqual(['a-receipt', 'Z-receipt']);
  });

  it('builds a locale-independent structural fingerprint for 2.00 and 10.00', () => {
    const vector = canonicalStructuralQtyAmountVector([
      { quantity: 1, lineAmount: 2 },
      { quantity: 1, lineAmount: 10 },
    ]);
    expect(vector).toEqual([
      { quantity: 1, lineAmount: 10 },
      { quantity: 1, lineAmount: 2 },
    ]);

    const receipt = makeReceipt('fp-amounts', {
      items: [
        { name: 'SMALL', quantity: 1, lineTotal: 2 },
        { name: 'LARGE', quantity: 1, lineTotal: 10 },
      ],
      total: 12,
    });
    const fingerprint = buildStructuralReceiptFingerprint(receipt);
    expect(fingerprint).toContain('amt:1\u001f10.00\u001e1\u001f2.00');

    const throwing = function throwingLocaleCompare(): number {
      throw new Error('localeCompare must not decide structural fingerprint order');
    };
    const underThrow = withLocaleCompare(throwing, () =>
      buildStructuralReceiptFingerprint(receipt)
    );
    expect(underThrow).toBe(fingerprint);
  });

  it('breaks a pure representative tie by code-point id order', () => {
    const lower = tiedSummary('a-receipt');
    const upper = tiedSummary('Z-receipt');
    expect(pickBestRepresentativeReceiptId([lower, upper])).toBe('Z-receipt');
    expect(pickBestRepresentativeReceiptId([upper, lower])).toBe('Z-receipt');

    const lowerRow = makeReceipt('a-receipt');
    const upperRow = makeReceipt('Z-receipt');
    const receiptById = new Map<string, ReceiptRow>([
      [lowerRow.id, lowerRow],
      [upperRow.id, upperRow],
    ]);
    const summaries = [lowerRow, upperRow].map(summarizeReceiptForDuplicateAudit);
    expect(pickBestRepresentativeReceiptId(summaries, receiptById)).toBe('Z-receipt');
    expect(
      pickBestRepresentativeReceiptId([...summaries].reverse(), receiptById)
    ).toBe('Z-receipt');
  });

  it('keeps one deterministic partition for an overlapping non-clique', () => {
    const [branchA, genericB, branchC] = nonCliqueReceipts();
    const summaryA = summarizeReceiptForDuplicateAudit(branchA!);
    const summaryB = summarizeReceiptForDuplicateAudit(genericB!);
    const summaryC = summarizeReceiptForDuplicateAudit(branchC!);
    expect(evaluateCanonicalPurchaseOccurrencePair(summaryA, summaryB)).toBe(true);
    expect(evaluateCanonicalPurchaseOccurrencePair(summaryB, summaryC)).toBe(true);
    expect(evaluateCanonicalPurchaseOccurrencePair(summaryA, summaryC)).toBe(false);

    expect(groupSnapshot(nonCliqueReceipts())).toEqual(NON_CLIQUE_GROUPS);
  });

  it('keeps the same partition and representatives for every input order', () => {
    for (const order of permutations(nonCliqueReceipts())) {
      expect(groupSnapshot(order)).toEqual(NON_CLIQUE_GROUPS);
    }
  });

  it('ignores a reversed or throwing localeCompare on these paths', () => {
    const reversed = function reversedLocaleCompare(this: string, other: string): number {
      const left = String(this);
      const right = String(other);
      if (left < right) return 1;
      if (left > right) return -1;
      return 0;
    };
    const throwing = function throwingLocaleCompare(): number {
      throw new Error('localeCompare must not decide this order');
    };

    const tied = withLocaleCompare(throwing, () =>
      pickBestRepresentativeReceiptId([
        tiedSummary('a-receipt'),
        tiedSummary('Z-receipt'),
      ])
    );
    expect(tied).toBe('Z-receipt');

    const grouped = withLocaleCompare(reversed, () => groupSnapshot(nonCliqueReceipts()));
    expect(grouped).toEqual(NON_CLIQUE_GROUPS);
  });

  it('keeps verified occurrence identity ahead of id order', () => {
    const lower = makeReceipt('a-receipt', { verifiedId: 'vpo_a' });
    const upper = makeReceipt('Z-receipt', { verifiedId: 'vpo_z' });
    const split = groupSnapshot([lower, upper]);
    expect(split).toEqual([
      {
        receiptIds: ['Z-receipt'],
        representativeReceiptId: 'Z-receipt',
        occurrenceKey: 'verified:vpo_z',
      },
      {
        receiptIds: ['a-receipt'],
        representativeReceiptId: 'a-receipt',
        occurrenceKey: 'verified:vpo_a',
      },
    ]);

    const together = groupSnapshot([
      makeReceipt('a-receipt', { verifiedId: 'vpo_same' }),
      makeReceipt('Z-receipt', { verifiedId: 'vpo_same' }),
    ]);
    expect(together).toEqual([
      {
        receiptIds: ['Z-receipt', 'a-receipt'],
        representativeReceiptId: 'Z-receipt',
        occurrenceKey: 'verified:vpo_same',
      },
    ]);
  });
});
