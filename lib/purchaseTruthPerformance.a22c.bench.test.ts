/**
 * A2.2c sparse ~2,000 receipt benchmark.
 * Cold timings for HC relation construction, canonical occurrence, and
 * buildEffectivePurchaseTruth. Not a dense all-equal duplicate graph.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from './db';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { summarizeReceiptForDuplicateAudit } from './analysisDDuplicateAudit';
import {
  __buildHighConfidenceDuplicateGroupsAllPairsForTests,
  buildHighConfidenceDuplicateGroups,
} from './analysisDDuplicateAudit';
import {
  __prepareCanonicalPurchaseOccurrenceEvidenceAllPairsForTests,
  buildCanonicalPurchaseOccurrenceIndex,
  buildCanonicalPurchaseOccurrenceIndexFromPrepared,
} from './canonicalPurchaseOccurrence';
import { buildEffectivePurchaseTruth } from './purchaseTruthPartition';

const TX0 = Date.parse('2024-01-01T09:00:00+09:00');
const VERIFIED_AT = 1_710_000_000_000;

function sparseReceipt(index: number): ReceiptRow {
  const at = TX0 + index * 86_400_000;
  const total = 100 + (index % 97);
  const merchant = `SHOP-${index}`;
  const analysis = {
    merchant,
    total,
    tax: 8,
    tax_is_known: true,
    currency: 'JPY',
    is_grocery: true,
    merchant_type: 'supermarket',
    items: [{ name: `ITEM-${index}`, quantity: 1, lineTotal: total }],
    transaction_time_precision: 'second',
    transactionDate: '2024-01-01 09:00:00',
  };
  return {
    id: `sparse-${index}`,
    created_at: at,
    transaction_at: at,
    transaction_time_precision: 'second',
    image_uri: '',
    merchant_raw: merchant,
    merchant_normalized: merchant,
    merchant_type: 'supermarket',
    total,
    tax: 8,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify(analysis),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    verified_purchase_occurrence_id: null,
    verified_purchase_occurrence_source: null,
    verified_purchase_occurrence_verified_at: null,
  };
}

function verifiedMinute(
  id: string,
  verifiedId: string,
  at: number
): ReceiptRow {
  const base = sparseReceipt(0);
  const analysis = {
    merchant: 'VERIFIED-SHOP',
    total: 480,
    tax: 8,
    tax_is_known: true,
    currency: 'JPY',
    is_grocery: true,
    merchant_type: 'supermarket',
    items: [{ name: 'MILK', quantity: 1, lineTotal: 480 }],
    transaction_time_precision: 'minute',
    transactionDate: '2024-06-01 09:00',
  };
  return {
    ...base,
    id,
    created_at: at,
    transaction_at: at,
    transaction_time_precision: 'minute',
    merchant_raw: 'VERIFIED-SHOP',
    merchant_normalized: 'VERIFIED-SHOP',
    total: 480,
    analysis_json: JSON.stringify(analysis),
    verified_purchase_occurrence_id: verifiedId,
    verified_purchase_occurrence_source: 'research_verified',
    verified_purchase_occurrence_verified_at: VERIFIED_AT,
  };
}

export function buildSparsePurchaseTruthCorpus(size = 2000): ReceiptRow[] {
  const unrelated = size - 9;
  const rows: ReceiptRow[] = [];
  for (let index = 0; index < unrelated; index += 1) {
    rows.push(sparseReceipt(index + 1));
  }
  const gAt = TX0 + 10 * 86_400_000;
  const hAt = TX0 + 40 * 86_400_000;
  rows.push(
    verifiedMinute('vg-1', 'vpo_bench_g', gAt),
    verifiedMinute('vg-2', 'vpo_bench_g', gAt + 60_000),
    verifiedMinute('vg-3', 'vpo_bench_g', gAt + 120_000),
    verifiedMinute('vh-1', 'vpo_bench_h', hAt),
    verifiedMinute('vh-2', 'vpo_bench_h', hAt + 60_000),
    sparseReceipt(unrelated + 1),
    sparseReceipt(unrelated + 2)
  );
  // One low-density exact duplicate pair.
  const dup = sparseReceipt(unrelated + 3);
  rows.push(dup, { ...dup, id: 'sparse-dup-copy', created_at: dup.created_at + 1 });
  return rows;
}

describe('A2.2c sparse benchmark', () => {
  it('measures HC, canonical, and effective truth on ~2000 sparse receipts', () => {
    const receipts = buildSparsePurchaseTruthCorpus(2000);
    expect(receipts).toHaveLength(2000);

    const hcStart = performance.now();
    selectAnalyticsReceipts(receipts);
    const hcMs = performance.now() - hcStart;

    const canonicalStart = performance.now();
    buildCanonicalPurchaseOccurrenceIndex(receipts);
    const canonicalMs = performance.now() - canonicalStart;

    const totalStart = performance.now();
    const truth = buildEffectivePurchaseTruth(receipts);
    const totalMs = performance.now() - totalStart;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        label: 'a22c-sparse-2000',
        hcMs: Math.round(hcMs),
        canonicalMs: Math.round(canonicalMs),
        totalMs: Math.round(totalMs),
        purchases: truth.purchases.length,
      })
    );
    expect(truth.purchases.length).toBeGreaterThan(1900);
    // Isolated run is well under a second. The cap stays far below the previous
    // ~26s all-pairs freeze even when Jest workers contend for CPU.
    expect(totalMs).toBeLessThan(8_000);
  }, 180_000);
});

function purchaseMemberSignature(
  truth: ReturnType<typeof buildEffectivePurchaseTruth>
): string[] {
  return truth.purchases
    .map((purchase) => [...purchase.memberReceiptIds].sort().join('+'))
    .sort();
}

function structuralReceipt(args: {
  id: string;
  itemName: string;
  currency: string;
  tax: number;
}): ReceiptRow {
  const at = Date.parse('2024-06-01T09:00:00+09:00');
  const base = sparseReceipt(1);
  return {
    ...base,
    id: args.id,
    created_at: at + (args.id === 'B' ? 1_000 : 0),
    transaction_at: at,
    transaction_time_precision: 'second',
    merchant_raw: 'AEON',
    merchant_normalized: 'AEON',
    total: 480,
    tax: args.tax,
    tax_is_known: 1,
    currency: args.currency,
    analysis_json: JSON.stringify({
      items: [{ name: args.itemName, quantity: 1, lineTotal: 480 }],
    }),
  };
}

describe('A2.2c effective purchase truth is recomputed', () => {
  it('separates a structural JPY pair after currency becomes USD without cache clearing', () => {
    const jpy = [
      structuralReceipt({ id: 'A', itemName: 'MILK', currency: 'JPY', tax: 8 }),
      structuralReceipt({ id: 'B', itemName: 'BREAD', currency: 'JPY', tax: 8 }),
    ];
    const usd = [
      jpy[0]!,
      structuralReceipt({ id: 'B', itemName: 'BREAD', currency: 'USD', tax: 8 }),
    ];

    const first = buildEffectivePurchaseTruth(jpy);
    const second = buildEffectivePurchaseTruth(usd);

    expect(purchaseMemberSignature(first)).toEqual(['A+B']);
    expect(purchaseMemberSignature(second)).toEqual(['A', 'B']);
    expect(second).not.toBe(first);
    expect(second.purchaseByReceiptId.get('A')?.memberReceiptIds).toEqual(['A']);
    expect(second.purchaseByReceiptId.get('B')?.memberReceiptIds).toEqual(['B']);
  });

  it('separates the same pair after a known tax change without cache clearing', () => {
    const equalTax = [
      structuralReceipt({ id: 'A', itemName: 'MILK', currency: 'JPY', tax: 8 }),
      structuralReceipt({ id: 'B', itemName: 'BREAD', currency: 'JPY', tax: 8 }),
    ];
    const changedTax = [
      equalTax[0]!,
      structuralReceipt({ id: 'B', itemName: 'BREAD', currency: 'JPY', tax: 80 }),
    ];

    const first = buildEffectivePurchaseTruth(equalTax);
    const second = buildEffectivePurchaseTruth(changedTax);

    expect(purchaseMemberSignature(first)).toEqual(['A+B']);
    expect(purchaseMemberSignature(second)).toEqual(['A', 'B']);
    expect(second).not.toBe(first);
  });
});

function groupSignature(
  groups: ReadonlyArray<{
    receiptIds: readonly string[];
    representativeReceiptId: string;
    occurrenceKey?: string;
    confidence?: string;
  }>
): string {
  return JSON.stringify(
    groups
      .map((group) => ({
        ids: [...group.receiptIds].sort(),
        rep: group.representativeReceiptId,
        key: group.occurrenceKey ?? null,
        confidence: group.confidence ?? null,
      }))
      .sort((a, b) => a.ids[0]!.localeCompare(b.ids[0]!))
  );
}

function effectiveSignature(rows: readonly ReceiptRow[]): string {
  const truth = buildEffectivePurchaseTruth(rows);
  return JSON.stringify(
    truth.purchases
      .map((purchase) => ({
        rep: purchase.representativeReceiptId,
        members: [...purchase.memberReceiptIds].sort(),
        active: purchase.verifiedActive,
        key: purchase.occurrenceKey,
      }))
      .sort(
        (a, b) =>
          a.members[0]!.localeCompare(b.members[0]!) ||
          a.rep.localeCompare(b.rep)
      )
  );
}

function mixReceipt(index: number, rand: () => number): ReceiptRow {
  const precision = rand() < 0.5 ? 'second' : 'minute';
  const at = Date.parse('2024-03-01T09:00:00+09:00') + Math.floor(rand() * 12) * 3_600_000;
  const total = 100 + Math.floor(rand() * 6) * 50;
  const merchant = rand() < 0.7 ? `M-${index}` : 'SHARED';
  const verifiedRoll = rand();
  const verifiedId =
    verifiedRoll < 0.15 ? 'vpo_same' : verifiedRoll < 0.3 ? `vpo_${index}` : null;
  const partial = verifiedId == null && rand() < 0.1;
  const analysis = {
    merchant,
    total,
    tax: 8,
    tax_is_known: rand() < 0.8,
    currency: 'JPY',
    is_grocery: true,
    merchant_type: 'supermarket',
    items: [
      {
        name: rand() < 0.5 ? 'MILK' : `ITEM-${index}`,
        quantity: rand() < 0.2 ? 2 : 1,
        lineTotal: total,
      },
    ],
    transaction_time_precision: precision,
    transactionDate: '2024-03-01 09:00:00',
  };
  return {
    id: `mix-${index}`,
    created_at: at + index,
    transaction_at: at,
    transaction_time_precision: precision,
    image_uri: '',
    merchant_raw: merchant,
    merchant_normalized: merchant,
    merchant_type: 'supermarket',
    total,
    tax: 8,
    tax_is_known: analysis.tax_is_known ? 1 : 0,
    currency: 'JPY',
    analysis_json: JSON.stringify(analysis),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    verified_purchase_occurrence_id: partial ? 'partial' : verifiedId,
    verified_purchase_occurrence_source:
      verifiedId && !partial ? 'research_verified' : null,
    verified_purchase_occurrence_verified_at:
      verifiedId && !partial ? 1_710_000_000_000 : null,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('A2.2c differential oracle', () => {
  it('matches the all-pairs reference on mixed synthetic universes', () => {
    for (let seed = 1; seed <= 24; seed += 1) {
      const rand = mulberry32(seed);
      const count = 8 + (seed % 7);
      const rows = Array.from({ length: count }, (_, index) =>
        mixReceipt(index, rand)
      );
      const summaries = rows.map((row) => summarizeReceiptForDuplicateAudit(row));
      const optimized = buildHighConfidenceDuplicateGroups(summaries, rows);
      const reference = __buildHighConfidenceDuplicateGroupsAllPairsForTests(
        summaries,
        rows
      );
      expect(groupSignature(optimized)).toBe(groupSignature(reference));

      const canonical = buildCanonicalPurchaseOccurrenceIndex(rows);
      const oracle = buildCanonicalPurchaseOccurrenceIndexFromPrepared(
        rows,
        __prepareCanonicalPurchaseOccurrenceEvidenceAllPairsForTests(rows)
      );
      expect(groupSignature(canonical.groups)).toBe(groupSignature(oracle.groups));

      const reversed = [...rows].reverse();
      expect(effectiveSignature(rows)).toBe(effectiveSignature(reversed));
      expect(groupSignature(buildCanonicalPurchaseOccurrenceIndex(reversed).groups)).toBe(
        groupSignature(canonical.groups)
      );
    }
  });
});
