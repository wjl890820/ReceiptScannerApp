import { projectReceiptSaveMaterialEvidence } from './receiptSaveProjection';
import { buildTransientScanReviewReceipt } from './scanReviewDuplicateGate';
import { YORK_COLLISION_BASKET } from './receiptExactTransactionCollision.testFixtures';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  listReceiptsForAnalysis: jest.fn(),
  getReceipt: jest.fn(),
}));

describe('receiptSaveProjection', () => {
  it('gives persisted save and transient collision evidence the same material truth', () => {
    const analysis = {
      merchant: 'ヨークベニマル古川南店',
      transactionDate: '2026-06-30 12:55',
      total: 4102,
      tax: 303,
      tax_is_known: true,
      currency: 'JPY',
      items: YORK_COLLISION_BASKET.map(([quantity, lineTotal], index) => ({
        name: `OCR ${index}`,
        quantity,
        lineTotal,
        unitPrice: lineTotal / quantity,
      })),
      reconciliation: { ok: true },
      amount_mismatch: false,
      discounts: [],
    };
    const saveProjection = projectReceiptSaveMaterialEvidence({
      analysis,
      reviewedSave: true,
    });
    const transient = buildTransientScanReviewReceipt({
      transientReceiptId: 'scan-review:draft',
      imageUri: 'file://draft',
      analysis,
    });
    expect(transient).not.toBeNull();
    expect({
      merchantRaw: transient?.merchant_raw,
      merchantNormalized: transient?.merchant_normalized,
      merchantType: transient?.merchant_type,
      transactionAt: transient?.transaction_at,
      transactionSource: transient?.transaction_source,
      total: transient?.total,
      tax: transient?.tax,
      taxIsKnown: transient?.tax_is_known,
      currency: transient?.currency,
      items: JSON.parse(transient?.analysis_json ?? '{}').items,
    }).toEqual({
      merchantRaw: saveProjection.merchantRaw,
      merchantNormalized: saveProjection.merchantNormalized,
      merchantType: saveProjection.merchantType,
      transactionAt: saveProjection.transactionAt,
      transactionSource: saveProjection.transactionSource,
      total: saveProjection.total,
      tax: saveProjection.tax,
      taxIsKnown: saveProjection.taxIsKnown,
      currency: saveProjection.currency,
      items: saveProjection.items,
    });
  });

  it('never falls back to scan time for a missing or invalid purchase time', () => {
    const base = {
      merchant: 'ヨークベニマル',
      total: 100,
      tax: 10,
      tax_is_known: true,
      currency: 'JPY',
      items: [{ name: 'Milk', quantity: 1, lineTotal: 100, unitPrice: 100 }],
    };
    expect(
      projectReceiptSaveMaterialEvidence({ analysis: base, reviewedSave: true })
        .transactionAt
    ).toBeNull();
    expect(
      projectReceiptSaveMaterialEvidence({
        analysis: { ...base, transactionDate: 'not-a-date' },
        reviewedSave: true,
      }).transactionAt
    ).toBeNull();
  });

  it('preserves saveReceipt fallback ordering when an earlier date field is empty', () => {
    const result = projectReceiptSaveMaterialEvidence({
      analysis: {
        merchant: 'ヨークベニマル',
        transactionDate: '',
        transactionAt: '2026-06-30 12:55',
        total: 100,
        tax: 10,
        tax_is_known: true,
        currency: 'JPY',
        items: [
          { name: 'Milk', quantity: 1, lineTotal: 100, unitPrice: 100 },
        ],
      },
      reviewedSave: true,
    });
    expect(result.transactionAt).toBe(1_782_791_700_000);
  });
});
