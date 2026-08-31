/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import {
  evaluateExactTransactionReceiptCollision,
} from './receiptExactTransactionCollision';
import {
  cloneCollisionReceipt,
  collisionItems,
  makeYorkCollisionReceiptA,
  makeYorkCollisionReceiptB,
  makeYorkCollisionReceiptC,
} from './receiptExactTransactionCollision.testFixtures';

describe('exact-transaction receipt collision (Level 1/2 only)', () => {
  const pairCases = [
    ['A/B', makeYorkCollisionReceiptA, makeYorkCollisionReceiptB],
    ['A/C', makeYorkCollisionReceiptA, makeYorkCollisionReceiptC],
    ['B/C', makeYorkCollisionReceiptB, makeYorkCollisionReceiptC],
  ] as const;

  it.each(pairCases)('real York fixture %s collides', (_label, makeLeft, makeRight) => {
    const result = evaluateExactTransactionReceiptCollision(
      makeLeft(),
      makeRight()
    );
    expect(result).toEqual(
      expect.objectContaining({
        collided: true,
        retailerKey: 'york_benimaru',
        transactionAt: 1_782_791_700_000,
        total: 4102,
        tax: 303,
        itemCount: 19,
      })
    );
  });

  it('uses one evidenceKey for all equivalent York observation pairs', () => {
    const results = pairCases.map(([, makeLeft, makeRight]) =>
      evaluateExactTransactionReceiptCollision(makeLeft(), makeRight())
    );
    expect(results.every((result) => result.collided)).toBe(true);
    const keys = results.flatMap((result) =>
      result.collided ? [result.evidenceKey] : []
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('does not use OCR product names or receipt IDs in evidenceKey', () => {
    const a = makeYorkCollisionReceiptA();
    const b = makeYorkCollisionReceiptB();
    const first = evaluateExactTransactionReceiptCollision(a, b);
    const renamed = cloneCollisionReceipt(b, {
      id: 'different-observation-id',
      items: collisionItems(b).map((item, index) => ({
        ...item,
        name: `OCR variance ${index}`,
      })),
    });
    const second = evaluateExactTransactionReceiptCollision(a, renamed);
    expect(first.collided).toBe(true);
    expect(second.collided).toBe(true);
    if (first.collided && second.collided) {
      expect(second.evidenceKey).toBe(first.evidenceKey);
    }
  });

  it.each([
    ['blank', (item: Record<string, unknown>) => ({ ...item, name: '' })],
    ['null', (item: Record<string, unknown>) => ({ ...item, name: null })],
    [
      'missing',
      (item: Record<string, unknown>) => {
        const { name: _name, ...withoutName } = item;
        return withoutName;
      },
    ],
  ])('does not require a %s OCR item name', (_label, changeName) => {
    const a = makeYorkCollisionReceiptA();
    const items = collisionItems(a).map((item) => ({ ...item }));
    items[0] = changeName(items[0]!);
    expect(
      evaluateExactTransactionReceiptCollision(
        cloneCollisionReceipt(a, { items }),
        makeYorkCollisionReceiptB()
      ).collided
    ).toBe(true);
  });

  it('allows every OCR name to differ when the ordered monetary basket is exact', () => {
    const b = makeYorkCollisionReceiptB();
    const renamed = collisionItems(b).map((item, index) => ({
      ...item,
      name: `unrelated OCR observation ${index}`,
    }));
    expect(
      evaluateExactTransactionReceiptCollision(
        makeYorkCollisionReceiptA(),
        cloneCollisionReceipt(b, { items: renamed })
      ).collided
    ).toBe(true);
  });

  it('preserves user_items_json precedence over the OCR analysis basket', () => {
    const a = makeYorkCollisionReceiptA();
    const b = makeYorkCollisionReceiptB();
    const userBasket = collisionItems(a).map((item, index) => ({
      ...item,
      ...(index === 0 ? { name: '' } : {}),
    }));
    const mismatchedOcr = collisionItems(b).map((item) => ({ ...item }));
    mismatchedOcr[0] = { ...mismatchedOcr[0], lineTotal: 999 };

    const userA = cloneCollisionReceipt(a, {
      user_items_json: JSON.stringify(userBasket),
      final_total: 4102,
    });
    const userB = cloneCollisionReceipt(b, {
      user_items_json: JSON.stringify(userBasket),
      final_total: 4102,
      items: mismatchedOcr,
    });
    expect(evaluateExactTransactionReceiptCollision(userA, userB).collided).toBe(
      true
    );
  });

  it('does not fall back to OCR items when nonempty user_items_json is malformed', () => {
    expect(
      evaluateExactTransactionReceiptCollision(
        cloneCollisionReceipt(makeYorkCollisionReceiptA(), {
          user_items_json: '{malformed',
        }),
        makeYorkCollisionReceiptB()
      )
    ).toEqual({ collided: false, reason: 'basket_invalid' });
  });

  it.each([
    ['line amount', { lineTotal: 430 }],
    ['quantity', { quantity: 2 }],
  ])('still rejects a blank-name row with a different %s', (_label, patch) => {
    const b = makeYorkCollisionReceiptB();
    const items = collisionItems(b).map((item) => ({ ...item }));
    items[0] = { ...items[0], name: '', ...patch };
    expect(
      evaluateExactTransactionReceiptCollision(
        makeYorkCollisionReceiptA(),
        cloneCollisionReceipt(b, { items })
      )
    ).toEqual({ collided: false, reason: 'basket_mismatch' });
  });

  it('changes evidenceKey when authorized material purchase evidence changes', () => {
    const baseA = makeYorkCollisionReceiptA();
    const baseB = makeYorkCollisionReceiptB();
    const base = evaluateExactTransactionReceiptCollision(baseA, baseB);
    expect(base.collided).toBe(true);
    if (!base.collided) return;

    const laterA = cloneCollisionReceipt(baseA, {
      transaction_at: baseA.transaction_at! + 60_000,
    });
    const laterB = cloneCollisionReceipt(baseB, {
      transaction_at: baseB.transaction_at! + 60_000,
    });
    const later = evaluateExactTransactionReceiptCollision(laterA, laterB);

    const taxed = evaluateExactTransactionReceiptCollision(
      cloneCollisionReceipt(baseA, { tax: 304 }),
      cloneCollisionReceipt(baseB, { tax: 304 })
    );

    const otherStore = evaluateExactTransactionReceiptCollision(
      baseA,
      cloneCollisionReceipt(baseB, {
        merchant_raw: 'ヨークベニマル 泉店',
        merchant_normalized: 'ヨークベニマル 泉店',
      })
    );

    const changedItemsA = collisionItems(baseA).map((item) => ({ ...item }));
    const changedItemsB = collisionItems(baseB).map((item) => ({ ...item }));
    changedItemsA[0] = { ...changedItemsA[0], lineTotal: 430 };
    changedItemsB[0] = { ...changedItemsB[0], lineTotal: 430 };
    const changedBasketAndTotal = evaluateExactTransactionReceiptCollision(
      cloneCollisionReceipt(baseA, { total: 4103, items: changedItemsA }),
      cloneCollisionReceipt(baseB, { total: 4103, items: changedItemsB })
    );

    const reorderedItemsA = collisionItems(baseA).map((item) => ({ ...item }));
    const reorderedItemsB = collisionItems(baseB).map((item) => ({ ...item }));
    [reorderedItemsA[0], reorderedItemsA[2]] = [
      reorderedItemsA[2]!,
      reorderedItemsA[0]!,
    ];
    [reorderedItemsB[0], reorderedItemsB[2]] = [
      reorderedItemsB[2]!,
      reorderedItemsB[0]!,
    ];
    const reordered = evaluateExactTransactionReceiptCollision(
      cloneCollisionReceipt(baseA, { items: reorderedItemsA }),
      cloneCollisionReceipt(baseB, { items: reorderedItemsB })
    );

    const changedQuantityItemsA = collisionItems(baseA).map((item) => ({
      ...item,
    }));
    const changedQuantityItemsB = collisionItems(baseB).map((item) => ({
      ...item,
    }));
    changedQuantityItemsA[0] = {
      ...changedQuantityItemsA[0],
      quantity: 2,
    };
    changedQuantityItemsB[0] = {
      ...changedQuantityItemsB[0],
      quantity: 2,
    };
    const changedQuantity = evaluateExactTransactionReceiptCollision(
      cloneCollisionReceipt(baseA, { items: changedQuantityItemsA }),
      cloneCollisionReceipt(baseB, { items: changedQuantityItemsB })
    );

    for (const changed of [
      later,
      taxed,
      otherStore,
      changedBasketAndTotal,
      reordered,
      changedQuantity,
    ]) {
      expect(changed.collided).toBe(true);
      if (changed.collided) {
        expect(changed.evidenceKey).not.toBe(base.evidenceKey);
      }
    }
  });

  it('does not issue an evidenceKey for a changed unsupported currency', () => {
    expect(
      evaluateExactTransactionReceiptCollision(
        cloneCollisionReceipt(makeYorkCollisionReceiptA(), { currency: 'USD' }),
        cloneCollisionReceipt(makeYorkCollisionReceiptB(), { currency: 'USD' })
      )
    ).toEqual({ collided: false, reason: 'currency_not_supported' });
  });

  it('requires distinct persisted observation IDs', () => {
    const a = makeYorkCollisionReceiptA();
    const sameId = cloneCollisionReceipt(makeYorkCollisionReceiptB(), { id: a.id });
    expect(evaluateExactTransactionReceiptCollision(a, sameId)).toEqual({
      collided: false,
      reason: 'same_receipt',
    });
  });

  it.each([
    [
      'different exact transaction',
      (row: ReturnType<typeof makeYorkCollisionReceiptB>) =>
        cloneCollisionReceipt(row, { transaction_at: row.transaction_at! + 60_000 }),
      'transaction_time_mismatch',
    ],
    [
      'missing transaction',
      (row: ReturnType<typeof makeYorkCollisionReceiptB>) =>
        cloneCollisionReceipt(row, { transaction_at: null }),
      'transaction_time_not_exact',
    ],
    [
      'date-only midnight transaction',
      (row: ReturnType<typeof makeYorkCollisionReceiptB>) =>
        cloneCollisionReceipt(row, {
          transaction_at: Date.parse('2026-06-30T00:00:00+09:00'),
        }),
      'transaction_time_not_exact',
    ],
    [
      'different tax',
      (row: ReturnType<typeof makeYorkCollisionReceiptB>) =>
        cloneCollisionReceipt(row, { tax: 304 }),
      'tax_mismatch',
    ],
    [
      'tax unknown',
      (row: ReturnType<typeof makeYorkCollisionReceiptB>) =>
        cloneCollisionReceipt(row, { tax_is_known: 0 }),
      'tax_not_known',
    ],
    [
      'non-JPY',
      (row: ReturnType<typeof makeYorkCollisionReceiptB>) =>
        cloneCollisionReceipt(row, { currency: 'USD' }),
      'currency_not_supported',
    ],
    [
      'different total',
      (row: ReturnType<typeof makeYorkCollisionReceiptB>) =>
        cloneCollisionReceipt(row, { total: 4103 }),
      'total_mismatch',
    ],
    [
      'non-receipt OCR source',
      (row: ReturnType<typeof makeYorkCollisionReceiptB>) =>
        cloneCollisionReceipt(row, { transaction_source: 'manual' }),
      'unsupported_transaction_source',
    ],
  ])('%s fails closed', (_name, mutate, reason) => {
    const result = evaluateExactTransactionReceiptCollision(
      makeYorkCollisionReceiptA(),
      mutate(makeYorkCollisionReceiptB())
    );
    expect(result).toEqual({ collided: false, reason });
  });

  it.each([undefined, null, 'manual'] as const)(
    'fails closed for historical transaction_source=%p',
    (transactionSource) => {
      expect(
        evaluateExactTransactionReceiptCollision(
          makeYorkCollisionReceiptA(),
          cloneCollisionReceipt(makeYorkCollisionReceiptB(), {
            transaction_source: transactionSource,
          })
        )
      ).toEqual({
        collided: false,
        reason: 'unsupported_transaction_source',
      });
    }
  );

  it('allows one missing store hint when the exact retailer agrees', () => {
    expect(
      evaluateExactTransactionReceiptCollision(
        makeYorkCollisionReceiptA(),
        makeYorkCollisionReceiptB()
      ).collided
    ).toBe(true);
  });

  it('rejects different non-null observed store hints', () => {
    const result = evaluateExactTransactionReceiptCollision(
      makeYorkCollisionReceiptB(),
      cloneCollisionReceipt(makeYorkCollisionReceiptC(), {
        merchant_raw: 'ヨークベニマル郡山店',
        merchant_normalized: 'ヨークベニマル郡山店',
      })
    );
    expect(result).toEqual({ collided: false, reason: 'store_hint_conflict' });
  });

  it.each([
    ['quantity', (items: Record<string, unknown>[]) => {
      items[0] = { ...items[0], quantity: 2 };
    }],
    ['line amount', (items: Record<string, unknown>[]) => {
      items[0] = { ...items[0], lineTotal: 430 };
    }],
    ['order', (items: Record<string, unknown>[]) => {
      [items[0], items[2]] = [items[2]!, items[0]!];
    }],
  ])('different aligned basket %s fails closed', (_name, mutate) => {
    const b = makeYorkCollisionReceiptB();
    const items = collisionItems(b).map((item) => ({ ...item }));
    mutate(items);
    const result = evaluateExactTransactionReceiptCollision(
      makeYorkCollisionReceiptA(),
      cloneCollisionReceipt(b, { items })
    );
    expect(result).toEqual({ collided: false, reason: 'basket_mismatch' });
  });

  it.each([
    ['line count', (items: Record<string, unknown>[]) => items.pop()],
    ['zero quantity', (items: Record<string, unknown>[]) => {
      items[0] = { ...items[0], quantity: 0 };
    }],
    ['zero line amount', (items: Record<string, unknown>[]) => {
      items[0] = { ...items[0], lineTotal: 0 };
    }],
  ])('invalid basket %s fails closed', (_name, mutate) => {
    const b = makeYorkCollisionReceiptB();
    const items = collisionItems(b).map((item) => ({ ...item }));
    mutate(items);
    expect(
      evaluateExactTransactionReceiptCollision(
        makeYorkCollisionReceiptA(),
        cloneCollisionReceipt(b, { items })
      ).collided
    ).toBe(false);
  });

  it('empty basket fails closed', () => {
    const result = evaluateExactTransactionReceiptCollision(
      cloneCollisionReceipt(makeYorkCollisionReceiptA(), { items: [] }),
      cloneCollisionReceipt(makeYorkCollisionReceiptB(), { items: [] })
    );
    expect(result).toEqual({ collided: false, reason: 'basket_invalid' });
  });

  it('incoherent monetary evidence fails closed', () => {
    const a = makeYorkCollisionReceiptA();
    const b = makeYorkCollisionReceiptB();
    const incoherentA = collisionItems(a).map((item) => ({ ...item }));
    const incoherentB = collisionItems(b).map((item) => ({ ...item }));
    incoherentA[0] = { ...incoherentA[0], lineTotal: 500 };
    incoherentB[0] = { ...incoherentB[0], lineTotal: 500 };
    const result = evaluateExactTransactionReceiptCollision(
      cloneCollisionReceipt(a, { items: incoherentA }),
      cloneCollisionReceipt(b, { items: incoherentB })
    );
    expect(result).toEqual({
      collided: false,
      reason: 'monetary_evidence_not_coherent',
    });
  });

  it('does not change Level 3 analytics grouping for the York fixture', () => {
    const selection = selectAnalyticsReceipts([
      makeYorkCollisionReceiptA(),
      makeYorkCollisionReceiptB(),
      makeYorkCollisionReceiptC(),
    ]);
    expect(selection.highConfidenceDuplicateGroups).toEqual([]);
    expect(selection.excludedDuplicateReceiptIds.size).toBe(0);
    expect(selection.analyticsPurchaseCandidateCount).toBe(3);
  });
});
