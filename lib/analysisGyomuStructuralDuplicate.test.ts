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
import { buildAnalysisTruthSnapshot } from './analysisTruthCycle';
import { calculateStats } from './statsCalculator';
import { aggregateV1MerchantSpend } from './merchantAnalytics';

const GYOMU_TX_AT = 1786351380000;
const NOW_MS = Date.parse('2026-09-01T12:00:00+09:00');

const GYOMU_LINE_AMOUNTS = [372, 378, 108, 313, 100, 103, 88, 1756] as const;

const GYOMU_SEVEN_RECEIPT_IDS = [
  'ACsMESsCvPCD9Vsgpmn4V',
  'erhG0uXoyTm6vRFNCrBFe',
  'KzeeGp7HDiUxMu0D0CyzE',
  'lmg2SfKrcRGFCM1JVpOMS',
  'rbVx_AFdAfnwFywe11mR_',
  'sLOTqc_9eqHnMhJLlzQpx',
  'auq8r7qU-EN_l38Y2xDea',
] as const;

const GYOMU_BASE_NAMES = [
  '商品A',
  '商品B',
  '商品C',
  '商品D',
  '商品E',
  '商品F',
  '商品G',
] as const;

function gyomuRealItems(
  order: readonly number[],
  variant: 'standard' | 'outlier'
) {
  return order.map((lineIndex) => {
    const lineTotal = GYOMU_LINE_AMOUNTS[lineIndex]!;
    if (lineIndex === 7) {
      return {
        name:
          variant === 'outlier'
            ? '正宗生煎包'
            : '正宗生煎包 (4個 x @439)',
        category: 'food_ingredients',
        lineTotal: 1756,
        quantity: variant === 'outlier' ? 1 : 4,
      };
    }
    return {
      name: GYOMU_BASE_NAMES[lineIndex]!,
      category: 'food_ingredients',
      lineTotal,
      quantity: 1,
    };
  });
}

function makeReceipt(args: {
  id: string;
  merchantNormalized: string;
  transactionAt: number;
  createdAt: number;
  total: number;
  tax: number;
  taxIsKnown: number;
  items: Array<{
    name: string;
    category: string;
    lineTotal: number;
    quantity: number;
  }>;
}): ReceiptRow {
  return {
    id: args.id,
    created_at: args.createdAt,
    transaction_at: args.transactionAt,
    image_uri: '',
    total: args.total,
    tax: args.tax,
    tax_is_known: args.taxIsKnown,
    currency: 'JPY',
    analysis_json: JSON.stringify({ items: args.items }),
    merchant_raw: args.merchantNormalized,
    merchant_normalized: args.merchantNormalized,
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  } as ReceiptRow;
}

function buildGyomuSevenScanFixture(): ReceiptRow[] {
  const itemOrders = [
    [0, 1, 2, 3, 4, 5, 6, 7],
    [7, 6, 5, 4, 3, 2, 1, 0],
    [2, 4, 6, 0, 1, 3, 5, 7],
    [1, 3, 5, 7, 0, 2, 4, 6],
    [4, 0, 6, 2, 7, 1, 5, 3],
    [3, 7, 1, 5, 2, 6, 0, 4],
    [5, 2, 0, 7, 4, 1, 6, 3],
  ];
  return GYOMU_SEVEN_RECEIPT_IDS.map((id, index) =>
    makeReceipt({
      id,
      merchantNormalized:
        index % 2 === 0 ? '業務スーパー古川店' : '業務スーパー古川',
      transactionAt: GYOMU_TX_AT,
      createdAt: NOW_MS - index * 60_000,
      total: 3393,
      tax: 251,
      taxIsKnown: 1,
      items: gyomuRealItems(
        itemOrders[index]!,
        id === 'auq8r7qU-EN_l38Y2xDea' ? 'outlier' : 'standard'
      ),
    })
  );
}

