/**
 * A3.2 single canonical-name drift advisory. Synthetic ids and names only.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  listReceiptsForAnalysis: jest.fn(),
  getReceipt: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import { getReceipt, listReceiptsForAnalysis } from './db';
import type { ReceiptRow } from './db';
import {
  buildTransientScanReviewReceipt,
  evaluateScanReviewDuplicateGate,
  shouldShowScanReviewDuplicateGateMatch,
  type ScanReviewDuplicateGateContext,
} from './scanReviewDuplicateGate';
import { shouldHideDuplicateGateSaveBar } from './scanReviewDuplicateGateTerminal';
import {
  evaluateMinuteSingleNameDriftRescanAdvisory,
  evaluateMinuteStrictRescanAdvisory,
} from './scanReviewMinuteStrictAdvisory';
import {
  indexHighConfidenceDuplicateGroupsByReceiptId,
  selectAnalyticsReceipts,
} from './analyticsReceiptSelection';

const MERCHANT = 'synth-market-north';
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

function draftFrom(input?: {
  merchant?: string;
  transactionDate?: string;
  total?: number;
  tax?: number;
  taxKnown?: boolean;
  currency?: string;
  items?: readonly unknown[];
  id?: string;
}): ReceiptRow {
  const transient = buildTransientScanReviewReceipt({
    transientReceiptId: input?.id ?? 'syn-drift-draft',
    imageUri: 'file://syn-drift-draft.jpg',
    analysis: {
      merchant: input?.merchant ?? MERCHANT,
      transactionDate: input?.transactionDate ?? TX,
      total: input?.total ?? TOTAL,
      tax: input?.tax ?? TAX,
      tax_is_known: input?.taxKnown ?? true,
      currency: input?.currency ?? 'JPY',
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

function withItems(row: ReceiptRow, items: readonly unknown[]): ReceiptRow {
  const analysis = JSON.parse(row.analysis_json) as Record<string, unknown>;
  analysis.items = items;
  return { ...row, user_items_json: null, analysis_json: JSON.stringify(analysis) };
}

function withPrecision(row: ReceiptRow, precision: string): ReceiptRow {
  const analysis = JSON.parse(row.analysis_json) as Record<string, unknown>;
  analysis.transaction_time_precision = precision;
  return {
    ...row,
    transaction_time_precision: precision,
    analysis_json: JSON.stringify(analysis),
  };
}

function renamed(count: number, index: number, name: string) {
  return baseLines(count).map((row, rowIndex) =>
    rowIndex === index ? { ...row, name } : row
  );
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

describe('minute single-name drift advisory', () => {
  const draft = draftFrom();
  const saved = storedFrom(draft, 'syn-drift-hist');
  const drifted = withItems(saved, renamed(12, 11, 'synth-line-12-ocr'));

  it('P1 warns on one drifted name in a 12-line minute receipt', () => {
    const strict = evaluateMinuteStrictRescanAdvisory(draft, drifted);
    expect(strict.matched).toBe(false);
    if (!strict.matched) expect(strict.reason).toBe('basket_mismatch');
    const drift = evaluateMinuteSingleNameDriftRescanAdvisory(draft, drifted);
    expect(drift.matched).toBe(true);
    if (drift.matched) {
      expect(drift.reason).toBe('MINUTE_SINGLE_NAME_DRIFT_ADVISORY');
      expect(drift.itemCount).toBe(12);
      expect(drift.exactNameMatchCount).toBe(11);
      expect(drift.nameMismatchCount).toBe(1);
      expect(drift.nameMismatchIndex).toBe(11);
    }
    const gate = gateFor(draft, [drifted]);
    expect(gate?.existingReceiptId).toBe('syn-drift-hist');
    expect(gate?.matchKind).toBe('MINUTE_SINGLE_NAME_DRIFT_ADVISORY');
    expect(shouldShowScanReviewDuplicateGateMatch(gate, null)).toBe(true);
    expect(
      shouldHideDuplicateGateSaveBar({
        showDuplicateGate: true,
        terminalDuplicateDestinationId: null,
      })
    ).toBe(true);
  });

  it('P2 accepts the five-line minimum and P3 ignores name similarity', () => {
    const five = draftFrom({ items: baseLines(5), id: 'syn-drift-five' });
    const fiveSaved = withItems(
      storedFrom(five, 'syn-drift-five-hist'),
      renamed(5, 4, 'synth-line-5-ocr')
    );
    const fiveDrift = evaluateMinuteSingleNameDriftRescanAdvisory(five, fiveSaved);
    expect(fiveDrift.matched).toBe(true);
    if (fiveDrift.matched) {
      expect(fiveDrift.itemCount).toBe(5);
      expect(fiveDrift.exactNameMatchCount).toBe(4);
      expect(fiveDrift.nameMismatchIndex).toBe(4);
    }

    const unlike = withItems(saved, renamed(12, 0, 'completely-different-token'));
    const unlikeDrift = evaluateMinuteSingleNameDriftRescanAdvisory(draft, unlike);
    expect(unlikeDrift.matched).toBe(true);
    if (unlikeDrift.matched) expect(unlikeDrift.nameMismatchIndex).toBe(0);
  });

  it('rejects the required negative shapes', () => {
    const fiveDraft = draftFrom({ items: baseLines(5), id: 'syn-drift-five-left' });
    const fourDraft = draftFrom({ items: baseLines(4), id: 'syn-drift-four-left' });
    const cases: { name: string; left?: ReceiptRow; stored: ReceiptRow }[] = [
      {
        name: 'N1 four lines',
        left: fourDraft,
        stored: storedFrom(draftFrom({ items: renamed(4, 3, 'synth-other') }), 'syn-n1'),
      },
      {
        name: 'N2 two names',
        left: fiveDraft,
        stored: withItems(
          storedFrom(fiveDraft, 'syn-n2'),
          baseLines(5).map((row, index) =>
            index === 0 ? { ...row, name: 'synth-a' } : index === 1 ? { ...row, name: 'synth-b' } : row
          )
        ),
      },
      {
        name: 'N3 drift amount',
        stored: withItems(
          saved,
          baseLines(12).map((row, index) =>
            index === 11 ? { ...row, name: 'synth-line-12-ocr', lineTotal: row.lineTotal + 1 } : row
          )
        ),
      },
      {
        name: 'N4 other amount',
        stored: withItems(
          saved,
          renamed(12, 11, 'synth-line-12-ocr').map((row, index) =>
            index === 1 ? { ...row, lineTotal: row.lineTotal + 1 } : row
          )
        ),
      },
      {
        name: 'N5 quantity',
        stored: withItems(
          saved,
          renamed(12, 11, 'synth-line-12-ocr').map((row, index) =>
            index === 2 ? { ...row, quantity: 2 } : row
          )
        ),
      },
      { name: 'N6 reorder', stored: withItems(saved, [...baseLines(12)].reverse()) },
      {
        name: 'N7 minute',
        stored: { ...drifted, transaction_at: (drifted.transaction_at ?? 0) + 60_000 },
      },
      { name: 'N8 total', stored: { ...drifted, total: TOTAL + 1 } },
      { name: 'N9 tax', stored: { ...drifted, tax: TAX + 1 } },
      { name: 'N10 tax unknown', stored: { ...drifted, tax_is_known: 0 } },
      {
        name: 'N11 merchant',
        stored: storedFrom(draftFrom({ merchant: 'synth-market-south', items: renamed(12, 11, 'synth-line-12-ocr') }), 'syn-n11'),
      },
      { name: 'N12 currency', stored: { ...drifted, currency: 'USD' } },
      { name: 'N13 precision', stored: withPrecision(drifted, 'not-a-precision') },
      { name: 'N14 second', stored: withPrecision(drifted, 'second') },
      {
        name: 'N15 missing quantity',
        stored: withItems(saved, [
          { name: 'synth-line-1', lineTotal: 100 },
          ...baseLines(12).slice(1),
        ]),
      },
      {
        name: 'N16 missing amount',
        stored: withItems(saved, [
          { name: 'synth-line-1', quantity: 1 },
          ...baseLines(12).slice(1),
        ]),
      },
      {
        name: 'N17 fractional',
        stored: withItems(
          saved,
          baseLines(12).map((row, index) =>
            index === 4 ? { ...row, lineTotal: 104.004 } : row
          )
        ),
      },
      {
        name: 'N18 zero',
        stored: withItems(saved, [
          ...baseLines(12),
          { name: 'synth-zero', quantity: 1, lineTotal: 0 },
        ]),
      },
      {
        name: 'N18 negative',
        stored: withItems(saved, [
          ...baseLines(12),
          { name: 'synth-neg', quantity: 1, lineTotal: -5 },
        ]),
      },
      { name: 'N19 null row', stored: withItems(saved, [...baseLines(12), null]) },
      {
        name: 'N21 one line',
        left: draftFrom({ items: baseLines(1), id: 'syn-drift-one-left' }),
        stored: storedFrom(draftFrom({ items: renamed(1, 0, 'synth-other') }), 'syn-n21'),
      },
      {
        name: 'N22 two lines',
        left: draftFrom({ items: baseLines(2), id: 'syn-drift-two-left' }),
        stored: storedFrom(draftFrom({ items: renamed(2, 1, 'synth-other') }), 'syn-n22'),
      },
      {
        name: 'N23 three lines',
        left: draftFrom({ items: baseLines(3), id: 'syn-drift-three-left' }),
        stored: storedFrom(draftFrom({ items: renamed(3, 2, 'synth-other') }), 'syn-n23'),
      },
    ];

    for (const entry of cases) {
      const left = entry.left ?? draft;
      const drift = evaluateMinuteSingleNameDriftRescanAdvisory(left, entry.stored);
      expect({ name: entry.name, matched: drift.matched }).toEqual({
        name: entry.name,
        matched: false,
      });
      expect(gateFor(left, [entry.stored])?.matchKind).not.toBe(
        'MINUTE_SINGLE_NAME_DRIFT_ADVISORY'
      );
    }
  });

  it('treats internal whitespace as formatting and still budgets one true name drift', () => {
    const leftItems = baseLines(12).map((row, index) => {
      if (index === 2) return { ...row, name: 'synth drink 1.5' };
      if (index === 6) return { ...row, name: 'synth-line-seven' };
      return row;
    });
    const rightItems = baseLines(12).map((row, index) => {
      if (index === 2) return { ...row, name: 'synthdrink 1.5' };
      if (index === 6) return { ...row, name: 'completely-different-token' };
      return row;
    });
    const left = draftFrom({ items: leftItems, id: 'syn-ws-left' });
    const right = storedFrom(draftFrom({ items: rightItems }), 'syn-ws-right');
    const strict = evaluateMinuteStrictRescanAdvisory(left, right);
    expect(strict.matched).toBe(false);
    if (!strict.matched) expect(strict.reason).toBe('basket_mismatch');
    const drift = evaluateMinuteSingleNameDriftRescanAdvisory(left, right);
    expect(drift.matched).toBe(true);
    if (drift.matched) {
      expect(drift.nameMismatchCount).toBe(1);
      expect(drift.nameMismatchIndex).toBe(6);
      expect(drift.exactNameMatchCount).toBe(10);
      expect(drift.evidenceKey).toContain('synth drink 1.5');
      expect(drift.evidenceKey).toContain('synthdrink 1.5');
      expect(drift.evidenceKey).toContain('meruno-minute-single-name-drift-advisory-v2');
    }
    expect(gateFor(left, [right])?.matchKind).toBe('MINUTE_SINGLE_NAME_DRIFT_ADVISORY');

    const spaceOnlyLeft = draftFrom({
      items: baseLines(12).map((row, index) =>
        index === 2 ? { ...row, name: 'synth drink 1.5' } : row
      ),
      id: 'syn-ws-only-left',
    });
    const spaceOnlyRight = storedFrom(
      draftFrom({
        items: baseLines(12).map((row, index) =>
          index === 2 ? { ...row, name: 'synthdrink 1.5' } : row
        ),
      }),
      'syn-ws-only'
    );
    const spaceStrict = evaluateMinuteStrictRescanAdvisory(spaceOnlyLeft, spaceOnlyRight);
    expect(spaceStrict.matched).toBe(false);
    if (!spaceStrict.matched) expect(spaceStrict.reason).toBe('basket_mismatch');
    const spaceDrift = evaluateMinuteSingleNameDriftRescanAdvisory(
      spaceOnlyLeft,
      spaceOnlyRight
    );
    expect(spaceDrift.matched).toBe(false);
    if (!spaceDrift.matched) expect(spaceDrift.reason).toBe('name_drift_count');
    expect(gateFor(spaceOnlyLeft, [spaceOnlyRight])).toBeNull();

    const fiveLeftItems = baseLines(5).map((row, index) =>
      index === 1 ? { ...row, name: 'synth pack 2' } : row
    );
    const fiveRightItems = baseLines(5).map((row, index) => {
      if (index === 1) return { ...row, name: 'synthpack 2' };
      if (index === 4) return { ...row, name: 'completely-different-token' };
      return row;
    });
    const fiveDrift = evaluateMinuteSingleNameDriftRescanAdvisory(
      draftFrom({ items: fiveLeftItems, id: 'syn-ws-five' }),
      storedFrom(draftFrom({ items: fiveRightItems }), 'syn-ws-five-hist')
    );
    expect(fiveDrift.matched).toBe(true);
    if (fiveDrift.matched) {
      expect(fiveDrift.itemCount).toBe(5);
      expect(fiveDrift.nameMismatchCount).toBe(1);
      expect(fiveDrift.nameMismatchIndex).toBe(4);
    }
  });

  it('still counts punctuation, characters, and digits as true name drifts', () => {
    function pair(leftName: string, rightName: string, id: string) {
      const leftItems = baseLines(12).map((row, index) =>
        index === 3 ? { ...row, name: leftName } : row
      );
      const rightItems = baseLines(12).map((row, index) => {
        if (index === 1) return { ...row, name: 'synth gap 2' };
        if (index === 3) return { ...row, name: rightName };
        return row;
      });
      const left = draftFrom({
        items: leftItems.map((row, index) =>
          index === 1 ? { ...row, name: 'synthgap 2' } : row
        ),
        id: `${id}-left`,
      });
      const right = storedFrom(draftFrom({ items: rightItems }), `${id}-right`);
      return evaluateMinuteSingleNameDriftRescanAdvisory(left, right);
    }

    for (const [leftName, rightName, id] of [
      ['abc-123', 'abc123', 'syn-punct'],
      ['synth-char-a', 'synth-char-b', 'syn-char'],
      ['1.5', '1.6', 'syn-digit'],
    ] as const) {
      const drift = pair(leftName, rightName, id);
      expect(drift.matched).toBe(true);
      if (drift.matched) expect(drift.nameMismatchIndex).toBe(3);
    }

    const twoGenuine = evaluateMinuteSingleNameDriftRescanAdvisory(
      draftFrom({
        items: baseLines(12).map((row, index) => {
          if (index === 1) return { ...row, name: 'synth gap 2' };
          if (index === 3) return { ...row, name: 'abc-123' };
          if (index === 8) return { ...row, name: 'synth 1.5' };
          return row;
        }),
        id: 'syn-two-left',
      }),
      storedFrom(
        draftFrom({
          items: baseLines(12).map((row, index) => {
            if (index === 1) return { ...row, name: 'synthgap 2' };
            if (index === 3) return { ...row, name: 'abc123' };
            if (index === 8) return { ...row, name: 'synth 1.6' };
            return row;
          }),
        }),
        'syn-two-right'
      )
    );
    expect(twoGenuine.matched).toBe(false);
    if (!twoGenuine.matched) expect(twoGenuine.reason).toBe('name_drift_count');

    const amountDrift = evaluateMinuteSingleNameDriftRescanAdvisory(
      draftFrom({
        items: baseLines(12).map((row, index) =>
          index === 2 ? { ...row, name: 'synth drink 1.5' } : row
        ),
        id: 'syn-ws-amount-left',
      }),
      storedFrom(
        draftFrom({
          items: baseLines(12).map((row, index) =>
            index === 2
              ? { ...row, name: 'synthdrink 1.5', lineTotal: row.lineTotal + 1 }
              : row
          ),
        }),
        'syn-ws-amount-right'
      )
    );
    expect(amountDrift.matched).toBe(false);
    if (!amountDrift.matched) expect(amountDrift.reason).toBe('amount_mismatch');

    const quantityDrift = evaluateMinuteSingleNameDriftRescanAdvisory(
      draftFrom({
        items: baseLines(12).map((row, index) =>
          index === 2 ? { ...row, name: 'synth drink 1.5' } : row
        ),
        id: 'syn-ws-qty-left',
      }),
      storedFrom(
        draftFrom({
          items: baseLines(12).map((row, index) =>
            index === 2 ? { ...row, name: 'synthdrink 1.5', quantity: 2 } : row
          ),
        }),
        'syn-ws-qty-right'
      )
    );
    expect(quantityDrift.matched).toBe(false);
    if (!quantityDrift.matched) expect(quantityDrift.reason).toBe('quantity_mismatch');

    const reordered = [...baseLines(12)].reverse().map((row, index) =>
      index === 0 ? { ...row, name: 'synth drink 1.5' } : row
    );
    const reorderDrift = evaluateMinuteSingleNameDriftRescanAdvisory(
      draftFrom({ items: baseLines(12), id: 'syn-ws-order-left' }),
      storedFrom(draftFrom({ items: reordered }), 'syn-ws-order-right')
    );
    expect(reorderDrift.matched).toBe(false);

    const shortDrift = evaluateMinuteSingleNameDriftRescanAdvisory(
      draftFrom({
        items: baseLines(4).map((row, index) =>
          index === 1 ? { ...row, name: 'synth drink 1.5' } : row
        ),
        id: 'syn-ws-short-left',
      }),
      storedFrom(
        draftFrom({
          items: baseLines(4).map((row, index) => {
            if (index === 1) return { ...row, name: 'synthdrink 1.5' };
            if (index === 3) return { ...row, name: 'completely-different-token' };
            return row;
          }),
        }),
        'syn-ws-short-right'
      )
    );
    expect(shortDrift.matched).toBe(false);
    if (!shortDrift.matched) expect(shortDrift.reason).toBe('item_count');
  });

  it('N20 keeps an exact-name pair on the strict advisory', () => {
    const strict = evaluateMinuteStrictRescanAdvisory(draft, saved);
    expect(strict.matched).toBe(true);
    const drift = evaluateMinuteSingleNameDriftRescanAdvisory(draft, saved);
    expect(drift.matched).toBe(false);
    if (!drift.matched) expect(drift.reason).toBe('strict_already_matched');
    expect(gateFor(draft, [saved])?.matchKind).toBe('MINUTE_STRICT_ADVISORY');
  });

  it('prefers a newer strict minute match over an older single-name drift', () => {
    const olderDrift = storedFrom(
      draftFrom({ items: renamed(12, 11, 'synth-line-12-ocr') }),
      'syn-tier3-old',
      1
    );
    const newerStrict = storedFrom(draft, 'syn-tier2-new', 50);
    for (const history of [
      [olderDrift, newerStrict],
      [newerStrict, olderDrift],
    ]) {
      const gate = gateFor(draft, history);
      expect(gate?.existingReceiptId).toBe('syn-tier2-new');
      expect(gate?.matchKind).toBe('MINUTE_STRICT_ADVISORY');
    }
  });

  it('keeps created_at then code-unit ID order inside one evidence tier', () => {
    const strictEarly = storedFrom(draft, 'syn-strict-early', 2);
    const strictLate = storedFrom(draft, 'syn-strict-late', 8);
    expect(gateFor(draft, [strictLate, strictEarly])?.existingReceiptId).toBe(
      'syn-strict-early'
    );
    expect(gateFor(draft, [strictEarly, strictLate])?.existingReceiptId).toBe(
      'syn-strict-early'
    );
    const strictA = storedFrom(draft, 'hist-A_1', 10);
    const strictB = storedFrom(draft, 'hist_a-1', 10);
    expect('hist-A_1' < 'hist_a-1').toBe(true);
    expect(gateFor(draft, [strictB, strictA])?.existingReceiptId).toBe('hist-A_1');
    expect(gateFor(draft, [strictA, strictB])?.existingReceiptId).toBe('hist-A_1');
    expect(gateFor(draft, [strictA, strictB])?.matchKind).toBe('MINUTE_STRICT_ADVISORY');

    const driftLines = renamed(12, 4, 'synth-line-5-ocr');
    const driftDraft = draftFrom({ items: baseLines(12) });
    const driftEarly = storedFrom(draftFrom({ items: driftLines }), 'syn-drift-early', 2);
    const driftLate = storedFrom(draftFrom({ items: driftLines }), 'syn-drift-late', 8);
    expect(gateFor(driftDraft, [driftLate, driftEarly])?.existingReceiptId).toBe(
      'syn-drift-early'
    );
    expect(gateFor(driftDraft, [driftEarly, driftLate])?.matchKind).toBe(
      'MINUTE_SINGLE_NAME_DRIFT_ADVISORY'
    );
    const driftA = storedFrom(draftFrom({ items: driftLines }), 'hist-A_1', 10);
    const driftB = storedFrom(draftFrom({ items: driftLines }), 'hist_a-1', 10);
    expect(gateFor(driftDraft, [driftB, driftA])?.existingReceiptId).toBe('hist-A_1');
    expect(gateFor(driftDraft, [driftA, driftB])?.existingReceiptId).toBe('hist-A_1');
  });

  it('returns the same Tier-3 target when history order is reversed', () => {
    const earlier = storedFrom(draftFrom({ items: renamed(12, 3, 'synth-line-4-ocr') }), 'syn-drift-z', 3);
    const later = { ...earlier, id: 'syn-drift-a', created_at: 9 };
    expect(gateFor(draft, [later, earlier])?.existingReceiptId).toBe('syn-drift-z');
    expect(gateFor(draft, [earlier, later])?.existingReceiptId).toBe('syn-drift-z');
    expect(getReceipt).not.toHaveBeenCalled();
    expect(listReceiptsForAnalysis).not.toHaveBeenCalled();
    const source = fs.readFileSync(
      path.join(__dirname, 'scanReviewMinuteStrictAdvisory.ts'),
      'utf8'
    );
    expect(source).toContain('evaluateMinuteSingleNameDriftRescanAdvisory');
    expect(source).toContain('meruno-minute-single-name-drift-advisory-v2');
    expect(source).not.toMatch(
      /levenshtein|editDistance|assignVerifiedPurchaseOccurrence|requestCloudBackupFlush|getSupabaseClient|\bUPDATE\s+receipts\b/i
    );
  });
});
