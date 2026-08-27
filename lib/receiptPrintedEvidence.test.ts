/**
 * G1-1 — Printed evidence capture regression tests.
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

import type { ReceiptAnalysis } from './receiptAnalyzer';
import {
  buildDirectGeminiReceiptAnalysisFromParsed,
  convertEdgeOcrAnalysisResponse,
} from './receiptOcrEdgeConversion';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import {
  EVIDENCE_CAPTURE_VERSION,
  mergeReviewSnapshotPreservingEvidence,
  sanitizeEvidenceCaptureVersion,
  sanitizeMerchantProductCode,
  sanitizePrintedIdentifiers,
  sanitizePromoMarkers,
  stampEvidenceCaptureVersion,
} from './receiptPrintedEvidence';

function baseAnalysis(overrides: Partial<ReceiptAnalysis> = {}): ReceiptAnalysis {
  return {
    merchant: 'テスト',
    items: [{ name: '商品A', quantity: 1, unitPrice: 100, lineTotal: 100 }],
    total: 100,
    tax: null,
    currency: 'JPY',
    ...overrides,
  };
}

describe('G1-1 printed evidence sanitizers', () => {
  test('A — merchant product code preserves leading zeros', () => {
    expect(sanitizeMerchantProductCode('0069158')).toBe('0069158');
    const out = normalizeOcrAnalysis(
      baseAnalysis({
        items: [
          {
            name: 'Costco item',
            quantity: 1,
            unitPrice: 1000,
            lineTotal: 1000,
            merchantProductCode: '0069158',
          },
        ],
        total: 1000,
        evidenceCaptureVersion: stampEvidenceCaptureVersion(),
      })
    );
    expect(out.items[0]!.merchantProductCode).toBe('0069158');
  });

  test('B — numeric merchantProductCode is dropped (fail closed)', () => {
    expect(sanitizeMerchantProductCode(69158 as unknown as string)).toBeUndefined();
    const out = normalizeOcrAnalysis(
      baseAnalysis({
        items: [
          {
            name: 'Bad code',
            quantity: 1,
            unitPrice: 100,
            lineTotal: 100,
            merchantProductCode: 69158 as unknown as string,
          },
        ],
      })
    );
    expect(out.items[0]!.merchantProductCode).toBeUndefined();
  });

  test('C — promo markers trim + dedupe', () => {
    expect(sanitizePromoMarkers(['特', ' 特 ', '特', '', '特価'])).toEqual(['特', '特価']);
  });

  test('D — no promo inference from discount allocation', () => {
    const out = normalizeOcrAnalysis(
      baseAnalysis({
        items: [
          {
            name: '鶏肉',
            quantity: 1,
            unitPrice: 1000,
            lineTotal: 1000,
            effectiveLineTotal: 900,
            discountAllocated: -100,
          },
        ],
        total: 900,
        discounts: [{ label: '値引', amount: -100 }],
      })
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.promoMarkers).toBeUndefined();
  });

  test('E — printed identifiers preserved exactly', () => {
    const out = normalizeOcrAnalysis(
      baseAnalysis({
        printedIdentifiers: {
          transactionId: '000123',
          receiptNumber: '000045',
          registerId: '007',
        },
        evidenceCaptureVersion: stampEvidenceCaptureVersion(),
      })
    );
    expect(out.printedIdentifiers).toEqual({
      transactionId: '000123',
      receiptNumber: '000045',
      registerId: '007',
    });
  });

  test('F — invalid printed identifiers dropped without coercion', () => {
    expect(
      sanitizePrintedIdentifiers({
        transactionId: 123,
        receiptNumber: '',
        registerId: { bad: true },
      })
    ).toBeUndefined();
    expect(
      sanitizePrintedIdentifiers({
        transactionId: ' 000123 ',
        receiptNumber: null,
        registerId: undefined,
      })
    ).toEqual({ transactionId: '000123' });
  });

  test('G — removed discount line evidence does not leak to merchandise row', () => {
    const out = normalizeOcrAnalysis(
      baseAnalysis({
        items: [
          {
            name: '商品A',
            quantity: 1,
            unitPrice: 100,
            lineTotal: 100,
          },
          {
            name: '値引',
            quantity: 1,
            unitPrice: 0,
            lineTotal: -10,
            merchantProductCode: 'SHOULD-NOT-LEAK',
            promoMarkers: ['特'],
          },
        ],
        total: 90,
      })
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.merchantProductCode).toBeUndefined();
    expect(out.items[0]!.promoMarkers).toBeUndefined();
  });

  test('H — evidenceCaptureVersion survives normalization when stamped', () => {
    const out = normalizeOcrAnalysis(
      baseAnalysis({
        evidenceCaptureVersion: EVIDENCE_CAPTURE_VERSION,
      })
    );
    expect(out.evidenceCaptureVersion).toBe(1);
    expect(sanitizeEvidenceCaptureVersion(2)).toBeUndefined();
  });

  test('J — production review merge helper preserves evidence', () => {
    const snapshotItem0 = {
      name: 'Costco item',
      quantity: 1,
      unitPrice: 1000,
      lineTotal: 1000,
      category: 'uncategorized',
      merchantProductCode: '0069158',
      promoMarkers: ['特'],
    };
    const snapshotItem1 = {
      name: 'Other item',
      quantity: 1,
      unitPrice: 200,
      lineTotal: 200,
      merchantProductCode: 'ROW-ONE',
      promoMarkers: ['特価'],
    };
    const savedItem0 = mergeReviewSnapshotPreservingEvidence(snapshotItem0, {
      name: 'Costco item',
      category: 'food_ingredients',
      quantity: 1,
      lineTotal: 1000,
    });
    expect(savedItem0.merchantProductCode).toBe('0069158');
    expect(savedItem0.promoMarkers).toEqual(['特']);
    expect(savedItem0.category).toBe('food_ingredients');

    const userAdded = mergeReviewSnapshotPreservingEvidence({}, {
      name: 'Manual',
      category: 'food_ingredients',
      quantity: 1,
      lineTotal: 50,
    });
    expect(userAdded.merchantProductCode).toBeUndefined();
    expect(userAdded.promoMarkers).toBeUndefined();

    const remainingAfterDelete = mergeReviewSnapshotPreservingEvidence(snapshotItem1, {
      name: 'Other item',
      category: 'food_ingredients',
      quantity: 1,
      lineTotal: 200,
    });
    expect(remainingAfterDelete.merchantProductCode).toBe('ROW-ONE');
    expect(remainingAfterDelete.promoMarkers).toEqual(['特価']);

    const snapshot = {
      merchant: 'コストコ',
      total: 1000,
      tax: null,
      currency: 'JPY',
      printedIdentifiers: {
        transactionId: '000123',
        receiptNumber: '000045',
        registerId: '007',
      },
      evidenceCaptureVersion: 1,
      items: [snapshotItem0, snapshotItem1],
    };
    const savedAnalysis = mergeReviewSnapshotPreservingEvidence(snapshot, {
      items: [savedItem0, remainingAfterDelete],
    });
    expect(savedAnalysis.printedIdentifiers).toEqual(snapshot.printedIdentifiers);
    expect(savedAnalysis.evidenceCaptureVersion).toBe(1);
    expect(savedAnalysis.total).toBe(1000);
    expect((savedAnalysis.items as Record<string, unknown>[])[0]!.merchantProductCode).toBe(
      '0069158'
    );
  });
});

describe('G1-1 normalizeOcrAnalysis root fail-closed', () => {
  test('A — invalid numeric transactionId is dropped', () => {
    const out = normalizeOcrAnalysis(
      baseAnalysis({
        printedIdentifiers: { transactionId: 123 as unknown as string },
      })
    );
    expect(out.printedIdentifiers).toBeUndefined();
  });

  test('B — partial invalid printedIdentifiers sanitized', () => {
    const out = normalizeOcrAnalysis(
      baseAnalysis({
        printedIdentifiers: {
          transactionId: '000123',
          receiptNumber: 45 as unknown as string,
          registerId: '007',
        },
      })
    );
    expect(out.printedIdentifiers).toEqual({
      transactionId: '000123',
      registerId: '007',
    });
  });

  test('C — evidenceCaptureVersion 2 is dropped', () => {
    const out = normalizeOcrAnalysis(
      baseAnalysis({
        evidenceCaptureVersion: 2 as unknown as 1,
      })
    );
    expect(out.evidenceCaptureVersion).toBeUndefined();
  });

  test('D — legacy input without version stays unstamped', () => {
    const out = normalizeOcrAnalysis(baseAnalysis());
    expect(out.evidenceCaptureVersion).toBeUndefined();
  });

  test('E — valid version 1 survives', () => {
    const out = normalizeOcrAnalysis(
      baseAnalysis({
        evidenceCaptureVersion: 1,
        printedIdentifiers: { registerId: '007' },
      })
    );
    expect(out.evidenceCaptureVersion).toBe(1);
    expect(out.printedIdentifiers).toEqual({ registerId: '007' });
  });
});

describe('G1-1 Edge conversion evidenceCaptureVersion policy', () => {
  const legacyEdge = {
    merchant: 'セブン',
    items: [{ name: 'A', quantity: 1, unitPrice: 100, lineTotal: 100 }],
    total: 100,
    tax: null,
    currency: 'JPY',
  };

  test('1 — Edge analysis with valid version 1 preserves it', () => {
    const out = convertEdgeOcrAnalysisResponse({
      ...legacyEdge,
      evidenceCaptureVersion: 1,
    });
    expect(out.evidenceCaptureVersion).toBe(1);
  });

  test('2 — Edge analysis with no version remains unstamped', () => {
    expect(convertEdgeOcrAnalysisResponse(legacyEdge).evidenceCaptureVersion).toBeUndefined();
  });

  test('3 — Edge analysis with version 2 remains unstamped', () => {
    expect(
      convertEdgeOcrAnalysisResponse({
        ...legacyEdge,
        evidenceCaptureVersion: 2,
      }).evidenceCaptureVersion
    ).toBeUndefined();
  });

  test('4 — legacy/fallback-shaped response remains unstamped', () => {
    expect(
      convertEdgeOcrAnalysisResponse({
        merchant: 'イオン',
        items: [],
        total: 0,
        tax: 0,
        currency: '¥',
      }).evidenceCaptureVersion
    ).toBeUndefined();
  });

  test('5 — direct Gemini path system-stamps version 1', () => {
    expect(
      buildDirectGeminiReceiptAnalysisFromParsed(legacyEdge).evidenceCaptureVersion
    ).toBe(1);
  });

  test('6 — cache-hit shaped v11 analysis preserves evidence via Edge conversion', () => {
    const cached = {
      merchant: 'コストコ',
      items: [
        {
          name: 'A',
          quantity: 1,
          unitPrice: 100,
          lineTotal: 100,
          merchantProductCode: '0069158',
          promoMarkers: ['特'],
        },
      ],
      total: 100,
      tax: null,
      currency: 'JPY',
      printedIdentifiers: {
        transactionId: '000123',
        receiptNumber: '000045',
        registerId: '007',
      },
      evidenceCaptureVersion: 1,
    };
    const out = convertEdgeOcrAnalysisResponse(cached);
    expect(out.evidenceCaptureVersion).toBe(1);
    expect(out.printedIdentifiers).toEqual(cached.printedIdentifiers);
    expect(out.items[0]!.merchantProductCode).toBe('0069158');
    expect(out.items[0]!.promoMarkers).toEqual(['特']);
  });
});

describe('G1-1 monetary normalization unchanged (I regression spot-check)', () => {
  test('discount/tax/total reconciliation still works with evidence present', () => {
    const out = normalizeOcrAnalysis(
      baseAnalysis({
        items: [
          {
            name: 'A',
            quantity: 1,
            unitPrice: 100,
            lineTotal: 100,
            merchantProductCode: '001',
            promoMarkers: ['特価'],
          },
          { name: '値引', quantity: 1, unitPrice: 0, lineTotal: -10 },
        ],
        tax: 0,
        total: 90,
        evidenceCaptureVersion: 1,
        printedIdentifiers: { registerId: '01' },
      })
    );
    expect(out.total).toBe(90);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.merchantProductCode).toBe('001');
    expect(out.reconciliation?.ok).toBe(true);
  });
});
