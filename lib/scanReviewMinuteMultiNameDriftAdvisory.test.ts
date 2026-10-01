/**
 * A3.2.3 multi-name drift advisory. Synthetic ids and names only.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  listReceiptsForAnalysis: jest.fn(),
  getReceipt: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import {
  indexHighConfidenceDuplicateGroupsByReceiptId,
  selectAnalyticsReceipts,
} from './analyticsReceiptSelection';
import type { ReceiptRow } from './db';
import {
  buildTransientScanReviewReceipt,
  evaluateScanReviewDuplicateGate,
  type ScanReviewDuplicateGateContext,
} from './scanReviewDuplicateGate';
import {
  evaluateMinuteMultiNameDriftRescanAdvisory,
  evaluateMinuteSingleNameDriftRescanAdvisory,
  evaluateMinuteStrictRescanAdvisory,
} from './scanReviewMinuteStrictAdvisory';

const MERCHANT = 'synth-market-diag';
const TX = '2026-08-01 09:15';
const TOTAL = 9000;
const TAX = 180;

function baseLines(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `synth-line-${index + 1}`,
    quantity: 1,
    lineTotal: 100 + index,
  }));
}

function withNames(
  count: number,
  names: Readonly<Record<number, string>>,
  extras?: Readonly<Record<number, { quantity?: number; lineTotal?: number }>>
) {
  return baseLines(count).map((row, index) => ({
    ...row,
    ...(names[index] != null ? { name: names[index] } : {}),
    ...extras?.[index],
  }));
}

function draftFrom(input?: {
  merchant?: string;
  transactionDate?: string;
  total?: number;
  tax?: number;
  items?: readonly unknown[];
  id?: string;
}): ReceiptRow {
  const transient = buildTransientScanReviewReceipt({
    transientReceiptId: input?.id ?? 'syn-multi-draft',
    imageUri: 'file://syn-multi.jpg',
    analysis: {
      merchant: input?.merchant ?? MERCHANT,
      transactionDate: input?.transactionDate ?? TX,
      total: input?.total ?? TOTAL,
      tax: input?.tax ?? TAX,
      tax_is_known: true,
      currency: 'JPY',
      items: input?.items ?? baseLines(12),
    } as never,
  });
  if (!transient) throw new Error('transient projection failed');
  return transient;
}

function storedFrom(draft: ReceiptRow, id: string, createdAt = 10): ReceiptRow {
  const analysis = JSON.parse(draft.analysis_json) as {
    transaction_time_precision?: string;
  };
  return {
    ...draft,
    id,
    created_at: createdAt,
    transaction_time_precision: analysis.transaction_time_precision ?? 'minute',
  };
}

function context(receipts: ReceiptRow[]): ScanReviewDuplicateGateContext {
  const selection = selectAnalyticsReceipts(receipts);
  return {
    storedReceipts: receipts,
    receiptById: new Map(receipts.map((receipt) => [receipt.id, receipt])),
    highConfidenceGroupByReceiptId: indexHighConfidenceDuplicateGroupsByReceiptId(
      selection.highConfidenceDuplicateGroups
    ),
  };
}

function gateFor(draft: ReceiptRow, stored: readonly ReceiptRow[]) {
  return evaluateScanReviewDuplicateGate(draft, context([...stored]));
}

function pair(leftItems: readonly unknown[], rightItems: readonly unknown[], id = 'syn-multi-right') {
  const left = draftFrom({ items: leftItems, id: 'syn-multi-left' });
  const right = storedFrom(draftFrom({ items: rightItems }), id);
  return { left, right };
}

describe('minute multi-name drift advisory', () => {
  it('P1 matches 8 exact, 1 whitespace, and 3 genuine drifts on 12 rows', () => {
    const leftItems = withNames(12, {
      2: 'synth drink 1.5',
      4: 'token-left-a',
      7: 'token-left-b',
      10: 'token-left-c',
    });
    const rightItems = withNames(12, {
      2: 'synthdrink 1.5',
      4: 'token-right-a',
      7: 'token-right-b',
      10: 'token-right-c',
    });
    const { left, right } = pair(leftItems, rightItems);
    const strict = evaluateMinuteStrictRescanAdvisory(left, right);
    expect(strict.matched).toBe(false);
    if (!strict.matched) expect(strict.reason).toBe('basket_mismatch');
    const single = evaluateMinuteSingleNameDriftRescanAdvisory(left, right);
    expect(single.matched).toBe(false);
    if (!single.matched) expect(single.reason).toBe('name_drift_count');
    const multi = evaluateMinuteMultiNameDriftRescanAdvisory(left, right);
    const again = evaluateMinuteMultiNameDriftRescanAdvisory(left, right);
    expect(multi.matched).toBe(true);
    if (multi.matched && again.matched) {
      expect(multi.itemCount).toBe(12);
      expect(multi.strictNameMatchCount).toBe(8);
      expect(multi.whitespaceOnlyDifferenceCount).toBe(1);
      expect(multi.genuineNameMismatchCount).toBe(3);
      expect(multi.genuineNameMismatchIndices).toEqual([4, 7, 10]);
      expect(multi.alignedNameSupportCount).toBe(9);
      expect(multi.evidenceKey).toBe(again.evidenceKey);
      expect(multi.evidenceKey).toContain('meruno-minute-multi-name-drift-advisory-v1');
      expect(multi.evidenceKey).toContain('synth drink 1.5');
      expect(multi.evidenceKey).toContain('synthdrink 1.5');
      const { evidenceKey: _evidenceKey, ...metadata } = multi;
      expect(JSON.stringify(metadata)).not.toContain('synth drink');
      expect(JSON.stringify(metadata)).not.toContain('token-left');
    }
    const gate = gateFor(left, [right]);
    expect(gate).toEqual({
      existingReceiptId: 'syn-multi-right',
      evidenceKey: multi.matched ? multi.evidenceKey : '',
      merchantDisplay: MERCHANT,
      transactionAt: left.transaction_at,
      total: TOTAL,
      currency: 'JPY',
      itemCount: 12,
      matchKind: 'MINUTE_MULTI_NAME_DRIFT_ADVISORY',
    });
  });

  it('P2 and P3 match the other eligible support shapes', () => {
    const twelve = pair(
      withNames(12, { 0: 'token-left-a', 1: 'token-left-b' }),
      withNames(12, { 0: 'token-right-a', 1: 'token-right-b' })
    );
    const twelveMulti = evaluateMinuteMultiNameDriftRescanAdvisory(twelve.left, twelve.right);
    expect(twelveMulti.matched).toBe(true);
    if (twelveMulti.matched) {
      expect(twelveMulti.genuineNameMismatchCount).toBe(2);
      expect(twelveMulti.alignedNameSupportCount).toBe(10);
    }

    const ten = pair(
      withNames(10, { 0: 'token-left-a', 1: 'token-left-b' }),
      withNames(10, { 0: 'token-right-a', 1: 'token-right-b' })
    );
    const tenMulti = evaluateMinuteMultiNameDriftRescanAdvisory(ten.left, ten.right);
    expect(tenMulti.matched).toBe(true);
    if (tenMulti.matched) {
      expect(tenMulti.itemCount).toBe(10);
      expect(tenMulti.strictNameMatchCount).toBe(8);
      expect(tenMulti.genuineNameMismatchCount).toBe(2);
      expect(tenMulti.alignedNameSupportCount).toBe(8);
    }
  });

  it('rejects support, count, tier-3, whitespace, money, order, and header failures', () => {
    const lowSupport = pair(
      withNames(10, { 0: 'token-left-a', 1: 'token-left-b', 2: 'token-left-c' }),
      withNames(10, { 0: 'token-right-a', 1: 'token-right-b', 2: 'token-right-c' })
    );
    const n1 = evaluateMinuteMultiNameDriftRescanAdvisory(lowSupport.left, lowSupport.right);
    expect(n1.matched).toBe(false);
    if (!n1.matched) expect(n1.reason).toBe('aligned_name_support');

    const fourDrifts = pair(
      withNames(12, { 0: 'a-left', 1: 'b-left', 2: 'c-left', 3: 'd-left' }),
      withNames(12, { 0: 'a-right', 1: 'b-right', 2: 'c-right', 3: 'd-right' })
    );
    const n2 = evaluateMinuteMultiNameDriftRescanAdvisory(fourDrifts.left, fourDrifts.right);
    expect(n2.matched).toBe(false);
    if (!n2.matched) expect(n2.reason).toBe('genuine_name_count');

    const oneDrift = pair(baseLines(12), withNames(12, { 11: 'token-one' }));
    const single = evaluateMinuteSingleNameDriftRescanAdvisory(oneDrift.left, oneDrift.right);
    expect(single.matched).toBe(true);
    const n3 = evaluateMinuteMultiNameDriftRescanAdvisory(oneDrift.left, oneDrift.right);
    expect(n3.matched).toBe(false);
    if (!n3.matched) expect(n3.reason).toBe('single_name_already_matched');
    expect(gateFor(oneDrift.left, [oneDrift.right])?.matchKind).toBe(
      'MINUTE_SINGLE_NAME_DRIFT_ADVISORY'
    );

    const whitespace = pair(
      withNames(12, { 2: 'synth drink 1.5' }),
      withNames(12, { 2: 'synthdrink 1.5' })
    );
    const n4 = evaluateMinuteMultiNameDriftRescanAdvisory(whitespace.left, whitespace.right);
    expect(n4.matched).toBe(false);
    if (!n4.matched) expect(n4.reason).toBe('genuine_name_count');
    expect(gateFor(whitespace.left, [whitespace.right])).toBeNull();

    const amount = pair(
      withNames(12, { 4: 'token-left-a', 7: 'token-left-b', 10: 'token-left-c' }),
      withNames(
        12,
        { 4: 'token-right-a', 7: 'token-right-b', 10: 'token-right-c' },
        { 0: { lineTotal: 101 } }
      )
    );
    const n5 = evaluateMinuteMultiNameDriftRescanAdvisory(amount.left, amount.right);
    expect(n5.matched).toBe(false);
    if (!n5.matched) expect(n5.reason).toBe('amount_mismatch');

    const quantity = pair(
      withNames(12, { 4: 'token-left-a', 7: 'token-left-b', 10: 'token-left-c' }),
      withNames(
        12,
        { 4: 'token-right-a', 7: 'token-right-b', 10: 'token-right-c' },
        { 0: { quantity: 2 } }
      )
    );
    const n6 = evaluateMinuteMultiNameDriftRescanAdvisory(quantity.left, quantity.right);
    expect(n6.matched).toBe(false);
    if (!n6.matched) expect(n6.reason).toBe('quantity_mismatch');

    const rotatedNames = baseLines(12).map((row) => row.name);
    const rotated = baseLines(12).map((row, index) => ({
      ...row,
      name: rotatedNames[(index + 1) % rotatedNames.length]!,
    }));
    const n7 = evaluateMinuteMultiNameDriftRescanAdvisory(
      draftFrom({ items: baseLines(12), id: 'syn-order-left' }),
      storedFrom(draftFrom({ items: rotated }), 'syn-order-right')
    );
    expect(n7.matched).toBe(false);
    const reversed = evaluateMinuteMultiNameDriftRescanAdvisory(
      draftFrom({ items: baseLines(12), id: 'syn-rev-left' }),
      storedFrom(draftFrom({ items: [...baseLines(12)].reverse() }), 'syn-rev-right')
    );
    expect(reversed.matched).toBe(false);

    const short = pair(
      withNames(9, { 0: 'token-left-a', 1: 'token-left-b' }),
      withNames(9, { 0: 'token-right-a', 1: 'token-right-b' })
    );
    const n8 = evaluateMinuteMultiNameDriftRescanAdvisory(short.left, short.right);
    expect(n8.matched).toBe(false);
    if (!n8.matched) expect(n8.reason).toBe('item_count');

    const merchantLeft = draftFrom({
      items: withNames(12, { 0: 'token-left-a', 1: 'token-left-b' }),
      id: 'syn-merch-left',
    });
    const merchantRight = storedFrom(
      draftFrom({
        merchant: 'synth-other-lane',
        items: withNames(12, { 0: 'token-right-a', 1: 'token-right-b' }),
      }),
      'syn-merch-right'
    );
    const n9 = evaluateMinuteMultiNameDriftRescanAdvisory(merchantLeft, merchantRight);
    expect(n9.matched).toBe(false);
    if (!n9.matched) expect(n9.reason).toBe('merchant_conflict');

    const timeRight = storedFrom(
      draftFrom({
        transactionDate: '2026-08-01 09:16',
        items: withNames(12, { 0: 'token-right-a', 1: 'token-right-b' }),
      }),
      'syn-time-right'
    );
    const n10 = evaluateMinuteMultiNameDriftRescanAdvisory(
      draftFrom({
        items: withNames(12, { 0: 'token-left-a', 1: 'token-left-b' }),
        id: 'syn-time-left',
      }),
      timeRight
    );
    expect(n10.matched).toBe(false);
    if (!n10.matched) expect(n10.reason).toBe('transaction_time_mismatch');

    const taxRight = storedFrom(
      draftFrom({
        tax: 181,
        items: withNames(12, { 0: 'token-right-a', 1: 'token-right-b' }),
      }),
      'syn-tax-right'
    );
    const n11 = evaluateMinuteMultiNameDriftRescanAdvisory(
      draftFrom({
        items: withNames(12, { 0: 'token-left-a', 1: 'token-left-b' }),
        id: 'syn-tax-left',
      }),
      taxRight
    );
    expect(n11.matched).toBe(false);
    if (!n11.matched) expect(n11.reason).toBe('tax_mismatch');

    const totalRight = storedFrom(
      draftFrom({
        total: 9001,
        items: withNames(12, { 0: 'token-right-a', 1: 'token-right-b' }),
      }),
      'syn-total-right'
    );
    const n12 = evaluateMinuteMultiNameDriftRescanAdvisory(
      draftFrom({
        items: withNames(12, { 0: 'token-left-a', 1: 'token-left-b' }),
        id: 'syn-total-left',
      }),
      totalRight
    );
    expect(n12.matched).toBe(false);
    if (!n12.matched) expect(n12.reason).toBe('total_mismatch');

    function genuineCharacterCase(
      leftNames: Readonly<Record<number, string>>,
      rightNames: Readonly<Record<number, string>>
    ) {
      const shaped = pair(withNames(10, leftNames), withNames(10, rightNames), 'syn-char-right');
      return evaluateMinuteMultiNameDriftRescanAdvisory(shaped.left, shaped.right);
    }
    const punctuation = genuineCharacterCase(
      { 0: 'abc-123', 1: 'def-456', 2: 'ghi-789' },
      { 0: 'abc123', 1: 'def456', 2: 'ghi789' }
    );
    expect(punctuation.matched).toBe(false);
    if (!punctuation.matched) expect(punctuation.reason).toBe('aligned_name_support');
    const digits = genuineCharacterCase(
      { 0: '1.5', 1: '2.5', 2: '3.5' },
      { 0: '1.6', 1: '2.6', 2: '3.6' }
    );
    expect(digits.matched).toBe(false);
    if (!digits.matched) expect(digits.reason).toBe('aligned_name_support');
    const kana = genuineCharacterCase(
      { 0: 'synth-ア', 1: 'synth-甲', 2: 'synth-ウ' },
      { 0: 'synth-イ', 1: 'synth-乙', 2: 'synth-エ' }
    );
    expect(kana.matched).toBe(false);
    if (!kana.matched) expect(kana.reason).toBe('aligned_name_support');
  });

  it('keeps higher evidence tiers ahead of an older multi-name warning', () => {
    const spacedItems = withNames(12, {
      2: 'synth drink 1.5',
      4: 'token-left-a',
      7: 'token-left-b',
      10: 'token-left-c',
    });
    const spacedDraft = draftFrom({ items: spacedItems, id: 'syn-priority-draft' });
    const olderMulti = storedFrom(
      draftFrom({
        items: withNames(12, {
          2: 'synthdrink 1.5',
          4: 'token-right-a',
          7: 'token-right-b',
          10: 'token-right-c',
        }),
      }),
      'syn-tier4-old',
      1
    );
    const newerSingle = storedFrom(
      draftFrom({ items: withNames(12, { ...{ 2: 'synth drink 1.5', 4: 'token-left-a', 7: 'token-left-b', 10: 'token-left-c' }, 11: 'token-one' }) }),
      'syn-tier3-new',
      50
    );
    const newerStrict = storedFrom(spacedDraft, 'syn-tier2-new', 50);
    for (const history of [
      [olderMulti, newerSingle],
      [newerSingle, olderMulti],
    ]) {
      const gate = gateFor(spacedDraft, history);
      expect(gate?.existingReceiptId).toBe('syn-tier3-new');
      expect(gate?.matchKind).toBe('MINUTE_SINGLE_NAME_DRIFT_ADVISORY');
    }
    for (const history of [
      [olderMulti, newerStrict],
      [newerStrict, olderMulti],
    ]) {
      const gate = gateFor(spacedDraft, history);
      expect(gate?.existingReceiptId).toBe('syn-tier2-new');
      expect(gate?.matchKind).toBe('MINUTE_STRICT_ADVISORY');
    }

    const secondDraft = draftFrom({
      merchant: 'costco',
      transactionDate: '2026-08-01 09:15:30',
      id: 'syn-second-draft',
    });
    const newerSecond = storedFrom(secondDraft, 'syn-second-new', 50);
    const olderMinute = storedFrom(
      draftFrom({
        merchant: 'costco',
        items: withNames(12, { 0: 'token-right-a', 1: 'token-right-b', 2: 'token-right-c' }),
      }),
      'syn-tier4-minute-old',
      1
    );
    for (const history of [
      [olderMinute, newerSecond],
      [newerSecond, olderMinute],
    ]) {
      const gate = gateFor(secondDraft, history);
      expect(gate?.existingReceiptId).toBe('syn-second-new');
      expect(gate?.matchKind).toBe('SECOND_EXACT');
    }

    const early = storedFrom(
      draftFrom({ items: withNames(12, { 0: 'token-right-a', 1: 'token-right-b' }) }),
      'syn-tier4-early',
      2
    );
    const late = storedFrom(
      draftFrom({ items: withNames(12, { 0: 'token-right-a', 1: 'token-right-b' }) }),
      'syn-tier4-late',
      8
    );
    const multiDraft = draftFrom({
      items: withNames(12, { 0: 'token-left-a', 1: 'token-left-b' }),
      id: 'syn-tier4-draft',
    });
    expect(gateFor(multiDraft, [late, early])?.existingReceiptId).toBe('syn-tier4-early');
    expect(gateFor(multiDraft, [early, late])?.matchKind).toBe(
      'MINUTE_MULTI_NAME_DRIFT_ADVISORY'
    );
    const idA = storedFrom(
      draftFrom({ items: withNames(12, { 0: 'token-right-a', 1: 'token-right-b' }) }),
      'hist-A_1',
      10
    );
    const idB = storedFrom(
      draftFrom({ items: withNames(12, { 0: 'token-right-a', 1: 'token-right-b' }) }),
      'hist_a-1',
      10
    );
    expect('hist-A_1' < 'hist_a-1').toBe(true);
    expect(gateFor(multiDraft, [idB, idA])?.existingReceiptId).toBe('hist-A_1');
    expect(gateFor(multiDraft, [idA, idB])?.existingReceiptId).toBe('hist-A_1');

    const source = fs.readFileSync(
      path.join(__dirname, 'scanReviewMinuteStrictAdvisory.ts'),
      'utf8'
    );
    const gateSource = fs.readFileSync(
      path.join(__dirname, 'scanReviewDuplicateGate.ts'),
      'utf8'
    );
    expect(source).toContain('meruno-minute-single-name-drift-advisory-v2');
    expect(source).toContain('meruno-minute-multi-name-drift-advisory-v1');
    expect(source).not.toMatch(
      /levenshtein|editDistance|localeCompare|embedding|assignVerifiedPurchaseOccurrence|requestCloudBackupFlush|getSupabaseClient|\bUPDATE\s+receipts\b/i
    );
    expect(gateSource).not.toMatch(/localeCompare/);
    expect(gateSource.indexOf("return 0")).toBeLessThan(gateSource.indexOf("return 3"));
  });
});
