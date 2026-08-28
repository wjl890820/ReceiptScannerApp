import {
  applyUserLineAmountEdit,
  isStaleEffectiveAfterUserLineEdit,
} from './receiptDiscountAllocation';
import {
  buildPriceObservationTruth,
  parseReceiptEvidenceCaptureVersion,
  PRICE_OBSERVATION_VERSION,
} from './priceObservationTruth';

describe('G3-1 buildPriceObservationTruth', () => {
  it('CASE 1 — ordinary observation with capture version 1', () => {
    const truth = buildPriceObservationTruth({
      item: { lineTotal: 439, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(truth.version).toBe(PRICE_OBSERVATION_VERSION);
    expect(truth.grossLineAmount).toBe(439);
    expect(truth.effectiveLineAmount).toBe(439);
    expect(truth.selectedLineAmount).toBe(439);
    expect(truth.grossUnitPrice).toBe(439);
    expect(truth.effectiveUnitPrice).toBe(439);
    expect(truth.discountAllocated).toBeNull();
    expect(truth.promoContext).toBe('none_observed');
    expect(truth.amountState).toBe('coherent');
    expect(truth.amountProvenance).toBe('ocr_observed');
  });

  it('CASE 2 — explicit product-bound discount tuple', () => {
    const truth = buildPriceObservationTruth({
      item: {
        lineTotal: 439,
        discountAllocated: -51,
        effectiveLineTotal: 388,
        quantity: 1,
      },
      evidenceCaptureVersion: 1,
    });
    expect(truth.grossLineAmount).toBe(439);
    expect(truth.discountAllocated).toBe(-51);
    expect(truth.effectiveLineAmount).toBe(388);
    expect(truth.selectedLineAmount).toBe(388);
    expect(truth.promoContext).toBe('explicit_discount');
    expect(truth.amountState).toBe('coherent');
  });

  it('CASE 3 — qualitative marker only', () => {
    const truth = buildPriceObservationTruth({
      item: {
        lineTotal: 388,
        effectiveLineTotal: 388,
        promoMarkers: ['特'],
        quantity: 1,
      },
      evidenceCaptureVersion: 1,
    });
    expect(truth.promoMarkers).toEqual(['特']);
    expect(truth.promoContext).toBe('qualitative_marker');
    expect(truth.discountAllocated).toBeNull();
    expect(truth.grossLineAmount).toBe(388);
  });

  it('CASE 4 — promotion ended preserves distinct tuples', () => {
    const ended = buildPriceObservationTruth({
      item: {
        lineTotal: 439,
        discountAllocated: -33,
        effectiveLineTotal: 406,
        quantity: 1,
      },
      evidenceCaptureVersion: 1,
    });
    const noPromo = buildPriceObservationTruth({
      item: { lineTotal: 439, effectiveLineTotal: 439, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(ended.effectiveLineAmount).toBe(406);
    expect(ended.discountAllocated).toBe(-33);
    expect(noPromo.effectiveLineAmount).toBe(439);
    expect(noPromo.discountAllocated).toBeNull();
    expect(noPromo.promoContext).toBe('none_observed');
  });

  it('CASE 5 — different gross observations preserved distinctly', () => {
    const a = buildPriceObservationTruth({
      item: { lineTotal: 397, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    const b = buildPriceObservationTruth({
      item: { lineTotal: 298, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(a.grossLineAmount).toBe(397);
    expect(b.grossLineAmount).toBe(298);
  });

  it('CASE 6 — quantity-normalized unit prices', () => {
    const five = buildPriceObservationTruth({
      item: { lineTotal: 525, quantity: 5 },
      evidenceCaptureVersion: 1,
    });
    const four = buildPriceObservationTruth({
      item: { lineTotal: 508, quantity: 4 },
      evidenceCaptureVersion: 1,
    });
    expect(five.grossUnitPrice).toBe(105);
    expect(four.grossUnitPrice).toBe(127);
  });

  it('CASE 7 — does not infer receipt-level coupon onto item', () => {
    const truth = buildPriceObservationTruth({
      item: { lineTotal: 439, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(truth.discountAllocated).toBeNull();
    expect(truth.grossLineAmount).toBe(439);
  });

  it('CASE 8 — explicit user amount edit', () => {
    const edited = applyUserLineAmountEdit(
      {
        name: 'Item',
        lineTotal: 439,
        line_total: 439,
        effectiveLineTotal: 388,
        discountAllocated: -51,
        quantity: 1,
      },
      388
    );
    const truth = buildPriceObservationTruth({
      item: edited as Record<string, unknown>,
      evidenceCaptureVersion: 1,
    });
    expect(truth.selectedLineAmount).toBe(388);
    expect(truth.effectiveLineAmount).toBe(388);
    expect(truth.grossLineAmount).toBeNull();
    expect(truth.discountAllocated).toBeNull();
    expect(truth.amountProvenance).toBe('user_corrected');
    expect(truth.amountState).toBe('selected_only');
  });

  it('CASE 9 — legacy stale alias edit uses shared detector', () => {
    const stale = {
      name: '麦茶',
      lineTotal: 70,
      line_total: 69,
      effectiveLineTotal: 69,
      quantity: 1,
    };
    expect(isStaleEffectiveAfterUserLineEdit(stale)).toBe(true);
    const truth = buildPriceObservationTruth({
      item: stale,
      evidenceCaptureVersion: 1,
    });
    expect(truth.selectedLineAmount).toBe(70);
    expect(truth.effectiveLineAmount).toBe(70);
    expect(truth.grossLineAmount).toBeNull();
    expect(truth.discountAllocated).toBeNull();
    expect(truth.amountProvenance).toBe('legacy_user_override');
    expect(truth.amountState).toBe('selected_only');
  });

  it('CASE 10 — legacy capture absence uses promoContext unknown', () => {
    const truth = buildPriceObservationTruth({
      item: { lineTotal: 439, quantity: 1 },
      evidenceCaptureVersion: null,
    });
    expect(truth.promoContext).toBe('unknown');
    expect(truth.evidenceCaptureVersion).toBeNull();
  });

  it('derives effective from gross + discount when effective missing', () => {
    const truth = buildPriceObservationTruth({
      item: { lineTotal: 439, discountAllocated: -51, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(truth.effectiveLineAmount).toBe(388);
    expect(truth.amountState).toBe('coherent');
  });

  it('marks conflicting discount tuple as conflict', () => {
    const truth = buildPriceObservationTruth({
      item: {
        lineTotal: 439,
        discountAllocated: -51,
        effectiveLineTotal: 400,
        quantity: 1,
      },
      evidenceCaptureVersion: 1,
    });
    expect(truth.amountState).toBe('conflict');
    expect(truth.grossLineAmount).toBe(439);
    expect(truth.effectiveLineAmount).toBe(400);
  });

  it('parseReceiptEvidenceCaptureVersion preserves only numeric literal 1', () => {
    expect(
      parseReceiptEvidenceCaptureVersion(
        JSON.stringify({ evidenceCaptureVersion: 1 })
      )
    ).toBe(1);
    expect(
      parseReceiptEvidenceCaptureVersion(
        JSON.stringify({ evidenceCaptureVersion: '1' })
      )
    ).toBeNull();
    expect(parseReceiptEvidenceCaptureVersion('{')).toBeNull();
  });
});

describe('G3-1 adversarial price observation truth', () => {
  const invalidLineTotals: unknown[] = [
    null,
    true,
    '439',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
  ];

  it.each(invalidLineTotals)(
    '4A — rejects coerced lineTotal %p as authoritative amount',
    (lineTotal) => {
      const truth = buildPriceObservationTruth({
        item: { lineTotal, quantity: 1 },
        evidenceCaptureVersion: 1,
      });
      expect(truth.amountState).not.toBe('coherent');
      expect(truth.selectedLineAmount).not.toBe(0);
      expect(truth.selectedLineAmount).not.toBe(1);
      expect(truth.selectedLineAmount).not.toBe(439);
      expect(truth.grossLineAmount).not.toBe(439);
    }
  );

  it('4B — alias numeric conflict becomes amountState conflict', () => {
    const truth = buildPriceObservationTruth({
      item: { lineTotal: 439, line_total: 500, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(truth.amountState).toBe('conflict');
    expect(truth.grossLineAmount).toBeNull();
  });

  it('4B — malformed-present snake alias conflicts with valid camel alias', () => {
    const truth = buildPriceObservationTruth({
      item: { lineTotal: 439, line_total: '439', quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(truth.amountState).toBe('conflict');
    expect(truth.grossLineAmount).toBeNull();
  });

  it('4C — positive discountAllocated is invalid and conflicts', () => {
    const truth = buildPriceObservationTruth({
      item: { lineTotal: 439, discountAllocated: 51, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(truth.amountState).toBe('conflict');
    expect(truth.promoContext).toBe('unknown');
    expect(truth.promoContext).not.toBe('none_observed');
    expect(truth.promoContext).not.toBe('explicit_discount');
  });

  it('4D — unexplained gross/effective gap without discount conflicts', () => {
    const missingDiscount = buildPriceObservationTruth({
      item: { lineTotal: 439, effectiveLineTotal: 388, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    const zeroDiscount = buildPriceObservationTruth({
      item: {
        lineTotal: 439,
        discountAllocated: 0,
        effectiveLineTotal: 388,
        quantity: 1,
      },
      evidenceCaptureVersion: 1,
    });
    expect(missingDiscount.amountState).toBe('conflict');
    expect(zeroDiscount.amountState).toBe('conflict');
  });

  it('4E — valid explicit discount tuple remains coherent', () => {
    const truth = buildPriceObservationTruth({
      item: {
        lineTotal: 439,
        discountAllocated: -51,
        effectiveLineTotal: 388,
        quantity: 1,
      },
      evidenceCaptureVersion: 1,
    });
    expect(truth.amountState).toBe('coherent');
    expect(truth.promoContext).toBe('explicit_discount');
    expect(truth.effectiveLineAmount).toBe(388);
  });

  it('4F — user_added row with capture v1 uses promoContext unknown', () => {
    const truth = buildPriceObservationTruth({
      item: { user_added: true, lineTotal: 300, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(truth.evidenceCaptureVersion).toBe(1);
    expect(truth.promoContext).toBe('unknown');
    expect(truth.promoContext).not.toBe('none_observed');
  });

  it('4G — OCR-derived row with capture v1 still uses none_observed', () => {
    const truth = buildPriceObservationTruth({
      item: { lineTotal: 439, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(truth.promoContext).toBe('none_observed');
  });
});

describe('G3-1 legacy override and invalid-discount promo regressions', () => {
  it('TEST A — malformed alias cannot become legacy override', () => {
    const truth = buildPriceObservationTruth({
      item: {
        lineTotal: 439,
        line_total: '388',
        effectiveLineTotal: 388,
        quantity: 1,
      },
      evidenceCaptureVersion: 1,
    });
    expect(truth.amountState).toBe('conflict');
    expect(truth.amountProvenance).not.toBe('legacy_user_override');
    expect(truth.grossLineAmount).toBeNull();
  });

  it('TEST B — valid numeric legacy stale alias still works', () => {
    const stale = {
      name: '麦茶',
      lineTotal: 70,
      line_total: 69,
      effectiveLineTotal: 69,
      quantity: 1,
    };
    expect(isStaleEffectiveAfterUserLineEdit(stale)).toBe(true);
    const truth = buildPriceObservationTruth({
      item: stale,
      evidenceCaptureVersion: 1,
    });
    expect(truth.amountProvenance).toBe('legacy_user_override');
    expect(truth.amountState).toBe('selected_only');
    expect(truth.selectedLineAmount).toBe(70);
    expect(truth.effectiveLineAmount).toBe(70);
    expect(truth.grossLineAmount).toBeNull();
  });

  it('TEST C — positive discount promo stays unknown under capture v1', () => {
    const truth = buildPriceObservationTruth({
      item: { lineTotal: 439, discountAllocated: 51, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(truth.amountState).toBe('conflict');
    expect(truth.promoContext).toBe('unknown');
    expect(truth.promoContext).not.toBe('none_observed');
    expect(truth.promoContext).not.toBe('explicit_discount');
  });

  const malformedDiscountValues: unknown[] = [
    '0',
    null,
    true,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ];

  it.each(malformedDiscountValues)(
    'TEST D — malformed-present discount %p yields promoContext unknown',
    (discountAllocated) => {
      const truth = buildPriceObservationTruth({
        item: { lineTotal: 439, discountAllocated, quantity: 1 },
        evidenceCaptureVersion: 1,
      });
      expect(truth.promoContext).toBe('unknown');
      expect(truth.promoContext).not.toBe('none_observed');
    }
  );

  it('TEST E — valid zero discount still allows none_observed', () => {
    const truth = buildPriceObservationTruth({
      item: { lineTotal: 439, discountAllocated: 0, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(truth.promoContext).toBe('none_observed');
  });

  it('TEST F — absent discount still allows none_observed', () => {
    const truth = buildPriceObservationTruth({
      item: { lineTotal: 439, quantity: 1 },
      evidenceCaptureVersion: 1,
    });
    expect(truth.promoContext).toBe('none_observed');
  });

  it('TEST G — marker wins over malformed discount', () => {
    const truth = buildPriceObservationTruth({
      item: {
        lineTotal: 439,
        discountAllocated: '0',
        promoMarkers: ['特'],
        quantity: 1,
      },
      evidenceCaptureVersion: 1,
    });
    expect(truth.promoContext).toBe('qualitative_marker');
    expect(truth.promoContext).not.toBe('explicit_discount');
  });
});