function buildYorkBenimaruFixture(): ReceiptRow[] {
  return [
    makeReceipt({
      id: 'york-a',
      merchantNormalized: 'ヨークベニマル古川店',
      transactionAt: Date.parse('2026-08-18T11:20:00+09:00'),
      createdAt: NOW_MS - 120_000,
      total: 2807,
      tax: 207,
      taxIsKnown: 1,
      items: [
        { name: 'りんご', category: 'food_ingredients', lineTotal: 498, quantity: 1 },
        { name: 'パン', category: 'ready_to_eat', lineTotal: 398, quantity: 1 },
        { name: '惣菜', category: 'ready_to_eat', lineTotal: 1704, quantity: 1 },
      ],
    }),
    makeReceipt({
      id: 'york-b',
      merchantNormalized: 'ヨークベニマル古川店',
      transactionAt: Date.parse('2026-08-25T18:05:00+09:00'),
      createdAt: NOW_MS - 60_000,
      total: 2800,
      tax: 207,
      taxIsKnown: 1,
      items: [
        { name: '野菜セット', category: 'food_ingredients', lineTotal: 900, quantity: 1 },
        { name: '飲料', category: 'snacks_drinks', lineTotal: 1693, quantity: 1 },
      ],
    }),
  ];
}

describe('Gyomu structural duplicate regression', () => {
  const gyomuScans = buildGyomuSevenScanFixture();
  const yorkScans = buildYorkBenimaruFixture();
  const storedReceipts = [...gyomuScans, ...yorkScans];

  it('groups seven Gyomu rescans into one quantity-noise reconciled duplicate group', () => {
    const summaries = gyomuScans.map(summarizeReceiptForDuplicateAudit);
    const groups = buildHighConfidenceDuplicateGroups(summaries, gyomuScans);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.confidence).toBe(
      'RECONCILED_STRUCTURAL_QUANTITY_NOISE_DUPLICATE'
    );
    expect([...groups[0]!.receiptIds].sort()).toEqual(
      [...GYOMU_SEVEN_RECEIPT_IDS].sort()
    );
    expect(groups[0]!.receiptIds).toContain(groups[0]!.representativeReceiptId);
  });

  it('reconciles auq8 outlier to the six-member group via quantity noise only', () => {
    const outlier = gyomuScans.find(
      (receipt) => receipt.id === 'auq8r7qU-EN_l38Y2xDea'
    )!;
    const member = gyomuScans.find(
      (receipt) => receipt.id === 'ACsMESsCvPCD9Vsgpmn4V'
    )!;
    const outlierSummary = summarizeReceiptForDuplicateAudit(outlier);
    const memberSummary = summarizeReceiptForDuplicateAudit(member);
    expect(
      evaluateReconciledStructuralQuantityNoisePair(outlierSummary, memberSummary)
    ).toEqual({
      quantityConflictLineAmounts: [1756],
    });
  });

  it('selectAnalyticsReceipts keeps one Gyomu canonical receipt from seven stored scans', () => {
    const selection = selectAnalyticsReceipts(storedReceipts);
    expect(selection.storedReceipts).toHaveLength(9);
    expect(selection.analyticsPurchaseCandidateCount).toBe(3);
    expect(selection.highConfidenceDuplicateExtras).toBe(6);
    expect(selection.excludedDuplicateReceiptIds.size).toBe(6);
    expect(selection.reconciledStructuralExactDuplicateExtras).toBe(6);

    const analyticsGyomu = selection.analyticsReceipts.filter((receipt) =>
      receipt.merchant_normalized?.includes('業務スーパー')
    );
    expect(analyticsGyomu).toHaveLength(1);
    expect(analyticsGyomu[0]!.total).toBe(3393);
    expect(
      groupsRepresentativeIncluded(
        selection.highConfidenceDuplicateGroups,
        analyticsGyomu[0]!.id
      )
    ).toBe(true);
  });

  it('derives corrected 30d Analysis totals after canonical duplicate selection', () => {
    const selection = selectAnalyticsReceipts(storedReceipts);
    const monthReceipts = selection.analyticsReceipts.filter((receipt) =>
      validMonthReceipt(receipt)
    );
    const snapshot = buildAnalysisTruthSnapshot({
      receipts: selection.analyticsReceipts,
      range: 'month',
      nowMs: NOW_MS,
    });
    const stats = snapshot.periodStats;
    const merchants = aggregateV1MerchantSpend(monthReceipts);

    expect(monthReceipts).toHaveLength(3);
    expect(stats.supportedReceiptCount).toBe(3);
    expect(stats.supportedSpend).toBe(9000);

    const gyomu = merchants.find((row) => row.merchant.includes('業務スーパー'));
    const york = merchants.find((row) => row.merchant.includes('ヨークベニマル'));
    expect(gyomu).toEqual({
      merchant: '業務スーパー古川',
      count: 1,
      total: 3393,
    });
    expect(york).toEqual({
      merchant: 'ヨークベニマル古川',
      count: 2,
      total: 5607,
    });
  });

  it('applies duplicate canonicalization before period window aggregation', () => {
    const selection = selectAnalyticsReceipts(storedReceipts);
    const monthEligible = selection.analyticsReceipts.filter((receipt) =>
      validMonthReceipt(receipt)
    );
    expect(monthEligible).toHaveLength(3);
    expect(calculateStats(monthEligible, 'all', NOW_MS).supportedSpend).toBe(9000);
  });

  it('keeps genuinely separate same-store same-total purchases at different times separate', () => {
    const separateLater = makeReceipt({
      id: 'gyomu-later',
      merchantNormalized: '業務スーパー古川店',
      transactionAt: Date.parse('2026-08-20T17:43:00+09:00'),
      createdAt: NOW_MS,
      total: 3393,
      tax: 251,
      taxIsKnown: 1,
      items: gyomuRealItems([0, 1, 2, 3, 4, 5, 6, 7], 'standard'),
    });
    const selection = selectAnalyticsReceipts([...gyomuScans, separateLater]);
    expect(selection.analyticsPurchaseCandidateCount).toBe(2);
    expect(selection.excludedDuplicateReceiptIds.size).toBe(6);
  });

  it('collapses exact content duplicates and mixed structural groups through one selector', () => {
    const exactA = makeReceipt({
      id: 'exact-a',
      merchantNormalized: 'イオン',
      transactionAt: Date.parse('2026-08-05T10:00:00+09:00'),
      createdAt: NOW_MS - 300_000,
      total: 500,
      tax: 0,
      taxIsKnown: 0,
      items: [
        { name: '牛乳', category: 'food_ingredients', lineTotal: 500, quantity: 1 },
      ],
    });
    const exactB = makeReceipt({
      id: 'exact-b',
      merchantNormalized: 'イオン',
      transactionAt: Date.parse('2026-08-05T10:00:00+09:00'),
      createdAt: NOW_MS - 299_000,
      total: 500,
      tax: 0,
      taxIsKnown: 0,
      items: [
        { name: '牛乳', category: 'food_ingredients', lineTotal: 500, quantity: 1 },
      ],
    });
    const selection = selectAnalyticsReceipts([...gyomuScans, exactA, exactB]);
    expect(selection.analyticsPurchaseCandidateCount).toBe(2);
    expect(selection.contentExactDuplicateExtras).toBe(1);
    expect(selection.reconciledStructuralExactDuplicateExtras).toBe(6);
  });
});

function validMonthReceipt(receipt: ReceiptRow): boolean {
  const transactionAt = receipt.transaction_at;
  if (typeof transactionAt !== 'number') return false;
  const start = NOW_MS - 30 * 24 * 60 * 60 * 1000;
  return transactionAt >= start && transactionAt <= NOW_MS;
}

function groupsRepresentativeIncluded(
  groups: ReturnType<typeof buildHighConfidenceDuplicateGroups>,
  receiptId: string
): boolean {
  return groups.some(
    (group) =>
      group.representativeReceiptId === receiptId &&
      group.receiptIds.includes(receiptId)
  );
}
