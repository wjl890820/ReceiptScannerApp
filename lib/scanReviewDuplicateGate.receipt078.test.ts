/**
 * Receipt078 — generic-merchant duplicate aggregation.
 * Conflicting historical storeHints must not veto a generic draft when a
 * generic (storeHint=null) stored collision exists.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  listReceiptsForAnalysis: jest.fn(),
  getReceipt: jest.fn(),
}));

import {
  buildTransientScanReviewReceipt,
  evaluateScanReviewDuplicateGate,
  type ScanReviewDuplicateGateContext,
} from './scanReviewDuplicateGate';
import {
  indexHighConfidenceDuplicateGroupsByReceiptId,
  selectAnalyticsReceipts,
} from './analyticsReceiptSelection';
import { projectReceiptSaveMaterialEvidence } from './receiptSaveProjection';
import { deriveRetailerIdentity } from './retailerIdentity';
import type { ReceiptRow } from './db';

const BASKET = [
  { name: 'a', quantity: 1, lineTotal: 88 },
  { name: 'b', quantity: 1, lineTotal: 103 },
  { name: 'c', quantity: 1, lineTotal: 103 },
  { name: 'd', quantity: 1, lineTotal: 386 },
];
const TX = '2026-06-30 13:36:00';

function makeStored(
  id: string,
  merchant: string,
  createdAt: number
): ReceiptRow {
  const analysis = {
    merchant,
    transactionDate: TX,
    total: 741,
    tax: 61,
    tax_is_known: true,
    currency: 'JPY',
    items: BASKET,
    discounts: [],
    reconciliation: { ok: true },
    amount_mismatch: false,
  };
  const projection = projectReceiptSaveMaterialEvidence({
    analysis: analysis as any,
    reviewedSave: true,
  });
  return {
    id,
    created_at: createdAt,
    transaction_at: projection.transactionAt,
    transaction_time_precision: projection.transactionTimePrecision,
    image_uri: `file://${id}.jpg`,
    merchant_raw: merchant,
    merchant_normalized: merchant,
    merchant_type: 'supermarket',
    total: 741,
    tax: 61,
    tax_is_known: 1,
    currency: 'JPY',
    analysis_json: JSON.stringify(projection.persistedAnalysis),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    transaction_source: projection.transactionSource,
  };
}

function makeDraft(merchant: string) {
  const analysis = {
    merchant,
    transactionDate: TX,
    total: 741,
    tax: 61,
    tax_is_known: true,
    currency: 'JPY',
    items: BASKET,
    discounts: [],
    reconciliation: { ok: true },
    amount_mismatch: false,
  };
  const transient = buildTransientScanReviewReceipt({
    transientReceiptId: 'scan-review:draft-gyomu',
    imageUri: 'file://draft.jpg',
    analysis: analysis as any,
  });
  if (!transient) throw new Error('transient failed');
  return transient;
}

function gateContext(receipts: ReceiptRow[]): ScanReviewDuplicateGateContext {
  const selection = selectAnalyticsReceipts(receipts);
  return {
    storedReceipts: receipts,
    receiptById: new Map(receipts.map((r) => [r.id, r])),
    highConfidenceGroupByReceiptId: indexHighConfidenceDuplicateGroupsByReceiptId(
      selection.highConfidenceDuplicateGroups
    ),
  };
}

describe('Receipt078 generic merchant duplicate aggregation', () => {
  const generic = () => makeStored('generic', '業務スーパー', 1);
  const furukawa = () => makeStored('furukawa', '業務スーパー古川店', 2);
  const ichiyoshi = () => makeStored('ichiyoshi', '業務スーパー一吉店', 3);

  it('A — generic draft + generic + two conflicting branches → MATCH (prefer generic)', () => {
    const draft = makeDraft('業務スーパー');
    expect(
      deriveRetailerIdentity({
        merchantRaw: draft.merchant_raw,
        merchantNormalized: draft.merchant_normalized,
      }).storeHint
    ).toBeNull();

    const result = evaluateScanReviewDuplicateGate(
      draft,
      gateContext([generic(), furukawa(), ichiyoshi()])
    );
    expect(result).not.toBeNull();
    expect(result?.existingReceiptId).toBe('generic');
    expect(result?.merchantDisplay).toBe('業務スーパー');
    expect(result?.total).toBe(741);
    expect(result?.itemCount).toBe(4);
  });

  it('B — generic draft + two conflicting branches + NO generic → null', () => {
    const result = evaluateScanReviewDuplicateGate(
      makeDraft('業務スーパー'),
      gateContext([furukawa(), ichiyoshi()])
    );
    expect(result).toBeNull();
  });

  it('C — generic draft + generic only → MATCH', () => {
    const result = evaluateScanReviewDuplicateGate(
      makeDraft('業務スーパー'),
      gateContext([generic()])
    );
    expect(result?.existingReceiptId).toBe('generic');
  });

  it('D — generic draft + generic + one branch → MATCH', () => {
    const result = evaluateScanReviewDuplicateGate(
      makeDraft('業務スーパー'),
      gateContext([generic(), furukawa()])
    );
    expect(result?.existingReceiptId).toBe('generic');
  });

  it('E — explicit branch draft vs matching branch (+ generic) → MATCH', () => {
    const result = evaluateScanReviewDuplicateGate(
      makeDraft('業務スーパー古川店'),
      gateContext([generic(), furukawa()])
    );
    expect(result).not.toBeNull();
    // Earliest destination among matches (generic created_at=1 wins sort).
    expect(result?.existingReceiptId).toBe('generic');
  });

  it('E2 — explicit branch draft does not cross-match conflicting branch alone', () => {
    // Pairwise store_hint_conflict: 古川店 draft vs 一吉店 stored → no collide.
    // Only furukawa matches → MATCH (single branch).
    const result = evaluateScanReviewDuplicateGate(
      makeDraft('業務スーパー古川店'),
      gateContext([ichiyoshi(), furukawa()])
    );
    expect(result?.existingReceiptId).toBe('furukawa');
  });

  it('G4 — generic draft + only one branch → MATCH (missing-hint compatibility)', () => {
    const result = evaluateScanReviewDuplicateGate(
      makeDraft('業務スーパー'),
      gateContext([furukawa()])
    );
    expect(result?.existingReceiptId).toBe('furukawa');
  });

  it('destination remaps through resolveStoredDestination when membership points elsewhere', () => {
    const g = generic();
    const f = furukawa();
    const i = ichiyoshi();
    const base = gateContext([g, f, i]);
    const membership = {
      representativeReceiptId: f.id,
      receiptIds: [g.id, f.id],
      confidence: 'STRUCTURAL_EXACT_DUPLICATE' as const,
    };
    const result = evaluateScanReviewDuplicateGate(makeDraft('業務スーパー'), {
      ...base,
      highConfidenceGroupByReceiptId: new Map([
        [g.id, membership],
        [f.id, membership],
      ]),
    });
    // Winning evidence is still the generic collision; destination may remap.
    expect(result).not.toBeNull();
    expect(result?.existingReceiptId).toBe('furukawa');
    expect(result?.merchantDisplay).toBe('業務スーパー古川店');
  });
});
