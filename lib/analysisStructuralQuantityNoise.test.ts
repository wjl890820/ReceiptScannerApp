/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import type { ReceiptRow } from './db';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import {
  buildHighConfidenceDuplicateGroups,
  evaluateReconciledStructuralQuantityNoisePair,
  summarizeReceiptForDuplicateAudit,
} from './analysisDDuplicateAudit';
import { aggregateV1MerchantSpend } from './merchantAnalytics';
import { calculateStats } from './statsCalculator';

const TX_AT = Date.parse('2026-08-10T17:43:00+09:00');
const GYOMU_TX_AT = 1786351380000;
const NOW_MS = Date.parse('2026-09-01T12:00:00+09:00');

type FixtureItem = {
  name: string;
  category: string;
  lineTotal: number;
  quantity: number;
};

function makeReceipt(args: {
  id: string;
  items: FixtureItem[];
  total?: number;
  tax?: number;
  taxIsKnown?: number;
  transactionAt?: number;
  createdAt?: number;
  merchantNormalized?: string;
  currency?: string;
}): ReceiptRow {
  return {
    id: args.id,
    created_at: args.createdAt ?? TX_AT,
    transaction_at: args.transactionAt ?? TX_AT,
    image_uri: '',
    total: args.total ?? 300,
    tax: args.tax ?? 22,
    tax_is_known: args.taxIsKnown ?? 1,
    currency: args.currency ?? 'JPY',
    analysis_json: JSON.stringify({ items: args.items }),
    merchant_raw: args.merchantNormalized ?? '業務スーパー古川店',
    merchant_normalized: args.merchantNormalized ?? '業務スーパー古川店',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  } as ReceiptRow;
}

function pair(
  leftArgs: Parameters<typeof makeReceipt>[0],
  rightArgs: Parameters<typeof makeReceipt>[0]
) {
  return {
    left: summarizeReceiptForDuplicateAudit(makeReceipt(leftArgs)),
    right: summarizeReceiptForDuplicateAudit(makeReceipt(rightArgs)),
  };
}

