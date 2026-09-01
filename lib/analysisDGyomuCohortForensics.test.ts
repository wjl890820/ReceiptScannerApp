/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import {
  ANALYSIS_D_GYOMU_3393_COHORT_TARGET,
  ANALYSIS_D_GYOMU_3393_KNOWN_SIX_MEMBER_GROUP_RECEIPT_IDS,
  buildAnalysisDGyomuCohortForensicsExport,
  explainStructuralExactDuplicatePair,
  receiptMatchesGyomu3393Cohort,
  serializeAnalysisDGyomuCohortForensicsExport,
} from './analysisDGyomuCohortForensics';
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { summarizeReceiptForDuplicateAudit } from './analysisDDuplicateAudit';
import type { ReceiptRow } from './db';

const TX_AT = ANALYSIS_D_GYOMU_3393_COHORT_TARGET.transactionAt;
const BASKET = [
  { name: '牛乳', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
  { name: '卵', category: 'food_ingredients', lineTotal: 200, quantity: 1 },
] as const;

function makeReceipt(
  overrides: Partial<ReceiptRow> & { id: string }
): ReceiptRow {
  const { id, ...rest } = overrides;
  const items =
    (rest.analysis_json
      ? JSON.parse(String(rest.analysis_json)).items
      : BASKET) ?? BASKET;
  return {
    id,
    created_at: rest.created_at ?? TX_AT,
    transaction_at: rest.transaction_at ?? TX_AT,
    image_uri: '',
    total: rest.total ?? 3393,
    tax: rest.tax ?? 251,
    tax_is_known: rest.tax_is_known ?? 1,
    currency: rest.currency ?? 'JPY',
    analysis_json:
      rest.analysis_json ?? JSON.stringify({ items }),
    merchant_raw: rest.merchant_raw ?? '業務スーパー古川店',
    merchant_normalized: rest.merchant_normalized ?? '業務スーパー古川店',
    merchant_type: 'supermarket',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    ...rest,
  } as ReceiptRow;
}

describe('Analysis D Gyomu ¥3,393 cohort forensic export', () => {
  test('matches cohort by merchant analytics key + transaction_at + total', () => {
    const inCohort = makeReceipt({ id: 'in' });
    const wrongMerchant = makeReceipt({
      id: 'wrong-merchant',
      merchant_normalized: 'コストコ',
    });
    const wrongTime = makeReceipt({
      id: 'wrong-time',
      transaction_at: TX_AT + 60_000,
    });
    const wrongTotal = makeReceipt({ id: 'wrong-total', total: 3400 });
    expect(receiptMatchesGyomu3393Cohort(inCohort)).toBe(true);
    expect(receiptMatchesGyomu3393Cohort(wrongMerchant)).toBe(false);
    expect(receiptMatchesGyomu3393Cohort(wrongTime)).toBe(false);
    expect(receiptMatchesGyomu3393Cohort(wrongTotal)).toBe(false);
  });

  test('exports all seven cohort receipts including outsider not in known six-member group', () => {
    const sixIds = [...ANALYSIS_D_GYOMU_3393_KNOWN_SIX_MEMBER_GROUP_RECEIPT_IDS];
    const outsiderId = 'gyomu-cohort-outsider-7th';
    const receipts = [
      ...sixIds.map((id, index) =>
        makeReceipt({
          id,
          created_at: TX_AT + index,
          tax: index % 2 === 0 ? 251 : 0,
          tax_is_known: index % 2 === 0 ? 1 : 0,
        })
      ),
      makeReceipt({
        id: outsiderId,
        created_at: TX_AT + 100,
        tax: 250,
        tax_is_known: 1,
        analysis_json: JSON.stringify({
          items: [
            { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
            { name: 'B', category: 'food_ingredients', lineTotal: 300, quantity: 1 },
          ],
        }),
      }),
    ];
    const payload = buildAnalysisDGyomuCohortForensicsExport({
      receipts,
      nowMs: TX_AT,
    });
    expect(payload.matchedReceiptIds).toHaveLength(7);
    expect(payload.receipts).toHaveLength(7);
    expect(payload.receiptsOutsideKnownSixMemberGroup).toEqual([outsiderId]);
    const outsider = payload.receipts.find((row) => row.receiptId === outsiderId);
    expect(outsider).toBeTruthy();
    expect(outsider!.inKnownSixMemberGroup).toBe(false);
    expect(outsider!.duplicateConfidence).toBeNull();
  });

  test('exports required per-receipt forensic fields', () => {
    const receipt = makeReceipt({ id: sixIds()[0]! });
    const payload = buildAnalysisDGyomuCohortForensicsExport({
      receipts: [receipt],
      nowMs: TX_AT,
    });
    const row = payload.receipts[0]!;
    expect(row.receiptId).toBeTruthy();
    expect(row.createdAt).toBeTruthy();
    expect(row.rawMerchant).toBe('業務スーパー古川店');
    expect(row.resolvedMerchantAnalyticsKey).toBe('業務スーパー古川');
    expect(row.transactionAt).toBe(TX_AT);
    expect(row.total).toBe(3393);
    expect(row.currency).toBe('JPY');
    expect(row.itemCount).toBe(2);
    expect(row.rawItemRows).toHaveLength(2);
    expect(row.orderedQtyAmountVector.length).toBeGreaterThan(0);
    expect(row.canonicalStructuralBasket.length).toBeGreaterThan(0);
    expect(row.structuralDuplicateEligible).toBe(true);
    expect(row.contentFingerprint).toBeTruthy();
    expect(row.structuralFingerprint).toBeTruthy();
  });

  test('pairwise comparisons include structural matcher accept/reject reason', () => {
    const a = makeReceipt({ id: 'pair-a', tax: 251, tax_is_known: 1 });
    const b = makeReceipt({ id: 'pair-b', tax: 0, tax_is_known: 0 });
    const c = makeReceipt({
      id: 'pair-c',
      tax: 250,
      tax_is_known: 1,
      analysis_json: JSON.stringify({
        items: [
          { name: 'A', category: 'food_ingredients', lineTotal: 100, quantity: 1 },
          { name: 'B', category: 'food_ingredients', lineTotal: 300, quantity: 1 },
        ],
      }),
    });
    const payload = buildAnalysisDGyomuCohortForensicsExport({
      receipts: [a, b, c],
      nowMs: TX_AT,
    });
    const ab = payload.pairwiseComparisons.find(
      (pair) =>
        pair.leftReceiptId === 'pair-a' && pair.rightReceiptId === 'pair-b'
    );
    const ac = payload.pairwiseComparisons.find(
      (pair) =>
        pair.leftReceiptId === 'pair-a' && pair.rightReceiptId === 'pair-c'
    );
    expect(ab).toBeTruthy();
    expect(ab!.structuralMatcherAccepted).toBe(true);
    expect(ab!.structuralMatcherReason).toBe('structural_exact_duplicate_match');
    expect(ac).toBeTruthy();
    expect(ac!.structuralMatcherAccepted).toBe(false);
    expect(ac!.structuralMatcherReason).toMatch(/tax_incompatible|canonical_structural_basket_mismatch/);
    expect(ac!.taxCompatible).toBe(false);
  });

  test('explainStructuralExactDuplicatePair agrees with matcher outcome', () => {
    const left = summarizeReceiptForDuplicateAudit(makeReceipt({ id: 'x-a' }));
    const right = summarizeReceiptForDuplicateAudit(makeReceipt({ id: 'x-b', tax: 0, tax_is_known: 0 }));
    const explained = explainStructuralExactDuplicatePair(left, right);
    expect(explained.accepted).toBe(true);
  });

  test('export does not mutate receipts or change analytics selection', () => {
    const receipts = sixIds().map((id, index) =>
      makeReceipt({ id, created_at: TX_AT + index })
    );
    const before = JSON.stringify(receipts);
    const beforeSelection = selectAnalyticsReceipts(receipts);
    buildAnalysisDGyomuCohortForensicsExport({ receipts, nowMs: TX_AT });
    expect(JSON.stringify(receipts)).toBe(before);
    const afterSelection = selectAnalyticsReceipts(receipts);
    expect(afterSelection).toEqual(beforeSelection);
  });

  test('serialize produces stable JSON envelope', () => {
    const payload = buildAnalysisDGyomuCohortForensicsExport({
      receipts: [],
      nowMs: TX_AT,
    });
    const json = serializeAnalysisDGyomuCohortForensicsExport(payload);
    expect(json).toContain('gyomu_3393_full_cohort_rescan_forensics');
    expect(json.endsWith('\n')).toBe(true);
  });
});

function sixIds(): string[] {
  return [...ANALYSIS_D_GYOMU_3393_KNOWN_SIX_MEMBER_GROUP_RECEIPT_IDS];
}
