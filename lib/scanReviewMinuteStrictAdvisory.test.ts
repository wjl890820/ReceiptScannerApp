/**
 * Scan Review minute-precision advisory. Synthetic ids and names only.
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
import { evaluateExactTransactionReceiptCollision } from './receiptExactTransactionCollision';
import {
  cloneCollisionReceipt,
  makeYorkCollisionReceiptA,
  makeYorkCollisionReceiptB,
} from './receiptExactTransactionCollision.testFixtures';
import {
  buildTransientScanReviewReceipt,
  evaluateScanReviewDuplicateGate,
  shouldShowScanReviewDuplicateGateMatch,
  type ScanReviewDuplicateGateContext,
} from './scanReviewDuplicateGate';
import { shouldHideDuplicateGateSaveBar } from './scanReviewDuplicateGateTerminal';
import { evaluateMinuteStrictRescanAdvisory } from './scanReviewMinuteStrictAdvisory';
import {
  indexHighConfidenceDuplicateGroupsByReceiptId,
  selectAnalyticsReceipts,
} from './analyticsReceiptSelection';

const MERCHANT = '合成スーパー北店';
const TX = '2026-07-10 12:03';

function basket(patch?: {
  names?: string[];
  quantities?: number[];
  amounts?: number[];
}) {
  const names = patch?.names ?? ['synth-peanut', 'synth-bun', 'synth-tofu'];
  const quantities = patch?.quantities ?? [1, 3, 1];
  const amounts = patch?.amounts ?? [292, 1317, 355];
  return names.map((name, index) => ({
    name,
    quantity: quantities[index],
    lineTotal: amounts[index],
  }));
}

function draftFrom(input?: {
  merchant?: string | null;
  transactionDate?: string;
  total?: number;
  tax?: number;
  taxKnown?: boolean;
  currency?: string;
  items?: readonly unknown[];
  id?: string;
}): ReceiptRow {
  const transient = buildTransientScanReviewReceipt({
    transientReceiptId: input?.id ?? 'syn-min-draft',
    imageUri: 'file://syn-draft.jpg',
    analysis: {
      merchant: input?.merchant === undefined ? MERCHANT : input.merchant,
      transactionDate: input?.transactionDate ?? TX,
      total: input?.total ?? 2121,
      tax: input?.tax ?? 157,
      tax_is_known: input?.taxKnown ?? true,
      currency: input?.currency ?? 'JPY',
      items: input?.items ?? basket(),
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

function withPrecision(row: ReceiptRow, precision: string): ReceiptRow {
  const analysis = JSON.parse(row.analysis_json) as Record<string, unknown>;
  analysis.transaction_time_precision = precision;
  return {
    ...row,
    transaction_time_precision: precision,
    analysis_json: JSON.stringify(analysis),
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

function withItems(row: ReceiptRow, items: readonly unknown[]): ReceiptRow {
  const analysis = JSON.parse(row.analysis_json) as Record<string, unknown>;
  analysis.items = items;
  return {
    ...row,
    user_items_json: null,
    analysis_json: JSON.stringify(analysis),
  };
}

describe('scan review minute strict advisory', () => {
  const draft = draftFrom();
  const saved = storedFrom(draft, 'syn-min-hist');

  it('P1 and the real-failure shape warn without becoming second-exact truth', () => {
    expect(draft.total).toBe(2121);
    expect(draft.tax).toBe(157);
    const collision = evaluateExactTransactionReceiptCollision(draft, saved);
    expect(collision.collided).toBe(false);
    if (!collision.collided) {
      expect(collision.reason).toBe('transaction_time_not_exact');
    }
    const advisory = evaluateMinuteStrictRescanAdvisory(draft, saved);
    expect(advisory.matched).toBe(true);
    if (advisory.matched) {
      expect(advisory.reason).toBe('MINUTE_STRICT_ADVISORY');
      expect(advisory.itemCount).toBe(3);
    }
    const gate = gateFor(draft, [saved]);
    expect(gate?.existingReceiptId).toBe('syn-min-hist');
    expect(gate?.matchKind).toBe('MINUTE_STRICT_ADVISORY');
    expect(gate?.total).toBe(2121);
  });

  it('treats case and surrounding space as the same item identity', () => {
    const spaced = storedFrom(
      draftFrom({
        items: basket({
          names: ['  Synth-Peanut ', 'SYNTH-BUN', 'Synth-Tofu'],
        }),
      }),
      'syn-min-case'
    );
    const advisory = evaluateMinuteStrictRescanAdvisory(draft, spaced);
    expect(advisory.matched).toBe(true);
  });

  it('P2 selects only the intended historical candidate', () => {
    const unrelated = storedFrom(
      draftFrom({
        merchant: '別の合成商店',
        transactionDate: '2026-07-10 18:40',
        total: 999,
        items: basket({ names: ['synth-other'], quantities: [1], amounts: [999] }),
      }),
      'syn-min-other',
      1
    );
    const laterCopy = storedFrom(draft, 'syn-min-later', 50);
    const earlier = storedFrom(draft, 'syn-min-earlier', 4);
    const gate = gateFor(draft, [unrelated, laterCopy, earlier]);
    expect(gate?.existingReceiptId).toBe('syn-min-earlier');
    expect(gate?.matchKind).toBe('MINUTE_STRICT_ADVISORY');
  });

  it('keeps the existing second-precision gate match', () => {
    const left = makeYorkCollisionReceiptA();
    const right = makeYorkCollisionReceiptB();
    const collision = evaluateExactTransactionReceiptCollision(left, right);
    expect(collision.collided).toBe(true);
    const gate = gateFor(left, [right]);
    expect(gate?.existingReceiptId).toBe(right.id);
    expect(gate?.matchKind).toBe('SECOND_EXACT');
  });

  it('rejects the required negative minute pairs', () => {
    const cases: { name: string; stored: ReceiptRow; reason: string }[] = [
      {
        name: 'N1 minute/second',
        stored: withPrecision(saved, 'second'),
        reason: 'precision_not_both_minute',
      },
      {
        name: 'N2 minute/unknown',
        stored: withPrecision(saved, 'unknown'),
        reason: 'precision_not_both_minute',
      },
      {
        name: 'N3 basket differs',
        stored: storedFrom(
          draftFrom({
            items: basket({ names: ['synth-peanut', 'synth-bun', 'synth-other'] }),
          }),
          'syn-min-basket'
        ),
        reason: 'basket_mismatch',
      },
      {
        name: 'N4 merchant conflicts',
        stored: storedFrom(draftFrom({ merchant: '合成スーパー南店' }), 'syn-min-store'),
        reason: 'merchant_conflict',
      },
      {
        name: 'N5 one minute later',
        stored: {
          ...saved,
          transaction_at: (saved.transaction_at ?? 0) + 60_000,
        },
        reason: 'transaction_time_mismatch',
      },
      {
        name: 'N6 total differs by 1',
        stored: { ...saved, total: 2122 },
        reason: 'total_mismatch',
      },
      {
        name: 'N7 known tax differs',
        stored: { ...saved, tax: 158 },
        reason: 'tax_mismatch',
      },
      {
        name: 'N8 tax unknown',
        stored: { ...saved, tax_is_known: 0 },
        reason: 'tax_not_known',
      },
      {
        name: 'N9 quantity differs',
        stored: storedFrom(
          draftFrom({ items: basket({ quantities: [1, 2, 1] }) }),
          'syn-min-qty'
        ),
        reason: 'basket_mismatch',
      },
      {
        name: 'N10 line amount differs',
        stored: storedFrom(
          draftFrom({ items: basket({ amounts: [293, 1317, 355] }) }),
          'syn-min-amt'
        ),
        reason: 'basket_mismatch',
      },
      {
        name: 'N11 order differs',
        stored: storedFrom(
          draftFrom({
            items: basket({
              names: ['synth-bun', 'synth-peanut', 'synth-tofu'],
              quantities: [3, 1, 1],
              amounts: [1317, 292, 355],
            }),
          }),
          'syn-min-order'
        ),
        reason: 'basket_mismatch',
      },
      {
        name: 'N12 blank merchant',
        stored: storedFrom(draftFrom({ merchant: '   ' }), 'syn-min-blank'),
        reason: 'merchant_missing',
      },
      {
        name: 'N13 currency mismatch',
        stored: { ...saved, currency: 'USD' },
        reason: 'currency_not_supported',
      },
      {
        name: 'N14 malformed precision',
        stored: withPrecision(saved, 'not-a-precision'),
        reason: 'precision_malformed',
      },
      {
        name: 'N15 different clock minute same day',
        stored: storedFrom(
          draftFrom({ transactionDate: '2026-07-10 15:03' }),
          'syn-min-later-clock'
        ),
        reason: 'transaction_time_mismatch',
      },
    ];

    for (const entry of cases) {
      const advisory = evaluateMinuteStrictRescanAdvisory(draft, entry.stored);
      expect({ name: entry.name, matched: advisory.matched, reason: advisory.reason }).toEqual({
        name: entry.name,
        matched: false,
        reason: entry.reason,
      });
      expect(gateFor(draft, [entry.stored])).toBeNull();
    }
  });

  it('shows the existing warning card target and does not write', () => {
    const gate = gateFor(draft, [saved]);
    expect(
      shouldShowScanReviewDuplicateGateMatch(gate, null)
    ).toBe(true);
    expect(
      shouldHideDuplicateGateSaveBar({
        showDuplicateGate: shouldShowScanReviewDuplicateGateMatch(gate, null),
        terminalDuplicateDestinationId: null,
      })
    ).toBe(true);
    expect(gate?.existingReceiptId).toBe('syn-min-hist');

    const nonMatch = gateFor(draft, [withPrecision(saved, 'second')]);
    expect(shouldShowScanReviewDuplicateGateMatch(nonMatch, null)).toBe(false);
    expect(
      shouldHideDuplicateGateSaveBar({
        showDuplicateGate: false,
        terminalDuplicateDestinationId: null,
      })
    ).toBe(false);

    expect(getReceipt).not.toHaveBeenCalled();
    expect(listReceiptsForAnalysis).not.toHaveBeenCalled();
    const advisorySource = fs.readFileSync(
      path.join(__dirname, 'scanReviewMinuteStrictAdvisory.ts'),
      'utf8'
    );
    const gateSource = fs.readFileSync(
      path.join(__dirname, 'scanReviewDuplicateGate.ts'),
      'utf8'
    );
    expect(advisorySource).not.toMatch(
      /assignVerifiedPurchaseOccurrence|requestCloudBackupFlush|getSupabaseClient|sync_outbox|\bUPDATE\s+receipts\b/i
    );
    expect(gateSource).not.toMatch(
      /assignVerifiedPurchaseOccurrence|requestCloudBackupFlush|getSupabaseClient|\bUPDATE\s+receipts\b/i
    );
    const collisionSource = fs.readFileSync(
      path.join(__dirname, 'receiptExactTransactionCollision.ts'),
      'utf8'
    );
    expect(collisionSource).toContain('AMOUNT_BASIS_TOLERANCE_JPY');
    expect(collisionSource).not.toContain('readStrictAdvisoryBasket');
  });

  it('fails closed when a known chain loses the store but raw text differs', () => {
    const north = draftFrom({ merchant: '株式会社セブンイレブン 北店' });
    const northSaved = storedFrom(north, 'syn-min-north');
    const south = storedFrom(
      draftFrom({ merchant: '株式会社セブンイレブン 南店' }),
      'syn-min-south'
    );
    const conflict = evaluateMinuteStrictRescanAdvisory(north, south);
    expect(conflict.matched).toBe(false);
    if (!conflict.matched) expect(conflict.reason).toBe('merchant_conflict');
    expect(gateFor(north, [south])).toBeNull();
    expect(evaluateMinuteStrictRescanAdvisory(north, northSaved).matched).toBe(true);
  });

  it('matches an explicit same store and rejects a conflicting store hint', () => {
    const north = draftFrom({ merchant: 'ヨークベニマル 北店' });
    const same = storedFrom(north, 'syn-york-north');
    const south = storedFrom(
      draftFrom({ merchant: 'ヨークベニマル 南店' }),
      'syn-york-south'
    );
    expect(evaluateMinuteStrictRescanAdvisory(north, same).matched).toBe(true);
    const conflict = evaluateMinuteStrictRescanAdvisory(north, south);
    expect(conflict.matched).toBe(false);
    if (!conflict.matched) expect(conflict.reason).toBe('merchant_conflict');
  });

  it('rejects malformed baskets that the second-precision parser would soften', () => {
    const lines = basket();
    const conflictAliases = withItems(saved, [
      lines[0]!,
      { name: 'synth-bun', quantity: 3, lineTotal: 1317, amount: 1316 },
      lines[2]!,
    ]);
    const equalAliases = withItems(saved, [
      lines[0]!,
      { name: 'synth-bun', quantity: 3, lineTotal: 1317, amount: 1317 },
      lines[2]!,
    ]);
    const extraZero = withItems(saved, [
      ...lines,
      { name: 'synth-zero', quantity: 1, lineTotal: 0 },
    ]);
    const extraNegative = withItems(saved, [
      ...lines,
      { name: 'synth-neg', quantity: 1, lineTotal: -40 },
    ]);
    const missingQuantity = withItems(saved, [
      { name: 'synth-peanut', lineTotal: 292 },
      lines[1]!,
      lines[2]!,
    ]);
    const missingAmount = withItems(saved, [
      { name: 'synth-peanut', quantity: 1 },
      lines[1]!,
      lines[2]!,
    ]);
    const malformed = withItems(saved, [...lines, null]);

    const fractionalAlias = withItems(saved, [
      lines[0]!,
      { name: 'synth-bun', quantity: 3, lineTotal: 1317, amount: 1317.004 },
      lines[2]!,
    ]);
    const fractionalOnly = withItems(saved, [
      lines[0]!,
      { name: 'synth-bun', quantity: 3, amount: 1317.004 },
      lines[2]!,
    ]);
    const fractionalLine = withItems(saved, [
      lines[0]!,
      { name: 'synth-bun', quantity: 3, lineTotal: 1317.004 },
      lines[2]!,
    ]);
    const negativeFractional = withItems(saved, [
      ...lines,
      { name: 'synth-frac-neg', quantity: 1, lineTotal: -1.004 },
    ]);

    expect(evaluateMinuteStrictRescanAdvisory(draft, conflictAliases).matched).toBe(false);
    expect(evaluateMinuteStrictRescanAdvisory(draft, equalAliases).matched).toBe(true);
    expect(evaluateMinuteStrictRescanAdvisory(draft, fractionalAlias).matched).toBe(false);
    expect(evaluateMinuteStrictRescanAdvisory(draft, fractionalOnly).matched).toBe(false);
    expect(evaluateMinuteStrictRescanAdvisory(draft, fractionalLine).matched).toBe(false);
    expect(evaluateMinuteStrictRescanAdvisory(draft, negativeFractional).matched).toBe(false);
    expect(evaluateMinuteStrictRescanAdvisory(draft, extraZero).matched).toBe(false);
    expect(evaluateMinuteStrictRescanAdvisory(draft, extraNegative).matched).toBe(false);
    expect(evaluateMinuteStrictRescanAdvisory(draft, missingQuantity).matched).toBe(false);
    expect(evaluateMinuteStrictRescanAdvisory(draft, missingAmount).matched).toBe(false);
    expect(evaluateMinuteStrictRescanAdvisory(draft, malformed).matched).toBe(false);
    expect(gateFor(draft, [conflictAliases])).toBeNull();
    expect(gateFor(draft, [extraZero])).toBeNull();
    expect(gateFor(draft, [extraNegative])).toBeNull();

    const second = makeYorkCollisionReceiptA();
    const secondItems = (
      JSON.parse(second.analysis_json) as { items: { lineTotal: number }[] }
    ).items.map((item, index) =>
      index === 0 ? { ...item, amount: item.lineTotal - 1 } : item
    );
    const aliased = cloneCollisionReceipt(second, {
      id: 'syn-second-alias',
      items: secondItems,
    });
    expect(evaluateExactTransactionReceiptCollision(second, aliased).collided).toBe(true);
  });

  it('picks the same candidate regardless of history order', () => {
    const earlier = storedFrom(draft, 'syn-min-z', 3);
    const later = storedFrom(draft, 'syn-min-a', 9);
    expect(gateFor(draft, [later, earlier])?.existingReceiptId).toBe('syn-min-z');
    expect(gateFor(draft, [earlier, later])?.existingReceiptId).toBe('syn-min-z');

    const tieA = storedFrom(draft, 'syn-min-a', 10);
    const tieB = storedFrom(draft, 'syn-min-b', 10);
    expect(gateFor(draft, [tieB, tieA])?.existingReceiptId).toBe('syn-min-a');
    expect(gateFor(draft, [tieA, tieB])?.existingReceiptId).toBe('syn-min-a');

    const codeUnitFirst = storedFrom(draft, 'hist-A_1', 10);
    const codeUnitSecond = storedFrom(draft, 'hist_a-1', 10);
    expect('hist-A_1' < 'hist_a-1').toBe(true);
    expect(gateFor(draft, [codeUnitSecond, codeUnitFirst])?.existingReceiptId).toBe(
      'hist-A_1'
    );
    expect(gateFor(draft, [codeUnitFirst, codeUnitSecond])?.existingReceiptId).toBe(
      'hist-A_1'
    );
    const gateSource = fs.readFileSync(
      path.join(__dirname, 'scanReviewDuplicateGate.ts'),
      'utf8'
    );
    expect(gateSource).not.toContain('localeCompare');
    const advisorySource = fs.readFileSync(
      path.join(__dirname, 'scanReviewMinuteStrictAdvisory.ts'),
      'utf8'
    );
    expect(advisorySource).not.toContain('Math.round');
  });
});
