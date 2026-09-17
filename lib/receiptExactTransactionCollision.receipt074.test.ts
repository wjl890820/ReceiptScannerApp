/**
 * Receipt074 — duplicate transaction identity must not require product-monetary
 * attribution (unresolved coupon / trusted spend / PPH).
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceiptsForAnalysis: jest.fn(),
  getReceipt: jest.fn(),
}));

import { resolveDiscountOwnership } from './analysisFoundation/discountOwnership';
import { projectTrustedConsumerItemAmount } from './consumerItemMonetaryTruth';
import { parseReceiptDateTime } from './dateParser';
import {
  buildProductPriceHistory,
  buildReceiptEvidenceCache,
} from './productPriceHistory';
import { makeTrustedG3TestRow } from './productPriceHistory.testFixtures';
import { evaluateExactTransactionReceiptCollision } from './receiptExactTransactionCollision';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import { projectReceiptSaveMaterialEvidence } from './receiptSaveProjection';
import {
  buildTransientScanReviewReceipt,
  evaluateScanReviewDuplicateGate,
  type ScanReviewDuplicateGateContext,
} from './scanReviewDuplicateGate';
import {
  indexHighConfidenceDuplicateGroupsByReceiptId,
  selectAnalyticsReceipts,
} from './analyticsReceiptSelection';
import type { ReceiptRow } from './db';

const RECEIPT074_CJK_LATIN = {
  merchant: 'コストコ',
  currency: 'JPY',
  total: 6292,
  tax: 466,
  items: [
    { name: '商品ア', quantity: 1, unitPrice: 998, lineTotal: 998 },
    { name: '商品イ', quantity: 1, unitPrice: 1280, lineTotal: 1280 },
    { name: '商品ウ', quantity: 1, unitPrice: 648, lineTotal: 648 },
    { name: '商品エ', quantity: 1, unitPrice: 1198, lineTotal: 1198 },
    { name: '商品オ', quantity: 1, unitPrice: 890, lineTotal: 890 },
    { name: '商品カ', quantity: 1, unitPrice: 680, lineTotal: 680 },
    { name: 'ケージフリータマゴ 20', quantity: 1, unitPrice: 758, lineTotal: 758 },
    { name: 'CAGE FREE EGG CPN', quantity: 1, unitPrice: -160, lineTotal: -160 },
  ],
};

const TX_2026 = '2026-06-22 19:03:30';
const TX_2024 = '2024-06-22 19:03:30';
const TX_2026_SLASH = '06/22/2026 19:03:30';
const TX_2024_SLASH = '06/22/2024 19:03:30';

function makeReceipt074Row(input: {
  id: string;
  transactionDate: string;
  merchant?: string;
  total?: number;
  currency?: string;
  itemsPatch?: (items: Record<string, unknown>[]) => Record<string, unknown>[];
}): ReceiptRow {
  const normalized = normalizeOcrAnalysis({
    ...RECEIPT074_CJK_LATIN,
    merchant: input.merchant ?? RECEIPT074_CJK_LATIN.merchant,
    total: input.total ?? RECEIPT074_CJK_LATIN.total,
    currency: input.currency ?? 'JPY',
    tax: 466,
    tax_is_known: true,
    transactionDate: input.transactionDate,
  } as any);
  let analysis: Record<string, unknown> = {
    ...normalized,
    merchant: input.merchant ?? 'コストコ',
    transactionDate: input.transactionDate,
    total: input.total ?? 6292,
    tax: 466,
    tax_is_known: true,
    currency: input.currency ?? 'JPY',
  };
  if (input.itemsPatch) {
    analysis = {
      ...analysis,
      items: input.itemsPatch(
        (analysis.items as Record<string, unknown>[]).map((row) => ({ ...row }))
      ),
    };
  }
  const projection = projectReceiptSaveMaterialEvidence({
    analysis: analysis as any,
    reviewedSave: true,
  });
  return {
    id: input.id,
    created_at: 1,
    transaction_at: projection.transactionAt,
    image_uri: `file://${input.id}.jpg`,
    merchant_raw: projection.merchantRaw,
    merchant_normalized: projection.merchantNormalized,
    merchant_type: projection.merchantType,
    total: projection.total,
    tax: projection.tax,
    tax_is_known: projection.taxIsKnown,
    currency: projection.currency,
    analysis_json: JSON.stringify(projection.persistedAnalysis),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    transaction_source: projection.transactionSource,
  };
}

function makeTransientFromAnalysis(
  analysis: Record<string, unknown>,
  transactionDate: string,
  draftId: string
) {
  return buildTransientScanReviewReceipt({
    transientReceiptId: `scan-review:${draftId}`,
    imageUri: 'file://draft.jpg',
    analysis: {
      ...analysis,
      merchant: 'コストコ',
      transactionDate,
      total: 6292,
      tax: 466,
      tax_is_known: true,
      currency: 'JPY',
    } as any,
  });
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

describe('Receipt074 duplicate transaction identity', () => {
  it('Proof A: 2024 draft vs 2026 saved → no duplicate', () => {
    const saved = makeReceipt074Row({ id: 'saved-074', transactionDate: TX_2026 });
    const transient = makeTransientFromAnalysis(
      JSON.parse(saved.analysis_json),
      TX_2024_SLASH,
      'draft-2024'
    )!;
    expect(saved.transaction_at).not.toBe(transient.transaction_at);
    expect(
      evaluateExactTransactionReceiptCollision(transient, saved)
    ).toEqual({ collided: false, reason: 'transaction_time_mismatch' });
    expect(
      evaluateScanReviewDuplicateGate(transient, gateContext([saved]))
    ).toBeNull();
  });

  it('Proof B: corrected 2026 date → duplicate MATCH', () => {
    const saved = makeReceipt074Row({ id: 'saved-074', transactionDate: TX_2026 });
    const transient = makeTransientFromAnalysis(
      JSON.parse(saved.analysis_json),
      TX_2026_SLASH,
      'draft-2026'
    )!;
    expect(saved.transaction_at).toBe(transient.transaction_at);
    const collision = evaluateExactTransactionReceiptCollision(transient, saved);
    expect(collision.collided).toBe(true);
    const gate = evaluateScanReviewDuplicateGate(
      transient,
      gateContext([saved])
    );
    expect(gate?.existingReceiptId).toBe('saved-074');
    expect(gate?.total).toBe(6292);
    expect(gate?.itemCount).toBe(7);
  });

  it('date-edit recheck: 2024 no match → 2026 match (Review gate path)', () => {
    const saved = makeReceipt074Row({ id: 'saved-074', transactionDate: TX_2026 });
    const analysis = JSON.parse(saved.analysis_json);
    const before = makeTransientFromAnalysis(analysis, TX_2024_SLASH, 'd1')!;
    expect(
      evaluateScanReviewDuplicateGate(before, gateContext([saved]))
    ).toBeNull();
    const after = makeTransientFromAnalysis(analysis, TX_2026_SLASH, 'd1')!;
    expect(
      evaluateScanReviewDuplicateGate(after, gateContext([saved]) )
        ?.existingReceiptId
    ).toBe('saved-074');
  });

  it('Proof C+D+E: duplicate MATCH while coupon unresolved, spend null, PPH excluded', () => {
    const saved = makeReceipt074Row({ id: 'saved-074', transactionDate: TX_2026 });
    const draft = makeReceipt074Row({
      id: 'draft-peer',
      transactionDate: TX_2026,
    });
    const analysis = JSON.parse(saved.analysis_json);
    const ownership = resolveDiscountOwnership({
      ocrItems: analysis.items,
      ocrDiscounts: analysis.discounts,
      analysis,
    });
    expect(ownership.status).toBe('unresolved');

    const collision = evaluateExactTransactionReceiptCollision(draft, saved);
    expect(collision.collided).toBe(true);

    const egg = (analysis.items as any[]).find((i) =>
      String(i.name).includes('ケージフリータマゴ')
    )!;
    expect(egg.lineTotal).toBe(758);
    expect(Number(egg.discountAllocated) || 0).toBe(0);
    expect(egg.effectiveLineTotal ?? egg.lineTotal).toBe(758);

    const spend = projectTrustedConsumerItemAmount({
      lineTotal: egg.lineTotal,
      analysisJson: saved.analysis_json,
      receiptTotal: saved.total,
      receiptTax: saved.tax,
      receiptTaxIsKnown: saved.tax_is_known,
      currency: saved.currency,
    });
    expect(spend.trusted).toBe(false);
    expect(spend.amount).toBeNull();

    const eggRow = makeTrustedG3TestRow('r074-dup', {
      receiptId: saved.id,
      occurredAt: saved.transaction_at ?? 1,
      displayName: String(egg.name),
      grossLineAmount: 758,
      lineTotal: 758,
      effectiveLineAmount: 758,
      discountAllocated: 0,
      purchaseQuantity: 1,
      receiptTotal: saved.total,
      receiptTax: saved.tax,
      receiptTaxIsKnown: saved.tax_is_known,
      currency: saved.currency,
      receiptAnalysisJson: saved.analysis_json,
      itemAmountEvidenceState: 'coherent',
    });
    const cache = buildReceiptEvidenceCache([eggRow]);
    expect(
      cache.get(saved.id)!.monetaryCoherenceEvidence.discountOwnershipStatus
    ).toBe('unresolved');
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'egg-074' },
      [eggRow],
      { receiptEvidenceCache: cache }
    );
    expect(history.observations[0]?.level2Eligible).toBe(false);
  });

  it('D1 wrong year → no duplicate', () => {
    const saved = makeReceipt074Row({ id: 's', transactionDate: TX_2026 });
    const draft = makeReceipt074Row({ id: 'd', transactionDate: TX_2024 });
    expect(
      evaluateExactTransactionReceiptCollision(draft, saved).collided
    ).toBe(false);
  });

  it('D2 wrong merchant → no exact duplicate', () => {
    const saved = makeReceipt074Row({ id: 's', transactionDate: TX_2026 });
    const draft = makeReceipt074Row({
      id: 'd',
      transactionDate: TX_2026,
      merchant: 'イオン',
    });
    const result = evaluateExactTransactionReceiptCollision(draft, saved);
    expect(result.collided).toBe(false);
    expect(
      result.collided === false &&
        (result.reason === 'retailer_mismatch' ||
          result.reason === 'retailer_not_exact')
    ).toBe(true);
  });

  it('D3 wrong total → no exact duplicate', () => {
    const saved = makeReceipt074Row({ id: 's', transactionDate: TX_2026 });
    const draft = makeReceipt074Row({
      id: 'd',
      transactionDate: TX_2026,
      total: 7000,
    });
    expect(
      evaluateExactTransactionReceiptCollision(draft, saved)
    ).toEqual({ collided: false, reason: 'total_mismatch' });
  });

  it('D4 different basket → no exact duplicate', () => {
    const saved = makeReceipt074Row({ id: 's', transactionDate: TX_2026 });
    const draft = makeReceipt074Row({
      id: 'd',
      transactionDate: TX_2026,
      itemsPatch: (items) => {
        const next = items.map((row) => ({ ...row }));
        const egg = next.find((row) =>
          String(row.name).includes('ケージフリータマゴ')
        );
        if (egg) egg.lineTotal = 900;
        return next;
      },
    });
    expect(
      evaluateExactTransactionReceiptCollision(draft, saved)
    ).toEqual({ collided: false, reason: 'basket_mismatch' });
  });

  it('D5 different currency → no exact duplicate', () => {
    const saved = makeReceipt074Row({ id: 's', transactionDate: TX_2026 });
    const draft = makeReceipt074Row({
      id: 'd',
      transactionDate: TX_2026,
      currency: 'USD',
    });
    const result = evaluateExactTransactionReceiptCollision(draft, saved);
    expect(result.collided).toBe(false);
    expect(
      result.collided === false &&
        (result.reason === 'currency_mismatch' ||
          result.reason === 'currency_not_supported')
    ).toBe(true);
  });

  it('Proof F: resolved coupon gross≠effective still matches raw peer', () => {
    const unresolvedSaved = makeReceipt074Row({
      id: 'saved-unresolved',
      transactionDate: TX_2026,
    });
    const resolvedDraft = makeReceipt074Row({
      id: 'draft-resolved',
      transactionDate: TX_2026,
      itemsPatch: (items) =>
        items.map((row) => {
          if (!String(row.name).includes('ケージフリータマゴ')) return row;
          return {
            ...row,
            lineTotal: 758,
            line_total: 758,
            effectiveLineTotal: 598,
            discountAllocated: -160,
          };
        }),
    });
    // Align discounts metadata on resolved draft so ownership differs but gross basket matches.
    const analysis = JSON.parse(resolvedDraft.analysis_json);
    analysis.discounts = [
      {
        label: 'CAGE FREE EGG CPN',
        amount: -160,
        ownershipStatus: 'bound',
        boundItemIndex: 6,
        ownershipReason: 'strong_lexical_token_coverage',
      },
    ];
    resolvedDraft.analysis_json = JSON.stringify(analysis);

    const collision = evaluateExactTransactionReceiptCollision(
      resolvedDraft,
      unresolvedSaved
    );
    expect(collision.collided).toBe(true);
    if (collision.collided) {
      expect(collision.itemCount).toBe(7);
    }
  });

  it('slash vs dash date forms parse to identical transaction_at', () => {
    const a = parseReceiptDateTime(TX_2026, {
      fallbackToNow: false,
      merchant: 'コストコ',
    });
    const b = parseReceiptDateTime(TX_2026_SLASH, {
      fallbackToNow: false,
      merchant: 'コストコ',
    });
    expect(a).toBe(b);
  });
});
