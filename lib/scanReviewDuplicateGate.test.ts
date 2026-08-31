/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  listReceiptsForAnalysis: jest.fn(),
  getReceipt: jest.fn(),
}));

import {
  buildTransientScanReviewReceipt,
  dismissScanReviewDuplicateEvidence,
  evaluateScanReviewDuplicateGate,
  loadScanReviewDuplicateGateContext,
  revalidateScanReviewDuplicateDestination,
  shouldApplyScanReviewDuplicateGateUpdate,
  shouldShowScanReviewDuplicateGateMatch,
  type ScanReviewDuplicateGateContext,
} from './scanReviewDuplicateGate';
import {
  cloneCollisionReceipt,
  makeYorkCollisionReceiptA,
  makeYorkCollisionReceiptB,
  makeYorkCollisionReceiptC,
} from './receiptExactTransactionCollision.testFixtures';
import {
  indexHighConfidenceDuplicateGroupsByReceiptId,
  selectAnalyticsReceipts,
} from './analyticsReceiptSelection';
import type { ReceiptRow } from './db';

function context(receipts: ReceiptRow[]): ScanReviewDuplicateGateContext {
  const selection = selectAnalyticsReceipts(receipts);
  return {
    storedReceipts: receipts,
    receiptById: new Map(receipts.map((receipt) => [receipt.id, receipt])),
    highConfidenceGroupByReceiptId:
      indexHighConfidenceDuplicateGroupsByReceiptId(
        selection.highConfidenceDuplicateGroups
      ),
  };
}

function transientYorkC() {
  const yorkC = makeYorkCollisionReceiptC();
  const parsed = JSON.parse(yorkC.analysis_json);
  const transient = buildTransientScanReviewReceipt({
    transientReceiptId: 'scan-review:draft-1',
    imageUri: 'file://draft.jpg',
    analysis: {
      ...parsed,
      merchant: yorkC.merchant_raw,
      transactionDate: '2026-06-30 12:55',
      total: 4102,
      tax: 303,
      tax_is_known: true,
      currency: 'JPY',
    },
  });
  if (!transient) throw new Error('transient fixture failed');
  return transient;
}

