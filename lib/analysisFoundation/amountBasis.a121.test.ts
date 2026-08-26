/**
 * A1.2.1 correctness fixes — Codex-required scenarios.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('../db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import type { ReceiptRow } from '../db';
import {
  AMOUNT_BASIS_TOLERANCE_JPY,
  assessReceiptAmountBasis,
  assessReceiptAmountBasisForAll,
  buildAnalysisFoundationSnapshot,
  buildCanonicalReceiptGroups,
  buildMonetaryObservation,
  evaluatePriceComparisonEligibility,
  evaluateReceiptItemPriceComparisonEligibility,
  isExactPriceAmountEvidenceTrusted,
  type ExactPriceAmountEvidence,
} from './index';

type FixtureItem = {
  name: string;
  lineTotal: number;
  quantity?: number;
  effectiveLineTotal?: number;
  discountAllocated?: number;
  amountUserEdited?: boolean;
  identity_confidence?: number;
  identity_source?: string;
  merchant_product_id?: string;
};

function makeReceipt(args: {
  id: string;
  total?: number;
  tax?: number;
  taxIsKnown?: number;
  items: FixtureItem[];
  discounts?: Array<{ label: string; amount: number }>;
  userEdited?: number;
  finalTotal?: number | null;
  userItems?: FixtureItem[] | null;
  userItemsJsonRaw?: string | null;
  merchantNormalized?: string;
}): ReceiptRow {
  const analysis: Record<string, unknown> = { items: args.items };
  if (args.discounts) analysis.discounts = args.discounts;
  let user_items_json: string | null = null;
  if (args.userItemsJsonRaw !== undefined) {
    user_items_json = args.userItemsJsonRaw;
  } else if (args.userItems != null) {
    user_items_json = JSON.stringify(args.userItems);
  }
  return {
    id: args.id,
    created_at: Date.now(),
    transaction_at: Date.parse('2024-06-01T12:00:00+09:00'),
    image_uri: '',
    total: args.total ?? args.items.reduce((s, i) => s + i.lineTotal, 0),
    tax: args.tax ?? 0,
    tax_is_known: args.taxIsKnown ?? 0,
    currency: 'JPY',
    analysis_json: JSON.stringify(analysis),
    merchant_raw: args.merchantNormalized ?? 'イオン',
    merchant_normalized: args.merchantNormalized ?? 'イオン',
    merchant_type: 'supermarket',
    user_edited: args.userEdited ?? 0,
    final_total: args.finalTotal ?? null,
    final_category: null,
    note: null,
    user_items_json,
  } as ReceiptRow;
}

const trustedExcluded: ExactPriceAmountEvidence = {
  basis: 'tax_excluded',
  confidence: 'high',
  taxProvenance: 'trusted',
};
const trustedIncluded: ExactPriceAmountEvidence = {
  basis: 'tax_included',
  confidence: 'high',
  taxProvenance: 'trusted',
};

function side(partial: {
  rawName?: string;
  quantity?: number;
  lineTotal?: number;
  currency?: string;
  identityConfidence?: number;
  identitySource?: string;
  merchantProductId?: string | null;
  amountEvidence: ExactPriceAmountEvidence | null | undefined;
}) {
  return {
    rawName: partial.rawName ?? '牛乳',
    quantity: partial.quantity ?? 1,
    lineTotal: partial.lineTotal ?? 200,
    currency: partial.currency ?? 'JPY',
    identityConfidence: partial.identityConfidence ?? 0.9,
    identitySource: partial.identitySource ?? 'high_confidence_rule',
    merchantProductId:
      partial.merchantProductId === undefined ? 'mp' : partial.merchantProductId,
    amountEvidence: partial.amountEvidence,
  };
}


describe('A1.2.1 exact price amount-basis gate', () => {
  test('1: self basis omitted => reject', () => {
    const r = evaluatePriceComparisonEligibility({
      self: side({ amountEvidence: null }),
      peer: side({ amountEvidence: trustedExcluded }),
    });
    expect(r.eligible).toBe(false);
    expect(r.reasonCodes).toContain('amount_basis_unknown');
  });

  test('2: peer basis omitted => reject', () => {
    const r = evaluatePriceComparisonEligibility({
      self: side({ amountEvidence: trustedExcluded }),
      peer: side({ amountEvidence: undefined }),
    });
    expect(r.eligible).toBe(false);
    expect(
      r.reasonCodes.some((c) => c === 'amount_basis_unknown' || c === 'peer_amount_basis_unknown')
    ).toBe(true);
  });

  test('3: both omitted => reject', () => {
    const r = evaluatePriceComparisonEligibility({
      self: side({ amountEvidence: null }),
      peer: side({ amountEvidence: null }),
    });
    expect(r.eligible).toBe(false);
    expect(r.reasonCodes).toContain('amount_basis_unknown');
  });

  test('4: known self + unknown peer => reject', () => {
    const r = evaluatePriceComparisonEligibility({
      self: side({ amountEvidence: trustedIncluded }),
      peer: side({
        amountEvidence: {
          basis: 'unknown',
          confidence: 'unknown',
          taxProvenance: 'untrusted',
        },
      }),
    });
    expect(
      r.reasonCodes.some((c) => c === 'amount_basis_unknown' || c === 'peer_amount_basis_unknown')
    ).toBe(true);
    expect(r.eligible).toBe(false);
  });

  test('5: known different bases => mismatch', () => {
    const r = evaluatePriceComparisonEligibility({
      self: side({ amountEvidence: trustedIncluded }),
      peer: side({ amountEvidence: trustedExcluded }),
    });
    expect(r.reasonCodes).toContain('amount_basis_mismatch');
  });

  test('6: same trusted known bases => basis gate pass', () => {
    const r = evaluatePriceComparisonEligibility({
      self: side({ amountEvidence: trustedExcluded }),
      peer: side({ amountEvidence: trustedExcluded }),
    });
    expect(r.reasonCodes).not.toContain('amount_basis_unknown');
    expect(r.reasonCodes).not.toContain('amount_basis_mismatch');
    expect(r.eligible).toBe(true);
  });

  test('7: receipt-item pairwise convenience API requires peer monetary evidence', () => {
    const a = makeReceipt({
      id: 'pair-a',
      items: [{ name: '牛乳', lineTotal: 2442 }],
      tax: 195,
      total: 2637,
      taxIsKnown: 1,
    });
    const b = makeReceipt({
      id: 'pair-b',
      items: [{ name: '牛乳', lineTotal: 2442 }],
      tax: 195,
      total: 2637,
      taxIsKnown: 1,
    });
    const ok = evaluateReceiptItemPriceComparisonEligibility({
      receipt: a,
      item: {
        name: '牛乳',
        lineTotal: 2442,
        quantity: 1,
        identity_confidence: 0.9,
        identity_source: 'high_confidence_rule',
        merchant_product_id: 'mp_milk',
      },
      peerReceipt: b,
      peerItem: {
        name: '牛乳',
        lineTotal: 2442,
        quantity: 1,
        merchant_product_id: 'mp_milk',
      },
      canonicalGroups: buildCanonicalReceiptGroups([a, b]),
    });
    expect(ok.reasonCodes).not.toContain('amount_basis_unknown');
    expect(assessReceiptAmountBasis(a).exactComparisonTrusted).toBe(true);

    const untrustedPeer = makeReceipt({
      id: 'pair-c',
      items: [{ name: '牛乳', lineTotal: 2442 }],
      tax: 195,
      total: 2637,
      taxIsKnown: 0,
    });
    const bad = evaluateReceiptItemPriceComparisonEligibility({
      receipt: a,
      item: {
        name: '牛乳',
        lineTotal: 2442,
        quantity: 1,
        identity_confidence: 0.9,
        identity_source: 'high_confidence_rule',
        merchant_product_id: 'mp_milk',
      },
      peerReceipt: untrustedPeer,
      peerItem: { name: '牛乳', lineTotal: 2442, quantity: 1 },
      canonicalGroups: buildCanonicalReceiptGroups([a, untrustedPeer]),
    });
    expect(bad.eligible).toBe(false);
    expect(bad.reasonCodes).toContain('amount_basis_unknown');
  });
});

describe('A1.2.1 tax trust + confidence', () => {
  test('8: tax_is_known=0 + positive tax cannot enter exact comparison', () => {
    const r = makeReceipt({
      id: 'untrusted-tax',
      items: [{ name: 'x', lineTotal: 2442 }],
      tax: 195,
      total: 2637,
      taxIsKnown: 0,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.taxProvenance).toBe('untrusted');
    expect(a.exactComparisonTrusted).toBe(false);
    expect(a.reasonCodes).toContain('tax_untrusted');
  });

  test('9: medium confidence cannot authorize exact comparison', () => {
    const r = makeReceipt({
      id: 'medium-conf',
      items: [{ name: '牛乳', lineTotal: 1000 }],
      discounts: [{ label: '店舗クーポン共通', amount: -100 }],
      tax: 72,
      total: 972,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('tax_excluded');
    expect(a.confidence).toBe('medium');
    expect(a.exactComparisonTrusted).toBe(false);
    const gate = evaluatePriceComparisonEligibility({
      self: side({
        lineTotal: 900,
        amountEvidence: {
          basis: a.basis,
          confidence: a.confidence,
          taxProvenance: a.taxProvenance,
        },
      }),
      peer: side({ amountEvidence: trustedExcluded }),
    });
    expect(gate.reasonCodes).toContain('amount_basis_unknown');
    expect(isExactPriceAmountEvidenceTrusted({
      basis: a.basis,
      confidence: a.confidence,
      taxProvenance: a.taxProvenance,
    })).toBe(false);
  });
});

describe('A1.2.1 monetary source coherence', () => {
  test('10: user-edited line + OCR product coupon cleared discountAllocated not double-applied', () => {
    const r = makeReceipt({
      id: 'no-double',
      items: [{ name: 'ROCHER ORIGINS', lineTotal: 1000 }],
      discounts: [{ label: 'ROCHER ORIGINS CPN', amount: -600 }],
      tax: 32,
      total: 432,
      taxIsKnown: 1,
      userEdited: 1,
      finalTotal: 432,
      userItems: [
        {
          name: 'ROCHER ORIGINS',
          lineTotal: 400,
          amountUserEdited: true,
          discountAllocated: 0,
          effectiveLineTotal: 400,
        },
      ],
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.unallocatedDiscountTotal).toBe(0);
    expect(a.analyticsItemSum).toBe(400);
    expect(a.basis).toBe('tax_excluded');
  });

  test('11: user_items without coherent final total => unknown', () => {
    const r = makeReceipt({
      id: 'user-no-total',
      items: [{ name: 'x', lineTotal: 1000 }],
      tax: 80,
      total: 1080,
      taxIsKnown: 1,
      userEdited: 1,
      finalTotal: null,
      userItems: [{ name: 'x', lineTotal: 900, amountUserEdited: true }],
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('monetary_source_incoherent');
  });

  test('12: final_total without matching user item layer => unknown', () => {
    const r = makeReceipt({
      id: 'final-no-items',
      items: [{ name: 'x', lineTotal: 1000 }],
      tax: 80,
      total: 1080,
      taxIsKnown: 1,
      userEdited: 1,
      finalTotal: 1080,
      userItems: null,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('monetary_source_incoherent');
  });

  test('13: inconsistent legacy user-edit metadata => unknown', () => {
    const r = makeReceipt({
      id: 'legacy-inconsistent',
      items: [{ name: 'x', lineTotal: 1000 }],
      tax: 80,
      total: 1080,
      taxIsKnown: 1,
      userEdited: 0,
      finalTotal: 1080,
      userItems: [{ name: 'x', lineTotal: 1000 }],
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('inconsistent_legacy_user_edit_metadata');
  });
});

describe('A1.2.1 discounts', () => {
  test('14: positive discount representation normalized', () => {
    const r = makeReceipt({
      id: 'pos-disc',
      items: [{ name: '牛乳', lineTotal: 1000 }],
      discounts: [{ label: '店舗クーポン共通', amount: 100 }],
      tax: 72,
      total: 972,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.unallocatedDiscountTotal).toBe(-100);
    expect(a.basis).toBe('tax_excluded');
  });

  test('15: negative discount representation', () => {
    const r = makeReceipt({
      id: 'neg-disc',
      items: [{ name: '牛乳', lineTotal: 1000 }],
      discounts: [{ label: '店舗クーポン共通', amount: -100 }],
      tax: 72,
      total: 972,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.unallocatedDiscountTotal).toBe(-100);
    expect(a.basis).toBe('tax_excluded');
  });

  test('16: component discounts + 値引合計 => ambiguous/unknown', () => {
    const r = makeReceipt({
      id: 'summary-ambig',
      items: [{ name: '商品A', lineTotal: 2000 }],
      discounts: [
        { label: 'クーポンA', amount: -100 },
        { label: '値引合計', amount: -100 },
      ],
      tax: 152,
      total: 2052,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('aggregate_discount_summary_ambiguous');
  });

  test('17: multiple bound product coupons + one receipt-level remainder once', () => {
    const r = makeReceipt({
      id: 'multi-bound',
      items: [
        { name: 'ROCHER ORIGINS', lineTotal: 1000 },
        { name: 'シーフードピザ', lineTotal: 800 },
      ],
      discounts: [
        { label: 'ROCHER ORIGINS CPN', amount: -600 },
        { label: 'シーフード CPN', amount: -340 },
        { label: '店舗クーポン共通', amount: -50 },
      ],
      tax: 65,
      // allocated items: 400 + 460 = 860; remainder -50 → 810; +tax 65 → 875
      total: 875,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.unallocatedDiscountTotal).toBe(-50);
    expect(a.analyticsItemSum).toBe(860);
    expect(a.basis).toBe('tax_excluded');
  });
});

describe('A1.2.1 tolerance / evidence / snapshot', () => {
  test('18: tolerance exactly +2 / -2 JPY', () => {
    const base = {
      items: [{ name: 'x', lineTotal: 1000 }],
      tax: 100,
      taxIsKnown: 1 as const,
    };
    const plus = assessReceiptAmountBasis(
      makeReceipt({ id: 'tol-plus', ...base, total: 1102 })
    );
    const minus = assessReceiptAmountBasis(
      makeReceipt({ id: 'tol-minus', ...base, total: 1098 })
    );
    const over = assessReceiptAmountBasis(
      makeReceipt({ id: 'tol-over', ...base, total: 1103 })
    );
    expect(AMOUNT_BASIS_TOLERANCE_JPY).toBe(2);
    expect(plus.basis).toBe('tax_excluded');
    expect(minus.basis).toBe('tax_excluded');
    expect(over.basis).toBe('unknown');
  });

  test('19: ambiguity overlap case', () => {
    const r = makeReceipt({
      id: 'overlap',
      items: [{ name: 'x', lineTotal: 100 }],
      tax: 1,
      total: 100,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('ambiguous_both_hypotheses_close');
  });

  test('20: zero/missing total => unknown', () => {
    const r = makeReceipt({
      id: 'zero-total',
      items: [{ name: 'x', lineTotal: 100 }],
      tax: 8,
      total: 0,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('invalid_authoritative_total');
  });

  test('21: empty items => unknown', () => {
    const r = makeReceipt({
      id: 'empty-items',
      items: [],
      tax: 100,
      total: 100,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('missing_item_monetary_evidence');
  });

  test('22: malformed user JSON => unknown', () => {
    const r = makeReceipt({
      id: 'bad-json',
      items: [{ name: 'x', lineTotal: 1000 }],
      tax: 80,
      total: 1080,
      taxIsKnown: 1,
      userEdited: 1,
      finalTotal: 1080,
      userItemsJsonRaw: '{not-json',
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('malformed_user_items_json');
  });

  test('23: invalid monetary values (NaN total) => unknown', () => {
    const r = makeReceipt({
      id: 'nan-total',
      items: [{ name: 'x', lineTotal: 1000 }],
      tax: 80,
      total: 1080,
      taxIsKnown: 1,
    });
    (r as { total: number }).total = Number.NaN;
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(
      a.reasonCodes.some(
        (c) =>
          c === 'invalid_authoritative_total' || c === 'monetary_source_incoherent'
      )
    ).toBe(true);
  });

  test('24: snapshot input permutation => deterministic assessment order', () => {
    const a = makeReceipt({
      id: 'z-last',
      items: [{ name: 'a', lineTotal: 2442 }],
      tax: 195,
      total: 2637,
      taxIsKnown: 1,
    });
    const b = makeReceipt({
      id: 'a-first',
      items: [{ name: 'b', lineTotal: 3352 }],
      tax: 248,
      total: 3352,
      taxIsKnown: 1,
    });
    const c = makeReceipt({
      id: 'm-mid',
      items: [{ name: 'c', lineTotal: 1000 }],
      tax: 80,
      total: 1080,
      taxIsKnown: 1,
    });
    const s1 = buildAnalysisFoundationSnapshot([a, b, c]);
    const s2 = buildAnalysisFoundationSnapshot([c, a, b]);
    const ids1 = s1.receiptAmountBasisAssessments.map((x) => x.receiptId);
    const ids2 = s2.receiptAmountBasisAssessments.map((x) => x.receiptId);
    expect(ids1).toEqual(ids2);
    expect(ids1).toEqual(['a-first', 'm-mid', 'z-last']);
    expect(assessReceiptAmountBasisForAll([c, a, b]).map((x) => x.receiptId)).toEqual(
      ids1
    );
  });

  test('25: mixed 8%/10% without item tax rate => no proportional normalization', () => {
    const obs = buildMonetaryObservation({
      rawAmount: 1080,
      effectiveAmount: 1080,
      taxBasis: 'tax_included',
      itemTaxRatePercent: null,
    });
    expect(obs.normalizedGrossAmount).toBe(1080);
    expect(obs.normalizedNetAmount).toBeNull();
    expect(obs.evidence).toContain('no_proportional_receipt_tax_split');
  });
});
