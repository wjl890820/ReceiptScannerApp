/**
 * A2.2 — verified purchase occurrence is canonical purchase truth.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from './db';
import {
  buildCanonicalPurchaseOccurrenceIndex,
  retainOccurrenceRepresentativeReceipts,
} from './canonicalPurchaseOccurrence';
import { buildPurchaseEventDatesFromRows } from './repeatProductProfile';
import { buildProductPriceHistory } from './productPriceHistory';
import type { ProductPriceHistoryRow } from './productPriceHistory';
import { deriveExactLogicalPurchaseMemberSet } from './logicalPurchaseEditPartition';
import { resolveHistoryPurchaseDeleteIds } from './historyPurchaseTruth';
import {
  assignVerifiedPurchaseOccurrenceWithDb,
} from './verifiedPurchaseOccurrence';
import * as analyticsCache from './analyticsReceiptSelectionCache';

const TX = Date.parse('2024-03-15T12:00:00+09:00');
const VERIFIED_AT = 1_700_000_100_000;

function itemsOf(name: string) {
  return [{ name, quantity: 1, lineTotal: 1200 }];
}

function makeReceipt(
  id: string,
  opts: {
    precision?: 'second' | 'minute';
    transactionAt?: number;
    createdAt?: number;
    items?: Array<{ name: string; quantity: number; lineTotal: number }>;
    verifiedId?: string | null;
    verifiedSource?: string | null;
    verifiedAt?: number | null;
    total?: number;
  } = {}
): ReceiptRow {
  const precision = opts.precision ?? 'minute';
  const itemList = opts.items ?? itemsOf('MILK');
  const total = opts.total ?? 1200;
  const txAt = opts.transactionAt ?? TX;
  const analysis: Record<string, unknown> = {
    merchant: 'MARKET',
    total,
    tax: 100,
    tax_is_known: true,
    currency: 'JPY',
    is_grocery: true,
    merchant_type: 'supermarket',
    items: itemList,
    transaction_time_precision: precision,
    transactionDate:
      precision === 'second' ? '2024-03-15 12:00:00' : '2024-03-15 12:00',
  };
  return {
    id,
    created_at: opts.createdAt ?? 2_000,
    transaction_at: txAt,
    transaction_time_precision: precision,
    image_uri: '',
    merchant_raw: 'MARKET',
    merchant_normalized: 'MARKET',
    merchant_type: 'supermarket',
    total,
    tax: 100,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify(analysis),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    verified_purchase_occurrence_id: opts.verifiedId ?? null,
    verified_purchase_occurrence_source: opts.verifiedSource ?? null,
    verified_purchase_occurrence_verified_at: opts.verifiedAt ?? null,
  };
}

function assigned(
  id: string,
  verifiedId: string,
  extra: Parameters<typeof makeReceipt>[1] = {}
): ReceiptRow {
  return makeReceipt(id, {
    ...extra,
    verifiedId,
    verifiedSource: 'research_verified',
    verifiedAt: VERIFIED_AT,
  });
}

function groupIds(receipts: ReceiptRow[]): string[][] {
  return buildCanonicalPurchaseOccurrenceIndex(receipts).groups.map((g) => [
    ...g.receiptIds,
  ]);
}

function permute<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permute(rest)) out.push([items[i]!, ...tail]);
  }
  return out;
}

function pphRows(receipts: ReceiptRow[]): ProductPriceHistoryRow[] {
  return receipts.map((receipt) => ({
    receiptId: receipt.id,
    itemId: `${receipt.id}:0`,
    sourceIndex: 0,
    occurredAt: receipt.transaction_at ?? receipt.created_at,
    merchantRaw: receipt.merchant_raw,
    merchantNormalized: receipt.merchant_normalized,
    displayName: 'MILK',
    currency: 'JPY',
    lineTotal: 1200,
    purchaseQuantity: 1,
    skuKey: null,
    productFamilyKey: null,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: null,
    grossLineAmount: 1200,
    effectiveLineAmount: 1200,
    discountAllocated: 0,
    receiptAnalysisJson: receipt.analysis_json,
    receiptTotal: receipt.total,
    receiptTax: receipt.tax,
    receiptTaxIsKnown: 1,
    receiptCurrency: 'JPY',
    receiptTransactionAt: receipt.transaction_at,
    receiptCreatedAt: receipt.created_at,
  }));
}

describe('A2.2 verified purchase occurrence truth', () => {
  it('1–3 — same verified id is one occurrence despite minute precision and basket variation', () => {
    const pair = [
      assigned('m1', 'vpo_g', { precision: 'minute' }),
      assigned('m2', 'vpo_g', { precision: 'minute', createdAt: 3_000 }),
    ];
    const index = buildCanonicalPurchaseOccurrenceIndex(pair);
    expect(index.groups).toHaveLength(1);
    expect(index.groups[0]!.occurrenceId).toBe('vpo_g');
    expect(index.groups[0]!.occurrenceKey).toBe('verified:vpo_g');
    expect(index.groups[0]!.verifiedPurchaseOccurrenceId).toBe('vpo_g');
    expect(pair[0]!.transaction_time_precision).toBe('minute');

    const seven = Array.from({ length: 7 }, (_, i) =>
      assigned(`s${i}`, 'vpo_seven', { precision: 'minute', createdAt: 100 + i })
    );
    const sevenIndex = buildCanonicalPurchaseOccurrenceIndex(seven);
    expect(sevenIndex.groups).toHaveLength(1);
    expect(retainOccurrenceRepresentativeReceipts(seven)).toHaveLength(1);

    const varied = [
      assigned('b1', 'vpo_basket', {
        precision: 'minute',
        items: itemsOf('MILK'),
      }),
      assigned('b2', 'vpo_basket', {
        precision: 'minute',
        items: itemsOf('BREAD OCR'),
        createdAt: 9_000,
      }),
    ];
    expect(groupIds(varied)).toEqual([['b1', 'b2']]);
  });

  it('4–5, 8 — different verified ids never merge, even with a bridging unassigned receipt', () => {
    const separated = [
      assigned('a', 'vpo_g1', { precision: 'second' }),
      assigned('b', 'vpo_g2', { precision: 'second', createdAt: 3 }),
    ];
    const sep = buildCanonicalPurchaseOccurrenceIndex(separated);
    expect(sep.groups).toHaveLength(2);
    expect(sep.groups.map((g) => g.occurrenceId).sort()).toEqual([
      'vpo_g1',
      'vpo_g2',
    ]);

    const bridge = [
      assigned('g1a', 'vpo_g1', { precision: 'second' }),
      assigned('g1b', 'vpo_g1', { precision: 'second', createdAt: 2 }),
      assigned('g2a', 'vpo_g2', { precision: 'second', createdAt: 3 }),
      assigned('g2b', 'vpo_g2', { precision: 'second', createdAt: 4 }),
      makeReceipt('u', { precision: 'second', createdAt: 5 }),
    ];
    const bridged = buildCanonicalPurchaseOccurrenceIndex(bridge);
    for (const group of bridged.groups) {
      const ids = group.receiptIds.map(
        (id) => bridge.find((r) => r.id === id)!.verified_purchase_occurrence_id
      );
      const verified = new Set(ids.filter((id): id is string => !!id));
      expect(verified.size).toBeLessThanOrEqual(1);
    }
    const g1 = bridged.occurrenceIdByReceiptId.get('g1a');
    const g2 = bridged.occurrenceIdByReceiptId.get('g2a');
    expect(g1).toBe('verified:vpo_g1');
    expect(g2).toBe('verified:vpo_g2');
    expect(g1).not.toBe(g2);
  });

  it('6–7 — unassigned joins a verified group only by complete-link', () => {
    const milk = itemsOf('MILK');
    const bread = [{ name: 'BREAD', quantity: 2, lineTotal: 100 }];
    const group = [
      assigned('a', 'vpo_g', { precision: 'second', items: milk, createdAt: 1 }),
      assigned('b', 'vpo_g', {
        precision: 'second',
        items: bread,
        total: 100,
        createdAt: 2,
      }),
    ];
    const compatibleWithAll = makeReceipt('u-yes', {
      precision: 'second',
      items: milk,
      createdAt: 3,
    });
    // Matches A pairwise, not B — must not join the verified seed.
    expect(groupIds([...group, compatibleWithAll])).toEqual([
      ['a', 'b'],
      ['u-yes'],
    ]);

    const uniform = [
      assigned('a2', 'vpo_same', { precision: 'second', items: milk, createdAt: 1 }),
      assigned('b2', 'vpo_same', { precision: 'second', items: milk, createdAt: 2 }),
      makeReceipt('u-join', { precision: 'second', items: milk, createdAt: 3 }),
    ];
    expect(groupIds(uniform)).toEqual([['a2', 'b2', 'u-join']]);

    const incompatible = makeReceipt('u-no', {
      precision: 'minute',
      items: itemsOf('OTHER'),
      transactionAt: TX + 86_400_000,
    });
    expect(
      groupIds([
        assigned('x', 'vpo_x', { precision: 'minute' }),
        assigned('y', 'vpo_x', { precision: 'minute' }),
        incompatible,
      ])
    ).toEqual([['u-no'], ['x', 'y']]);
  });

  it('9 — input order does not change verified grouping', () => {
    const receipts = [
      assigned('p', 'vpo_p', { precision: 'minute', createdAt: 3 }),
      assigned('q', 'vpo_p', { precision: 'minute', createdAt: 1 }),
      assigned('r', 'vpo_q', { precision: 'minute', createdAt: 2 }),
    ];
    const signatures = permute(receipts).map((order) =>
      JSON.stringify(
        buildCanonicalPurchaseOccurrenceIndex(order).groups.map((g) => ({
          occurrenceId: g.occurrenceId,
          receiptIds: g.receiptIds,
          representativeReceiptId: g.representativeReceiptId,
        }))
      )
    );
    expect(new Set(signatures).size).toBe(1);
  });

  it('10 — no verified provenance preserves derived occurrence ids', () => {
    const split = [
      makeReceipt('d1', {
        precision: 'second',
        transactionAt: TX,
      }),
      makeReceipt('d2', {
        precision: 'second',
        transactionAt: TX + 86_400_000,
      }),
    ];
    const splitIndex = buildCanonicalPurchaseOccurrenceIndex(split);
    expect(splitIndex.groups).toHaveLength(2);
    expect(splitIndex.groups.map((g) => g.occurrenceId).sort()).toEqual([
      'd1',
      'd2',
    ]);
    expect(splitIndex.groups.every((g) => !g.verifiedPurchaseOccurrenceId)).toBe(
      true
    );

    const merged = [
      makeReceipt('e2', { precision: 'second', createdAt: 2 }),
      makeReceipt('e1', { precision: 'second', createdAt: 1 }),
    ];
    const mergedIndex = buildCanonicalPurchaseOccurrenceIndex(merged);
    expect(mergedIndex.groups).toHaveLength(1);
    expect(mergedIndex.groups[0]!.occurrenceId).toBe('e1');
  });

  it('11–15 — representative, analytics, repeat, and PPH count one event', () => {
    const receipts = [
      assigned('rep-late', 'vpo_rep', { precision: 'minute', createdAt: 50 }),
      assigned('rep-early', 'vpo_rep', { precision: 'minute', createdAt: 10 }),
    ];
    const index = buildCanonicalPurchaseOccurrenceIndex(receipts);
    expect(index.groups[0]!.representativeReceiptId).toBe('rep-early');
    expect(
      buildCanonicalPurchaseOccurrenceIndex([receipts[1]!, receipts[0]!])
        .groups[0]!.representativeReceiptId
    ).toBe('rep-early');

    const seven = Array.from({ length: 7 }, (_, i) =>
      assigned(`n${i}`, 'vpo_n', { precision: 'minute', createdAt: i + 1 })
    );
    const reps = retainOccurrenceRepresentativeReceipts(seven);
    expect(reps).toHaveLength(1);
    const dates = buildPurchaseEventDatesFromRows(
      seven.map((r) => ({
        receiptId: r.id,
        occurredAt: r.transaction_at ?? r.created_at,
      })),
      {
        purchaseOccurrenceIdByReceiptId:
          buildCanonicalPurchaseOccurrenceIndex(seven).occurrenceIdByReceiptId,
        representativeReceiptIdByReceiptId:
          buildCanonicalPurchaseOccurrenceIndex(seven)
            .representativeReceiptIdByReceiptId,
      }
    );
    expect(dates.purchaseOccurrenceCount).toBe(1);

    const history = buildProductPriceHistory(
      { type: 'sku', key: 'milk' },
      pphRows(seven),
      {
        purchaseOccurrenceIndex: buildCanonicalPurchaseOccurrenceIndex(seven),
        canonicalDuplicateSelectionApplied: true,
      }
    );
    expect(history.totalOccurrenceCount).toBe(1);

    const hardNeg = [
      assigned('h1', 'vpo_a', { precision: 'second' }),
      assigned('h2', 'vpo_b', { precision: 'second' }),
    ];
    const negIndex = buildCanonicalPurchaseOccurrenceIndex(hardNeg);
    const negDates = buildPurchaseEventDatesFromRows(
      hardNeg.map((r) => ({
        receiptId: r.id,
        occurredAt: r.transaction_at ?? r.created_at,
      })),
      {
        purchaseOccurrenceIdByReceiptId: negIndex.occurrenceIdByReceiptId,
        representativeReceiptIdByReceiptId:
          negIndex.representativeReceiptIdByReceiptId,
      }
    );
    expect(negDates.purchaseOccurrenceCount).toBe(2);
    const negHistory = buildProductPriceHistory(
      { type: 'sku', key: 'milk' },
      pphRows(hardNeg),
      {
        purchaseOccurrenceIndex: negIndex,
        canonicalDuplicateSelectionApplied: true,
      }
    );
    expect(negHistory.totalOccurrenceCount).toBe(2);
  });

  it('16 — logical edit and delete treat a verified group as one purchase', () => {
    const rows = [
      assigned('edit-a', 'vpo_edit', { precision: 'minute' }),
      assigned('edit-b', 'vpo_edit', { precision: 'minute', createdAt: 8 }),
      assigned('edit-c', 'vpo_other', { precision: 'minute', createdAt: 9 }),
    ];
    expect(deriveExactLogicalPurchaseMemberSet('edit-a', rows)).toEqual([
      'edit-a',
      'edit-b',
    ]);
    expect(deriveExactLogicalPurchaseMemberSet('edit-c', rows)).toEqual([
      'edit-c',
    ]);
    expect(resolveHistoryPurchaseDeleteIds(['edit-b'], rows).sort()).toEqual([
      'edit-a',
      'edit-b',
    ]);
  });

  it('19 — malformed provenance does not create a hard-positive merge', () => {
    const rows = [
      makeReceipt('bad-a', {
        precision: 'minute',
        verifiedId: 'vpo_partial',
        verifiedSource: null,
        verifiedAt: null,
      }),
      makeReceipt('bad-b', {
        precision: 'minute',
        verifiedId: 'vpo_partial',
        verifiedSource: null,
        verifiedAt: null,
        createdAt: 4,
      }),
    ];
    const index = buildCanonicalPurchaseOccurrenceIndex(rows);
    expect(index.groups).toHaveLength(2);
    expect(index.groups.every((g) => !g.verifiedPurchaseOccurrenceId)).toBe(
      true
    );
  });

  it('17–18 — assignment success invalidates caches; failure does not', async () => {
    const spy = jest.spyOn(
      analyticsCache,
      'invalidateAnalyticsReceiptSelection'
    );
    spy.mockClear();

    const receipts = new Map<string, { id: string; user_id: string }>();
    receipts.set('r1', { id: 'r1', user_id: 'user' });
    receipts.set('r2', { id: 'r2', user_id: 'user' });
    let exclusive: Promise<void> = Promise.resolve();
    let updates = 0;
    let failSecond = true;
    const db: {
      getAllAsync: () => Promise<unknown[]>;
      withExclusiveTransactionAsync: (
        task: (txn: {
          getAllAsync: () => Promise<unknown[]>;
          runAsync: (sql: string) => Promise<{ changes: number }>;
        }) => Promise<void>
      ) => Promise<void>;
      runAsync: (sql: string) => Promise<{ changes: number }>;
    } = {
      async getAllAsync() {
        return [...receipts.values()].map((row) => ({
          ...row,
          verified_purchase_occurrence_id: null,
          verified_purchase_occurrence_source: null,
          verified_purchase_occurrence_verified_at: null,
        }));
      },
      async withExclusiveTransactionAsync(task) {
        const prev = exclusive;
        let release!: () => void;
        exclusive = new Promise((resolve) => {
          release = resolve;
        });
        await prev;
        try {
          await task(db);
        } finally {
          release();
        }
      },
      async runAsync(sql: string) {
        if (/UPDATE receipts/i.test(sql)) {
          updates += 1;
          if (failSecond && updates === 2) throw new Error('forced failure');
          return { changes: 1 };
        }
        if (/sync_outbox/i.test(sql)) return { changes: 1 };
        return { changes: 0 };
      },
    };

    await expect(
      assignVerifiedPurchaseOccurrenceWithDb(db as never, {
        userId: 'user',
        receiptIds: ['r1', 'r2'],
        source: 'research_verified',
        verifiedAt: VERIFIED_AT,
        nowMs: VERIFIED_AT,
      })
    ).rejects.toThrow(/forced failure/);
    expect(spy).not.toHaveBeenCalled();

    failSecond = false;
    updates = 0;
    await assignVerifiedPurchaseOccurrenceWithDb(db as never, {
      userId: 'user',
      receiptIds: ['r1', 'r2'],
      source: 'research_verified',
      verifiedAt: VERIFIED_AT,
      nowMs: VERIFIED_AT,
    });
    expect(spy).toHaveBeenCalledWith('verified_purchase_occurrence_assigned');
    spy.mockRestore();
  });
});