describe('scanReviewDuplicateGate', () => {
  it('returns a deterministic persisted York destination and never the transient ID', () => {
    const a = cloneCollisionReceipt(makeYorkCollisionReceiptA(), { created_at: 1 });
    const b = cloneCollisionReceipt(makeYorkCollisionReceiptB(), { created_at: 2 });
    const result = evaluateScanReviewDuplicateGate(
      transientYorkC(),
      context([b, a])
    );
    expect(result?.existingReceiptId).toBe(a.id);
    expect(result?.existingReceiptId).not.toBe('scan-review:draft-1');
    expect(result?.itemCount).toBe(19);
  });

  it('routes an excluded stored match to its existing representative', () => {
    const a = cloneCollisionReceipt(makeYorkCollisionReceiptA(), { created_at: 2 });
    const b = cloneCollisionReceipt(makeYorkCollisionReceiptB(), { created_at: 1 });
    const base = context([a, b]);
    const membership = {
      representativeReceiptId: a.id,
      receiptIds: [a.id, b.id],
      confidence: 'STRUCTURAL_EXACT_DUPLICATE' as const,
    };
    const result = evaluateScanReviewDuplicateGate(transientYorkC(), {
      ...base,
      highConfidenceGroupByReceiptId: new Map([
        [a.id, membership],
        [b.id, membership],
      ]),
    });
    expect(result?.existingReceiptId).toBe(a.id);
  });

  it('fails closed when multiple matching stored observations have conflicting branch hints', () => {
    const otherBranch = cloneCollisionReceipt(makeYorkCollisionReceiptB(), {
      id: 'york-other-branch',
      merchant_raw: 'ヨークベニマル 泉店',
      merchant_normalized: 'ヨークベニマル 泉店',
    });
    const transientWithoutHint = cloneCollisionReceipt(makeYorkCollisionReceiptA(), {
      id: 'scan-review:draft-2',
    });
    expect(
      evaluateScanReviewDuplicateGate(
        transientWithoutHint,
        context([makeYorkCollisionReceiptB(), otherBranch])
      )
    ).toBeNull();
  });

  it('loads exhaustive owner receipts once and constructs selection context once', async () => {
    const yorkA = makeYorkCollisionReceiptA();
    const listOwnerReceipts = jest.fn(async () => [yorkA]);
    const loaded = await loadScanReviewDuplicateGateContext({ listOwnerReceipts });
    expect(listOwnerReceipts).toHaveBeenCalledTimes(1);
    expect(loaded?.storedReceipts.map((receipt) => receipt.id)).toEqual([
      yorkA.id,
    ]);
  });

  it('fails closed when owner-scoped inventory cannot be loaded', async () => {
    const loaded = await loadScanReviewDuplicateGateContext({
      listOwnerReceipts: jest.fn(async () => {
        throw new Error('owner unavailable');
      }),
    });
    expect(loaded).toBeNull();
  });

  it('cannot match a foreign receipt that is absent from the owner-scoped H2 universe', async () => {
    const ownerAReceipt = cloneCollisionReceipt(makeYorkCollisionReceiptA(), {
      id: 'owner-a-unrelated',
      transaction_at: 1_782_791_700_000 - 60_000,
      user_id: 'owner-a',
    });
    const foreignMatchingReceipt = cloneCollisionReceipt(
      makeYorkCollisionReceiptB(),
      { id: 'owner-b-match', user_id: 'owner-b' }
    );
    const listOwnerReceipts = jest.fn(async () => [ownerAReceipt]);
    const loaded = await loadScanReviewDuplicateGateContext({ listOwnerReceipts });
    expect(loaded).not.toBeNull();
    expect(loaded?.receiptById.has(foreignMatchingReceipt.id)).toBe(false);
    expect(evaluateScanReviewDuplicateGate(transientYorkC(), loaded!)).toBeNull();
    expect(listOwnerReceipts).toHaveBeenCalledTimes(1);
  });

  it('revalidates the current-owner destination before navigation', async () => {
    const yorkA = makeYorkCollisionReceiptA();
    const getOwnerReceipt = jest.fn(async (id: string) =>
      id === yorkA.id ? yorkA : null
    );
    await expect(
      revalidateScanReviewDuplicateDestination(yorkA.id, {
        getOwnerReceipt,
      })
    ).resolves.toBe(true);
    await expect(
      revalidateScanReviewDuplicateDestination('foreign', { getOwnerReceipt })
    ).resolves.toBe(false);
  });

  it('guards stale drafts, generations, and unmounted updates', () => {
    const base = {
      mounted: true,
      capturedGeneration: 2,
      currentGeneration: 2,
      capturedDraftId: 'draft-b',
      currentDraftId: 'draft-b',
    };
    expect(shouldApplyScanReviewDuplicateGateUpdate(base)).toBe(true);
    expect(
      shouldApplyScanReviewDuplicateGateUpdate({
        ...base,
        capturedGeneration: 1,
      })
    ).toBe(false);
    expect(
      shouldApplyScanReviewDuplicateGateUpdate({
        ...base,
        capturedDraftId: 'draft-a',
      })
    ).toBe(false);
    expect(
      shouldApplyScanReviewDuplicateGateUpdate({ ...base, mounted: false })
    ).toBe(false);
  });

  it('Continue Review remains dismissed when an equivalent York destination changes', () => {
    const first = evaluateScanReviewDuplicateGate(
      transientYorkC(),
      context([makeYorkCollisionReceiptA()])
    );
    expect(first).not.toBeNull();
    const dismissed = dismissScanReviewDuplicateEvidence(first!);
    expect(shouldShowScanReviewDuplicateGateMatch(first, dismissed)).toBe(false);

    const otherEvidence = evaluateScanReviewDuplicateGate(
      transientYorkC(),
      context([makeYorkCollisionReceiptB()])
    );
    expect(otherEvidence).not.toBeNull();
    expect(otherEvidence?.existingReceiptId).not.toBe(first?.existingReceiptId);
    expect(otherEvidence?.evidenceKey).toBe(dismissed);
    expect(
      shouldShowScanReviewDuplicateGateMatch(otherEvidence, dismissed)
    ).toBe(false);
  });

  it('allows a materially changed collision to be evaluated after dismissal', () => {
    const first = evaluateScanReviewDuplicateGate(
      transientYorkC(),
      context([makeYorkCollisionReceiptA()])
    );
    expect(first).not.toBeNull();
    const dismissed = dismissScanReviewDuplicateEvidence(first!);

    const changedTransient = cloneCollisionReceipt(transientYorkC(), {
      transaction_at: transientYorkC().transaction_at! + 60_000,
    });
    const changedStored = cloneCollisionReceipt(makeYorkCollisionReceiptA(), {
      transaction_at: makeYorkCollisionReceiptA().transaction_at! + 60_000,
    });
    const changed = evaluateScanReviewDuplicateGate(
      changedTransient,
      context([changedStored])
    );
    expect(changed).not.toBeNull();
    expect(changed?.evidenceKey).not.toBe(dismissed);
    expect(shouldShowScanReviewDuplicateGateMatch(changed, dismissed)).toBe(true);
  });
});
