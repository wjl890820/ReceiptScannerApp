/**
 * B7 — Scan Review duplicate advisory uses the mounted production helper chain.
 * Synthetic ids and names only.
 */

/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  listReceiptsForAnalysis: jest.fn(),
  getReceipt: jest.fn(),
}));

import type { ReceiptRow } from './db';
import { mergeReviewSnapshotPreservingEvidence } from './receiptPrintedEvidence';
import {
  buildTransientScanReviewReceipt,
  dismissScanReviewDuplicateEvidence,
  evaluateScanReviewDuplicateGate,
  loadScanReviewDuplicateGateContext,
  shouldApplyScanReviewDuplicateGateUpdate,
  shouldShowScanReviewDuplicateGateMatch,
  type ScanReviewDuplicateGateMatch,
} from './scanReviewDuplicateGate';
import { shouldHideDuplicateGateSaveBar } from './scanReviewDuplicateGateTerminal';

const MERCHANT = '合成スーパー北店';
const OTHER_MERCHANT = '別の合成商店';
const TX = '2026-07-10 12:03';
const TOTAL = 2121;
const TAX = 157;

const RECOGNITION_SNAPSHOT = {
  merchant: '未确认商店',
  transactionDate: '2026-01-01',
  total: 1,
  tax: 0,
  tax_is_known: true,
  currency: 'JPY',
  items: [{ name: 'ocr-only-line', quantity: 1, lineTotal: 1 }],
};

function basket(names: readonly string[]) {
  const amounts = [292, 1317, 355, 100, 57];
  return names.map((name, index) => ({
    name,
    quantity: 1,
    lineTotal: amounts[index],
  }));
}

const MATCHING_NAMES = [
  'synth-peanut',
  'synth-bun',
  'synth-tofu',
  'synth-milk',
  'synth-egg',
] as const;

function reviewedAnalysis(patch?: {
  merchant?: string;
  transactionDate?: string;
  names?: readonly string[];
}) {
  return mergeReviewSnapshotPreservingEvidence(RECOGNITION_SNAPSHOT, {
    merchant: patch?.merchant ?? MERCHANT,
    transactionDate: patch?.transactionDate ?? TX,
    total: TOTAL,
    tax: TAX,
    tax_is_known: true,
    currency: 'JPY',
    items: basket(patch?.names ?? MATCHING_NAMES),
  });
}

function projectDraft(
  analysis: Record<string, unknown>,
  draftId: string
): ReceiptRow {
  const transient = buildTransientScanReviewReceipt({
    transientReceiptId: `scan-review:${draftId}`,
    imageUri: 'file://b7-draft.jpg',
    analysis: analysis as never,
  });
  if (!transient) throw new Error('transient projection failed');
  return transient;
}

function savedFrom(draft: ReceiptRow, id: string): ReceiptRow {
  return {
    ...draft,
    id,
    created_at: 20,
  };
}

async function gateFor(
  draft: ReceiptRow,
  history: readonly ReceiptRow[]
): Promise<ScanReviewDuplicateGateMatch | null> {
  const context = await loadScanReviewDuplicateGateContext({
    listOwnerReceipts: async () => [...history],
  });
  if (!context) return null;
  return evaluateScanReviewDuplicateGate(draft, context);
}

function saveBarHidden(match: ScanReviewDuplicateGateMatch | null): boolean {
  return shouldHideDuplicateGateSaveBar({
    showDuplicateGate: shouldShowScanReviewDuplicateGateMatch(match, null),
    terminalDuplicateDestinationId: null,
  });
}

describe('Scan Review duplicate advisory production path', () => {
  const matchingDraft = projectDraft(reviewedAnalysis(), 'draft-a');
  const history = savedFrom(matchingDraft, 'b7-hist');

  it('minute-strict reviewed values warn and hide the save bar', async () => {
    const snapshotOnly = projectDraft(RECOGNITION_SNAPSHOT, 'draft-a');
    expect(await gateFor(snapshotOnly, [history])).toBeNull();

    const match = await gateFor(matchingDraft, [history]);
    expect(match).not.toBeNull();
    expect(match?.matchKind).toBe('MINUTE_STRICT_ADVISORY');
    expect(match?.existingReceiptId).toBe('b7-hist');
    expect(match?.existingReceiptId).not.toBe(matchingDraft.id);
    expect(shouldShowScanReviewDuplicateGateMatch(match, null)).toBe(true);
    expect(saveBarHidden(match)).toBe(true);
  });

  it('a different reviewed merchant does not warn or hide the save bar', async () => {
    const draft = projectDraft(
      reviewedAnalysis({ merchant: OTHER_MERCHANT }),
      'draft-a'
    );
    const match = await gateFor(draft, [history]);
    expect(match).toBeNull();
    expect(shouldShowScanReviewDuplicateGateMatch(match, null)).toBe(false);
    expect(saveBarHidden(match)).toBe(false);
  });

  it('does not apply a draft A result after the screen moves to draft B', () => {
    const startedForA = {
      mounted: true,
      capturedGeneration: 4,
      currentGeneration: 4,
      capturedDraftId: 'draft-a',
      currentDraftId: 'draft-a',
    };
    expect(shouldApplyScanReviewDuplicateGateUpdate(startedForA)).toBe(true);
    expect(
      shouldApplyScanReviewDuplicateGateUpdate({
        ...startedForA,
        currentGeneration: 5,
        currentDraftId: 'draft-b',
      })
    ).toBe(false);
    expect(
      shouldApplyScanReviewDuplicateGateUpdate({
        ...startedForA,
        currentDraftId: 'draft-b',
      })
    ).toBe(false);
  });

  it('Continue Review hides only the current evidence key', async () => {
    const first = await gateFor(matchingDraft, [history]);
    expect(first?.matchKind).toBe('MINUTE_STRICT_ADVISORY');
    const dismissed = dismissScanReviewDuplicateEvidence(first!);
    expect(dismissed).toBe(first?.evidenceKey);
    expect(shouldShowScanReviewDuplicateGateMatch(first, dismissed)).toBe(false);

    const drifted = projectDraft(
      reviewedAnalysis({
        names: [
          'synth-peanut',
          'synth-bun',
          'synth-tofu',
          'synth-milk',
          'synth-egg-drifted',
        ],
      }),
      'draft-a'
    );
    const second = await gateFor(drifted, [history]);
    expect(second).not.toBeNull();
    expect(second?.matchKind).toBe('MINUTE_SINGLE_NAME_DRIFT_ADVISORY');
    expect(second?.existingReceiptId).toBe('b7-hist');
    expect(second?.evidenceKey).not.toBe(dismissed);
    expect(shouldShowScanReviewDuplicateGateMatch(second, dismissed)).toBe(true);
    expect(saveBarHidden(second)).toBe(true);
  });
});