const BASE_ITEMS: FixtureItem[] = [
  { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
  { name: 'B', category: 'food_ingredients', lineTotal: 200, quantity: 1 },
];

describe('reconciled structural quantity-noise duplicate safety', () => {
  it('accepts quantity drift when raw line-amount multiset is identical', () => {
    const { left, right } = pair(
      {
        id: 'a',
        total: 2056,
        items: [
          ...BASE_ITEMS,
          {
            name: 'pack',
            category: 'food_ingredients',
            lineTotal: 1756,
            quantity: 4,
          },
        ],
      },
      {
        id: 'b',
        total: 2056,
        items: [
          ...BASE_ITEMS,
          {
            name: 'pack',
            category: 'food_ingredients',
            lineTotal: 1756,
            quantity: 1,
          },
        ],
      }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toEqual({
      quantityConflictLineAmounts: [1756],
    });
  });

  it('accepts Gyomu-shaped single drift on unique ¥1756 line', () => {
    const { left, right } = pair(
      {
        id: 'a',
        total: 2557,
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 372, quantity: 1 },
          { name: 'B', category: 'food_ingredients', lineTotal: 378, quantity: 1 },
          { name: 'C', category: 'food_ingredients', lineTotal: 108, quantity: 1 },
          { name: 'D', category: 'food_ingredients', lineTotal: 313, quantity: 1 },
          { name: 'E', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'F', category: 'food_ingredients', lineTotal: 103, quantity: 1 },
          { name: 'G', category: 'food_ingredients', lineTotal: 88, quantity: 1 },
          {
            name: '正宗生煎包 (4個 x @439)',
            category: 'food_ingredients',
            lineTotal: 1756,
            quantity: 4,
          },
        ],
      },
      {
        id: 'b',
        total: 2557,
        items: [
          { name: 'G', category: 'food_ingredients', lineTotal: 88, quantity: 1 },
          { name: 'F', category: 'food_ingredients', lineTotal: 103, quantity: 1 },
          { name: 'E', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'D', category: 'food_ingredients', lineTotal: 313, quantity: 1 },
          { name: 'C', category: 'food_ingredients', lineTotal: 108, quantity: 1 },
          { name: 'B', category: 'food_ingredients', lineTotal: 378, quantity: 1 },
          { name: 'A', category: 'food_ingredients', lineTotal: 372, quantity: 1 },
          {
            name: '正宗生煎包',
            category: 'food_ingredients',
            lineTotal: 1756,
            quantity: 1,
          },
        ],
      }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toEqual({
      quantityConflictLineAmounts: [1756],
    });
  });

  it('rejects TWO OR MORE quantity mismatches', () => {
    const { left, right } = pair(
      {
        id: 'a',
        total: 600,
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'B', category: 'food_ingredients', lineTotal: 200, quantity: 1 },
          { name: 'C', category: 'food_ingredients', lineTotal: 300, quantity: 1 },
        ],
      },
      {
        id: 'b',
        total: 600,
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 2 },
          { name: 'B', category: 'food_ingredients', lineTotal: 200, quantity: 3 },
          { name: 'C', category: 'food_ingredients', lineTotal: 300, quantity: 1 },
        ],
      }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('rejects quantity mismatch when conflicting lineAmount is not unique in basket', () => {
    const { left, right } = pair(
      {
        id: 'a',
        total: 500,
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'B', category: 'food_ingredients', lineTotal: 100, quantity: 4 },
          { name: 'C', category: 'food_ingredients', lineTotal: 300, quantity: 1 },
        ],
      },
      {
        id: 'b',
        total: 500,
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 2 },
          { name: 'B', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'C', category: 'food_ingredients', lineTotal: 300, quantity: 1 },
        ],
      }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('rejects equal header/total but different raw line-amount multiset', () => {
    const { left, right } = pair(
      {
        id: 'a',
        total: 600,
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'B', category: 'food_ingredients', lineTotal: 200, quantity: 1 },
          { name: 'C', category: 'food_ingredients', lineTotal: 300, quantity: 1 },
        ],
      },
      {
        id: 'b',
        total: 600,
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'B', category: 'food_ingredients', lineTotal: 150, quantity: 1 },
          { name: 'C', category: 'food_ingredients', lineTotal: 350, quantity: 1 },
        ],
      }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('1. rejects when one raw lineAmount changes', () => {
    const { left, right } = pair(
      { id: 'a', total: 400, items: BASE_ITEMS },
      {
        id: 'b',
        total: 400,
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'B', category: 'food_ingredients', lineTotal: 300, quantity: 1 },
        ],
      }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('2. rejects when line-amount multiplicity differs', () => {
    const { left, right } = pair(
      {
        id: 'a',
        total: 200,
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'A2', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
        ],
      },
      {
        id: 'b',
        total: 100,
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
        ],
      }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('3. rejects different item count', () => {
    const { left, right } = pair(
      { id: 'a', items: BASE_ITEMS },
      {
        id: 'b',
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
        ],
      }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('4. rejects different transaction_at', () => {
    const { left, right } = pair(
      { id: 'a', items: BASE_ITEMS },
      {
        id: 'b',
        items: BASE_ITEMS,
        transactionAt: Date.parse('2026-08-20T17:43:00+09:00'),
      }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('5. rejects different total', () => {
    const { left, right } = pair(
      { id: 'a', total: 300, items: BASE_ITEMS },
      { id: 'b', total: 301, items: BASE_ITEMS }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('6. rejects different merchant', () => {
    const { left, right } = pair(
      { id: 'a', items: BASE_ITEMS },
      { id: 'b', items: BASE_ITEMS, merchantNormalized: 'コストコ' }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('7. rejects JPY vs USD', () => {
    const { left, right } = pair(
      { id: 'a', items: BASE_ITEMS, currency: 'JPY' },
      { id: 'b', items: BASE_ITEMS, currency: 'USD' }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('8. rejects incompatible known tax', () => {
    const { left, right } = pair(
      { id: 'a', items: BASE_ITEMS, tax: 251, taxIsKnown: 1 },
      { id: 'b', items: BASE_ITEMS, tax: 250, taxIsKnown: 1 }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('9. rejects invalid/missing raw lineAmount', () => {
    const { left, right } = pair(
      { id: 'a', items: BASE_ITEMS },
      {
        id: 'b',
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'B', category: 'food_ingredients', lineTotal: 0, quantity: 1 },
        ],
      }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('rejects single-line different products with only quantity drift', () => {
    const { left, right } = pair(
      {
        id: 'a',
        total: 794,
        items: [
          { name: 'Product A', category: 'food_ingredients', lineTotal: 794, quantity: 1 },
        ],
      },
      {
        id: 'b',
        total: 794,
        items: [
          { name: 'Product B', category: 'food_ingredients', lineTotal: 794, quantity: 2 },
        ],
      }
    );
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
  });

  it('[(1,100),(1,100)] and [(1,100)] do NOT match', () => {
    const leftReceipt = makeReceipt({
      id: 'a',
      total: 200,
      items: [
        { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
        { name: 'B', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
      ],
    });
    const rightReceipt = makeReceipt({
      id: 'b',
      total: 100,
      items: [
        { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
      ],
    });
    const left = summarizeReceiptForDuplicateAudit(leftReceipt);
    const right = summarizeReceiptForDuplicateAudit(rightReceipt);
    expect(evaluateReconciledStructuralQuantityNoisePair(left, right)).toBeNull();
    const groups = buildHighConfidenceDuplicateGroups(
      [left, right],
      [leftReceipt, rightReceipt]
    );
    expect(groups).toHaveLength(0);
  });
});

describe('quantity-noise Gyomu cohort integration', () => {
  const gyomuIds = [
    'ACsMESsCvPCD9Vsgpmn4V',
    'erhG0uXoyTm6vRFNCrBFe',
    'KzeeGp7HDiUxMu0D0CyzE',
    'lmg2SfKrcRGFCM1JVpOMS',
    'rbVx_AFdAfnwFywe11mR_',
    'sLOTqc_9eqHnMhJLlzQpx',
    'auq8r7qU-EN_l38Y2xDea',
  ] as const;

  const lineAmounts = [372, 378, 108, 313, 100, 103, 88, 1756] as const;

  function gyomuItems(order: readonly number[], outlier: boolean) {
    return order.map((index) => {
      const lineTotal = lineAmounts[index]!;
      if (index === 7) {
        return {
          name: outlier ? '正宗生煎包' : '正宗生煎包 (4個 x @439)',
          category: 'food_ingredients',
          lineTotal: 1756,
          quantity: outlier ? 1 : 4,
        };
      }
      return {
        name: `item-${index}`,
        category: 'food_ingredients',
        lineTotal,
        quantity: 1,
      };
    });
  }

  function gyomuReceipt(id: string, order: readonly number[], createdAt: number) {
    return makeReceipt({
      id,
      createdAt,
      total: 3393,
      tax: 251,
      taxIsKnown: 1,
      transactionAt: GYOMU_TX_AT,
      items: gyomuItems(order, id === 'auq8r7qU-EN_l38Y2xDea'),
      merchantNormalized: '業務スーパー古川店',
    });
  }

  const orders = [
    [0, 1, 2, 3, 4, 5, 6, 7],
    [7, 6, 5, 4, 3, 2, 1, 0],
    [2, 4, 6, 0, 1, 3, 5, 7],
    [1, 3, 5, 7, 0, 2, 4, 6],
    [4, 0, 6, 2, 7, 1, 5, 3],
    [3, 7, 1, 5, 2, 6, 0, 4],
    [5, 2, 0, 7, 4, 1, 6, 3],
  ];

  const gyomuScans = gyomuIds.map((id, index) =>
    gyomuReceipt(id, orders[index]!, NOW_MS - index * 60_000)
  );

  const yorkScans = [
    makeReceipt({
      id: 'york-a',
      total: 2807,
      tax: 207,
      taxIsKnown: 1,
      transactionAt: Date.parse('2026-08-18T11:20:00+09:00'),
      merchantNormalized: 'ヨークベニマル古川店',
      items: [
        { name: 'りんご', category: 'food_ingredients', lineTotal: 498, quantity: 1 },
        { name: 'パン', category: 'ready_to_eat', lineTotal: 398, quantity: 1 },
        { name: '惣菜', category: 'ready_to_eat', lineTotal: 1704, quantity: 1 },
      ],
    }),
    makeReceipt({
      id: 'york-b',
      total: 2800,
      tax: 207,
      taxIsKnown: 1,
      transactionAt: Date.parse('2026-08-25T18:05:00+09:00'),
      merchantNormalized: 'ヨークベニマル古川店',
      items: [
        { name: '野菜セット', category: 'food_ingredients', lineTotal: 900, quantity: 1 },
        { name: '飲料', category: 'snacks_drinks', lineTotal: 1693, quantity: 1 },
      ],
    }),
  ];

  it('collapses seven Gyomu stored scans to one analytics candidate', () => {
    const selection = selectAnalyticsReceipts(gyomuScans);
    expect(gyomuScans).toHaveLength(7);
    expect(selection.analyticsPurchaseCandidateCount).toBe(1);
    expect(selection.highConfidenceDuplicateExtras).toBe(6);
    expect(selection.excludedDuplicateReceiptIds.size).toBe(6);
    expect(buildHighConfidenceDuplicateGroups(
      gyomuScans.map(summarizeReceiptForDuplicateAudit),
      gyomuScans
    )).toHaveLength(1);
  });

  it('Gyomu + two York yields corrected 30d analytics totals', () => {
    const selection = selectAnalyticsReceipts([...gyomuScans, ...yorkScans]);
    const monthReceipts = selection.analyticsReceipts.filter((receipt) => {
      const start = NOW_MS - 30 * 24 * 60 * 60 * 1000;
      return (
        typeof receipt.transaction_at === 'number' &&
        receipt.transaction_at >= start &&
        receipt.transaction_at <= NOW_MS
      );
    });
    const stats = calculateStats(monthReceipts, 'all', NOW_MS);
    const merchants = aggregateV1MerchantSpend(monthReceipts);

    expect(stats.supportedReceiptCount).toBe(3);
    expect(stats.supportedSpend).toBe(9000);
    expect(merchants.find((row) => row.merchant.includes('業務スーパー'))).toEqual({
      merchant: '業務スーパー古川',
      count: 1,
      total: 3393,
    });
    expect(merchants.find((row) => row.merchant.includes('ヨークベニマル'))).toEqual({
      merchant: 'ヨークベニマル古川',
      count: 2,
      total: 5607,
    });
  });
});
