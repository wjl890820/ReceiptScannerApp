/**
 * A3.2.2 diagnostic-only minute duplicate rejection reasons.
 * Synthetic ids and names only. Diagnostics must not change the gate match.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  listReceiptsForAnalysis: jest.fn(),
  getReceipt: jest.fn(),
}));

import type { ReceiptRow } from './db';
import {
  getDiagnosticSnapshot,
  internalDiagnostics,
} from './internalDiagnostics';
import { setInternalDiagnosticsEnabledForTests } from './internalDiagnosticsGate';
import {
  indexHighConfidenceDuplicateGroupsByReceiptId,
  selectAnalyticsReceipts,
} from './analyticsReceiptSelection';
import {
  buildTransientScanReviewReceipt,
  evaluateScanReviewDuplicateGate,
  type ScanReviewDuplicateGateContext,
} from './scanReviewDuplicateGate';
import { SCAN_REVIEW_DUPLICATE_CANDIDATE_DIAG_EVENT } from './scanReviewMinuteStrictAdvisory';

const MERCHANT = 'synth-market-diag';
const TX = '2026-08-01 09:15';
const TOTAL = 9000;
const TAX = 180;
const SECRET_TEXT = [
  MERCHANT,
  'synth drink 1.5',
  'synthdrink 1.5',
  'completely-different-token',
  'synth-line-seven',
  'file://syn-diag.jpg',
];

function baseLines(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `synth-line-${index + 1}`,
    quantity: 1,
    lineTotal: 100 + index,
  }));
}

function draftFrom(input?: {
  items?: readonly unknown[];
  id?: string;
}): ReceiptRow {
  const transient = buildTransientScanReviewReceipt({
    transientReceiptId: input?.id ?? 'syn-diag-draft',
    imageUri: 'file://syn-diag.jpg',
    analysis: {
      merchant: MERCHANT,
      transactionDate: TX,
      total: TOTAL,
      tax: TAX,
      tax_is_known: true,
      currency: 'JPY',
      items: input?.items ?? baseLines(12),
    } as never,
  });
  if (!transient) throw new Error('transient projection failed');
  return transient;
}

function storedFrom(draft: ReceiptRow, id: string): ReceiptRow {
  const analysis = JSON.parse(draft.analysis_json) as {
    transaction_time_precision?: string;
  };
  return {
    ...draft,
    id,
    created_at: 10,
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

function gateFor(draft: ReceiptRow, stored: ReceiptRow) {
  return evaluateScanReviewDuplicateGate(draft, context([stored]));
}

function diagEvents() {
  return getDiagnosticSnapshot().events.filter(
    (event) => event.name === SCAN_REVIEW_DUPLICATE_CANDIDATE_DIAG_EVENT
  );
}

function assertStructuralPayload(payload: string) {
  for (const secret of SECRET_TEXT) {
    expect(payload).not.toContain(secret);
  }
  expect(payload).not.toContain('lineTotal');
  expect(payload).not.toContain('merchant_raw');
}

function assertCurrentDiagClean() {
  const events = diagEvents();
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    assertStructuralPayload(JSON.stringify(event));
    expect(Object.keys(event.meta ?? {}).length).toBeLessThanOrEqual(24);
  }
}

describe('scan review duplicate candidate diagnostics', () => {
  beforeEach(() => {
    setInternalDiagnosticsEnabledForTests(true);
    internalDiagnostics.resetForTests(undefined, { hydrated: true });
  });

  afterEach(() => {
    setInternalDiagnosticsEnabledForTests(null);
    internalDiagnostics.resetForTests(undefined, { hydrated: true });
  });

  it('does not change the gate match when diagnostics are enabled', () => {
    const draft = draftFrom();
    const exact = storedFrom(draft, 'syn-diag-exact');
    const drifted = storedFrom(
      draftFrom({
        items: baseLines(12).map((row, index) =>
          index === 6 ? { ...row, name: 'completely-different-token' } : row
        ),
      }),
      'syn-diag-drift'
    );
    const whitespace = storedFrom(
      draftFrom({
        items: baseLines(12).map((row, index) =>
          index === 2 ? { ...row, name: 'synthdrink 1.5' } : row
        ),
      }),
      'syn-diag-space'
    );
    const leftSpace = draftFrom({
      items: baseLines(12).map((row, index) =>
        index === 2 ? { ...row, name: 'synth drink 1.5' } : row
      ),
      id: 'syn-diag-space-left',
    });

    setInternalDiagnosticsEnabledForTests(false);
    const disabled = {
      exact: gateFor(draft, exact),
      drifted: gateFor(draft, drifted),
      whitespace: gateFor(leftSpace, whitespace),
    };
    expect(diagEvents()).toHaveLength(0);

    setInternalDiagnosticsEnabledForTests(true);
    internalDiagnostics.resetForTests(undefined, { hydrated: true });
    const enabled = {
      exact: gateFor(draft, exact),
      drifted: gateFor(draft, drifted),
      whitespace: gateFor(leftSpace, whitespace),
    };
    expect(enabled).toEqual(disabled);
    expect(enabled.exact?.matchKind).toBe('MINUTE_STRICT_ADVISORY');
    expect(enabled.drifted?.matchKind).toBe('MINUTE_SINGLE_NAME_DRIFT_ADVISORY');
    expect(enabled.whitespace).toBeNull();
  });

  it('emits structural reject reasons without product or merchant text', () => {
    const whitespaceLeft = draftFrom({
      items: baseLines(12).map((row, index) =>
        index === 2 ? { ...row, name: 'synth drink 1.5' } : row
      ),
      id: 'syn-diag-ws-left',
    });
    const whitespaceRight = storedFrom(
      draftFrom({
        items: baseLines(12).map((row, index) =>
          index === 2 ? { ...row, name: 'synthdrink 1.5' } : row
        ),
      }),
      'syn-diag-ws-right'
    );
    expect(gateFor(whitespaceLeft, whitespaceRight)).toBeNull();
    const whitespace = diagEvents()[0];
    expect(whitespace?.meta).toMatchObject({
      event: SCAN_REVIEW_DUPLICATE_CANDIDATE_DIAG_EVENT,
      candidateReceiptId: 'syn-diag-ws-right',
      strictReason: 'basket_mismatch',
      driftReason: 'name_drift_count',
      matchKind: 'none',
      itemCountLeft: 12,
      itemCountRight: 12,
      nameMismatchCount: 0,
      whitespaceOnlyDifferenceCount: 1,
      firstMismatchIndex: -1,
    });
    assertCurrentDiagClean();

    internalDiagnostics.resetForTests(undefined, { hydrated: true });
    const quantityRight = storedFrom(
      draftFrom({
        items: baseLines(12).map((row, index) => {
          if (index === 1) return { ...row, name: 'synthdrink 1.5' };
          if (index === 4) return { ...row, quantity: 2 };
          return row;
        }),
      }),
      'syn-diag-qty-right'
    );
    const quantityLeft = draftFrom({
      items: baseLines(12).map((row, index) =>
        index === 1 ? { ...row, name: 'synth drink 1.5' } : row
      ),
      id: 'syn-diag-qty-left',
    });
    expect(gateFor(quantityLeft, quantityRight)).toBeNull();
    expect(diagEvents()[0]?.meta).toMatchObject({
      driftReason: 'quantity_mismatch',
      matchKind: 'none',
      firstMismatchIndex: 4,
      nameMismatchCount: 0,
      whitespaceOnlyDifferenceCount: 1,
    });
    assertCurrentDiagClean();

    internalDiagnostics.resetForTests(undefined, { hydrated: true });
    const amountRight = storedFrom(
      draftFrom({
        items: baseLines(12).map((row, index) =>
          index === 7 ? { ...row, lineTotal: row.lineTotal + 1 } : row
        ),
      }),
      'syn-diag-amt-right'
    );
    expect(gateFor(draftFrom({ id: 'syn-diag-amt-left' }), amountRight)).toBeNull();
    expect(diagEvents()[0]?.meta).toMatchObject({
      driftReason: 'amount_mismatch',
      firstMismatchIndex: 7,
      nameMismatchCount: 0,
      whitespaceOnlyDifferenceCount: 0,
    });
    assertCurrentDiagClean();

    internalDiagnostics.resetForTests(undefined, { hydrated: true });
    const twoNames = storedFrom(
      draftFrom({
        items: baseLines(12).map((row, index) => {
          if (index === 1) return { ...row, name: 'synthdrink 1.5' };
          if (index === 3) return { ...row, name: 'abc123' };
          if (index === 5) return { ...row, name: 'token-right-b' };
          if (index === 8) return { ...row, name: 'completely-different-token' };
          if (index === 10) return { ...row, name: 'token-right-d' };
          return row;
        }),
      }),
      'syn-diag-two-right'
    );
    const twoLeft = draftFrom({
      items: baseLines(12).map((row, index) => {
        if (index === 1) return { ...row, name: 'synth drink 1.5' };
        if (index === 3) return { ...row, name: 'abc-123' };
        if (index === 5) return { ...row, name: 'token-left-b' };
        if (index === 8) return { ...row, name: 'synth-line-seven' };
        if (index === 10) return { ...row, name: 'token-left-d' };
        return row;
      }),
      id: 'syn-diag-two-left',
    });
    expect(gateFor(twoLeft, twoNames)).toBeNull();
    expect(diagEvents()[0]?.meta).toMatchObject({
      driftReason: 'name_drift_count',
      matchKind: 'none',
      firstMismatchIndex: 3,
      nameMismatchCount: 4,
      whitespaceOnlyDifferenceCount: 1,
    });
    assertCurrentDiagClean();

    internalDiagnostics.resetForTests(undefined, { hydrated: true });
    const invalidLeft = draftFrom({
      items: baseLines(12).map(({ quantity: _quantity, ...row }) => row),
      id: 'syn-diag-bad-left',
    });
    expect(gateFor(invalidLeft, storedFrom(draftFrom(), 'syn-diag-bad-right'))).toBeNull();
    expect(diagEvents()[0]?.meta).toMatchObject({
      strictReason: 'basket_invalid',
      driftReason: 'basket_invalid',
      basketInvalidSide: 'left',
      itemCountLeft: 12,
      itemCountRight: 12,
    });
    assertCurrentDiagClean();

    internalDiagnostics.resetForTests(undefined, { hydrated: true });
    const invalidRight = storedFrom(
      draftFrom({
        items: baseLines(12).map(({ quantity: _quantity, ...row }) => row),
      }),
      'syn-diag-bad-right-only'
    );
    expect(gateFor(draftFrom({ id: 'syn-diag-good-left' }), invalidRight)).toBeNull();
    expect(diagEvents()[0]?.meta?.basketInvalidSide).toBe('right');
    assertCurrentDiagClean();

    internalDiagnostics.resetForTests(undefined, { hydrated: true });
    const bothInvalidLeft = draftFrom({
      items: baseLines(5).map(({ quantity: _quantity, ...row }) => row),
      id: 'syn-diag-both-left',
    });
    const bothInvalidRight = storedFrom(
      draftFrom({
        items: baseLines(5).map(({ quantity: _quantity, ...row }) => row),
      }),
      'syn-diag-both-right'
    );
    expect(gateFor(bothInvalidLeft, bothInvalidRight)).toBeNull();
    expect(diagEvents()[0]?.meta?.basketInvalidSide).toBe('both');
    assertCurrentDiagClean();
  });

  it('records a matching minute candidate without changing its match kind', () => {
    const draft = draftFrom();
    const exact = storedFrom(draft, 'syn-diag-match-exact');
    expect(gateFor(draft, exact)?.matchKind).toBe('MINUTE_STRICT_ADVISORY');
    expect(diagEvents()[0]?.meta).toMatchObject({
      candidateReceiptId: 'syn-diag-match-exact',
      strictReason: 'MINUTE_STRICT_ADVISORY',
      matchKind: 'MINUTE_STRICT_ADVISORY',
      itemCountLeft: 12,
      itemCountRight: 12,
    });
    expect(diagEvents()[0]?.meta).not.toHaveProperty('driftReason');
    expect(diagEvents()[0]?.meta).not.toHaveProperty('firstMismatchIndex');
    assertStructuralPayload(JSON.stringify(diagEvents()[0]));
  });
});
