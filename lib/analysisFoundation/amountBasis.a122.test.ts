/**
 * A1.2.2 final correctness — peer item gates, ownership, snapshot adversarial.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('../db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import type { ReceiptRow } from '../db';
import * as foundation from './index';
import {
  assessReceiptAmountBasis,
  buildAnalysisFoundationSnapshot,
  buildCanonicalReceiptGroups,
  evaluateExactPriceAmountBasisGate,
  evaluateReceiptItemPriceComparisonEligibility,
  isPersistedDiscountAllocationConsistent,
  resolveDiscountOwnership,
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
  canonical_product_id?: string;
};

function makeReceipt(args: {
  id: string;
  total?: number;
  tax?: number;
  taxIsKnown?: number;
  currency?: string;
  items: FixtureItem[];
  discounts?: Array<{
    label: string;
    amount: number;
    adjacentPrecedingItemIndex?: number;
  }>;
  analysisExtra?: Record<string, unknown>;
  userEdited?: number;
  finalTotal?: number | null;
  userItems?: FixtureItem[] | null;
}): ReceiptRow {
  const analysis: Record<string, unknown> = {
    items: args.items,
    ...(args.analysisExtra ?? {}),
  };
  if (args.discounts) analysis.discounts = args.discounts;
  return {
    id: args.id,
    created_at: Date.now(),
    transaction_at: Date.parse('2024-06-01T12:00:00+09:00'),
    image_uri: '',
    total: args.total ?? 2637,
    tax: args.tax ?? 195,
    tax_is_known: args.taxIsKnown ?? 1,
    currency: args.currency ?? 'JPY',
    analysis_json: JSON.stringify(analysis),
    merchant_raw: 'イオン',
    merchant_normalized: 'イオン',
    merchant_type: 'supermarket',
    user_edited: args.userEdited ?? 0,
    final_total: args.finalTotal ?? null,
    final_category: null,
    note: null,
    user_items_json: args.userItems ? JSON.stringify(args.userItems) : null,
  } as ReceiptRow;
}

const goodItem = {
  name: '明治おいしい牛乳',
  lineTotal: 2442,
  quantity: 1,
  identity_confidence: 0.9,
  identity_source: 'high_confidence_rule',
  merchant_product_id: 'mp_milk',
};

function excludedReceipt(id: string, overrides: Partial<Parameters<typeof makeReceipt>[0]> = {}) {
  const r = makeReceipt({
    id,
    items: [{ name: 'merchandise', lineTotal: 2442 }],
    tax: 195,
    total: 2637,
    taxIsKnown: 1,
    ...overrides,
  });
  // Unique transaction time per id so fixtures are not structural duplicates.
  const hash = [...id].reduce((s, c) => s + c.charCodeAt(0), 0);
  r.transaction_at = Date.parse('2024-06-01T12:00:00+09:00') + hash * 60_000;
  r.created_at = r.transaction_at as number;
  return r;
}

describe('A1.2.2 peer item independent gates', () => {
  const self = excludedReceipt('self-ok');

  test('1: peerItem invalid price => reject', () => {
    const peer = excludedReceipt('peer-bad-price');
    const r = evaluateReceiptItemPriceComparisonEligibility({
      receipt: self,
      item: goodItem,
      peerReceipt: peer,
      peerItem: { ...goodItem, lineTotal: -1 },
      canonicalGroups: buildCanonicalReceiptGroups([self, peer]),
    });
    expect(r.eligible).toBe(false);
    expect(
      r.reasonCodes.some((c) => c.includes('invalid_price') || c.includes('price_quality'))
    ).toBe(true);
  });

  test('2: peerItem quantity=0 => reject', () => {
    const peer = excludedReceipt('peer-qty0');
    const r = evaluateReceiptItemPriceComparisonEligibility({
      receipt: self,
      item: goodItem,
      peerReceipt: peer,
      peerItem: { ...goodItem, quantity: 0 },
      canonicalGroups: buildCanonicalReceiptGroups([self, peer]),
    });
    expect(r.eligible).toBe(false);
    expect(
      r.reasonCodes.some((c) => c.includes('invalid_quantity'))
    ).toBe(true);
  });

  test('3: peerItem unresolved identity => reject', () => {
    const peer = excludedReceipt('peer-id');
    const r = evaluateReceiptItemPriceComparisonEligibility({
      receipt: self,
      item: goodItem,
      peerReceipt: peer,
      peerItem: {
        name: '不明',
        lineTotal: 2442,
        quantity: 1,
        identity_confidence: 0,
        identity_source: 'unknown',
      },
      canonicalGroups: buildCanonicalReceiptGroups([self, peer]),
    });
    expect(r.eligible).toBe(false);
    expect(r.reasonCodes).toContain('peer_identity_unresolved');
  });

  test('4: peer receipt currency mismatch => reject', () => {
    const peer = excludedReceipt('peer-usd', { currency: 'USD' });
    const r = evaluateReceiptItemPriceComparisonEligibility({
      receipt: self,
      item: goodItem,
      peerReceipt: peer,
      peerItem: goodItem,
      canonicalGroups: buildCanonicalReceiptGroups([self, peer]),
    });
    expect(r.eligible).toBe(false);
    expect(r.reasonCodes).toContain('currency_mismatch');
  });

  test('5: peer receipt is duplicate-extra => reject', () => {
    const at = Date.parse('2024-06-01T14:22:33+09:00');
    const items = [
      { name: '牛乳', lineTotal: 198, quantity: 1 },
      { name: 'パン', lineTotal: 128, quantity: 1 },
    ];
    const a = makeReceipt({
      id: 'dup-rep',
      items: items as FixtureItem[],
      tax: 0,
      total: 326,
      taxIsKnown: 1,
    });
    a.transaction_at = at;
    a.created_at = at - 1000;
    const b = makeReceipt({
      id: 'dup-extra',
      items: items as FixtureItem[],
      tax: 0,
      total: 326,
      taxIsKnown: 1,
    });
    b.transaction_at = at;
    b.created_at = at;
    // Need tax>0 trusted basis for amount - use excluded style receipts that are also dups
    // For duplicate-extra test, amount basis may be unknown (tax=0). Use positive tax.
    const r1 = excludedReceipt('dup1');
    r1.transaction_at = at;
    r1.created_at = at - 1;
    const r2 = excludedReceipt('dup2');
    r2.transaction_at = at;
    r2.created_at = at;
    const groups = buildCanonicalReceiptGroups([r1, r2]);
    const repId = groups[0]!.representativeReceipt.id;
    const extraId = groups[0]!.sourceReceiptIds.find((id) => id !== repId)!;
    const rep = [r1, r2].find((x) => x.id === repId)!;
    const extra = [r1, r2].find((x) => x.id === extraId)!;
    const result = evaluateReceiptItemPriceComparisonEligibility({
      receipt: rep,
      item: goodItem,
      peerReceipt: extra,
      peerItem: goodItem,
      canonicalGroups: groups,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasonCodes).toContain('peer_duplicate_receipt_observation');
  });

  test('6: peer item structural spec incompatible => reject', () => {
    const peer = excludedReceipt('peer-spec');
    const r = evaluateReceiptItemPriceComparisonEligibility({
      receipt: self,
      item: {
        ...goodItem,
        name: 'コカ・コーラ 500ml',
        merchant_product_id: 'mp_coke',
      },
      peerReceipt: peer,
      peerItem: {
        ...goodItem,
        name: 'コカ・コーラ 1.5L',
        merchant_product_id: 'mp_coke',
      },
      canonicalGroups: buildCanonicalReceiptGroups([self, peer]),
    });
    expect(r.eligible).toBe(false);
    expect(r.reasonCodes).toContain('variant_spec_incomparable');
  });

  test('7: different product identities => reject', () => {
    const peer = excludedReceipt('peer-diff');
    const r = evaluateReceiptItemPriceComparisonEligibility({
      receipt: self,
      item: { ...goodItem, merchant_product_id: 'mp_milk' },
      peerReceipt: peer,
      peerItem: {
        name: '卵',
        lineTotal: 2442,
        quantity: 1,
        identity_confidence: 0.9,
        identity_source: 'high_confidence_rule',
        merchant_product_id: 'mp_egg',
      },
      canonicalGroups: buildCanonicalReceiptGroups([self, peer]),
    });
    expect(r.eligible).toBe(false);
    expect(r.reasonCodes).toContain('identity_mismatch');
  });

  test('8: only changing peerItem from valid→invalid changes result', () => {
    const peer = excludedReceipt('peer-flip');
    const groups = buildCanonicalReceiptGroups([self, peer]);
    const ok = evaluateReceiptItemPriceComparisonEligibility({
      receipt: self,
      item: goodItem,
      peerReceipt: peer,
      peerItem: goodItem,
      canonicalGroups: groups,
    });
    expect(ok.eligible).toBe(true);
    const bad = evaluateReceiptItemPriceComparisonEligibility({
      receipt: self,
      item: goodItem,
      peerReceipt: peer,
      peerItem: { ...goodItem, quantity: 0 },
      canonicalGroups: groups,
    });
    expect(bad.eligible).toBe(false);
  });

  test('9: both valid comparable observations => eligible=true', () => {
    const peer = excludedReceipt('peer-ok');
    const r = evaluateReceiptItemPriceComparisonEligibility({
      receipt: self,
      item: goodItem,
      peerReceipt: peer,
      peerItem: goodItem,
      canonicalGroups: buildCanonicalReceiptGroups([self, peer]),
    });
    expect(r.reasonCodes).toEqual([]);
    expect(r.eligible).toBe(true);
  });
});

describe('A1.2.2 public API cannot authorize via basis strings alone', () => {
  test('no public basis-only comparator export', () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        foundation,
        'areAmountBasesComparableForPrice'
      )
    ).toBe(false);
    // Only full ExactPriceAmountEvidence gate is public
    const gate = evaluateExactPriceAmountBasisGate(
      { basis: 'tax_included', confidence: 'medium', taxProvenance: 'trusted' },
      { basis: 'tax_included', confidence: 'high', taxProvenance: 'trusted' }
    );
    expect(gate.pass).toBe(false);
  });
});

describe('A1.2.2 discount ownership preservation', () => {
  test('1-2: evidenceTexts-bound まとめ売り not reclassified as receipt-level without evidence', () => {
    // Persisted ownership after original normalization with evidence
    const r = makeReceipt({
      id: 'matome-persisted',
      items: [
        {
          name: 'ファンタ',
          lineTotal: 210,
          effectiveLineTotal: 203,
          discountAllocated: -7,
        },
      ],
      discounts: [{ label: 'まとめ売り値引', amount: -7 }],
      tax: 15,
      total: 218,
      taxIsKnown: 1,
    });
    const ownership = resolveDiscountOwnership({
      ocrItems: [
        {
          name: 'ファンタ',
          lineTotal: 210,
          effectiveLineTotal: 203,
          discountAllocated: -7,
        },
      ],
      ocrDiscounts: [{ label: 'まとめ売り値引', amount: -7 }],
    });
    expect(ownership.status).toBe('persisted_resolved');
    expect(ownership.genuineReceiptLevelRemainder).toBe(0);
    const a = assessReceiptAmountBasis(r);
    expect(a.unallocatedDiscountTotal).toBe(0);
    expect(a.analyticsItemSum).toBe(203);
    expect(a.basis).toBe('tax_excluded');

    // Without persisted ownership AND without evidenceTexts → unresolved (not receipt-level)
    const unresolved = resolveDiscountOwnership({
      ocrItems: [{ name: 'ファンタ', lineTotal: 210 }],
      ocrDiscounts: [{ label: 'まとめ売り値引', amount: -7 }],
      analysis: {},
    });
    expect(unresolved.status).toBe('unresolved');
    expect(unresolved.genuineReceiptLevelRemainder).toBe(0);
  });

  test('3: persisted allocation without discounts[] preserves ownership', () => {
    const ownership = resolveDiscountOwnership({
      ocrItems: [
        {
          name: '商品',
          lineTotal: 210,
          effectiveLineTotal: 203,
          discountAllocated: -7,
        },
      ],
      ocrDiscounts: [],
    });
    expect(ownership.status).toBe('persisted_resolved');
    expect(ownership.analyticsItemSum).toBe(203);
    expect(ownership.genuineReceiptLevelRemainder).toBe(0);
  });

  test('4: inconsistent persisted allocation not trusted', () => {
    expect(
      isPersistedDiscountAllocationConsistent({
        lineTotal: 210,
        effectiveLineTotal: 203,
        discountAllocated: 0,
      })
    ).toBe(false);
    const ownership = resolveDiscountOwnership({
      ocrItems: [
        {
          name: '商品',
          lineTotal: 210,
          effectiveLineTotal: 203,
          discountAllocated: 0,
        },
      ],
      ocrDiscounts: [{ label: 'まとめ売り値引', amount: -7 }],
      analysis: {},
    });
    expect(ownership.status).toBe('unresolved');
  });

  test('5: user edit + original bound product coupon never deducted again', () => {
    const r = makeReceipt({
      id: 'user-bound',
      items: [
        {
          name: 'ROCHER ORIGINS',
          lineTotal: 1000,
          effectiveLineTotal: 400,
          discountAllocated: -600,
        },
      ],
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

  test('6-7: bound product coupons + one genuine receipt-level remainder once', () => {
    const r = makeReceipt({
      id: 'multi-own',
      items: [
        {
          name: 'ROCHER ORIGINS',
          lineTotal: 1000,
          effectiveLineTotal: 400,
          discountAllocated: -600,
        },
        {
          name: 'シーフードピザ',
          lineTotal: 800,
          effectiveLineTotal: 460,
          discountAllocated: -340,
        },
      ],
      discounts: [
        { label: 'ROCHER ORIGINS CPN', amount: -600 },
        { label: 'シーフード CPN', amount: -340 },
        { label: '店舗クーポン共通', amount: -50 },
      ],
      tax: 65,
      total: 875,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.unallocatedDiscountTotal).toBe(-50);
    expect(a.analyticsItemSum).toBe(860);
    expect(a.basis).toBe('tax_excluded');
  });

  test('8: unresolved ownership => unknown, not receipt-level', () => {
    const r = makeReceipt({
      id: 'unresolved-own',
      items: [{ name: 'ファンタ', lineTotal: 210 }],
      discounts: [{ label: 'まとめ売り値引', amount: -7 }],
      tax: 15,
      total: 218,
      taxIsKnown: 1,
      analysisExtra: {},
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('discount_ownership_unresolved');
    expect(a.unallocatedDiscountTotal).toBe(0);
  });

  test('9: まとめ売り reallocation with evidenceTexts succeeds', () => {
    const ownership = resolveDiscountOwnership({
      ocrItems: [{ name: 'ファンタ', lineTotal: 210 }],
      ocrDiscounts: [{ label: 'まとめ売り値引', amount: -7 }],
      analysis: { ocr_raw_text: '2個¥203 × 1組 まとめ売り' },
    });
    expect(ownership.status).toBe('reallocated_with_evidence');
    expect(ownership.analyticsItemSum).toBe(203);
    expect(ownership.genuineReceiptLevelRemainder).toBe(0);
  });

  test('10: no evidenceTexts and ownership cannot reproduce => unknown', () => {
    const r = makeReceipt({
      id: 'no-ev',
      items: [{ name: 'ファンタ', lineTotal: 210 }],
      discounts: [{ label: 'まとめ売り値引', amount: -7 }],
      tax: 15,
      total: 218,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('discount_ownership_unresolved');
  });
});

describe('A1.2 Final — persisted allocation structural validation', () => {
  test('1: positive discountAllocated +1 => NOT persisted_resolved', () => {
    expect(
      isPersistedDiscountAllocationConsistent({
        lineTotal: 100,
        discountAllocated: 1,
        effectiveLineTotal: 101,
      })
    ).toBe(false);
    expect(
      resolveDiscountOwnership({
        ocrItems: [
          {
            name: 'x',
            lineTotal: 100,
            discountAllocated: 1,
            effectiveLineTotal: 101,
          },
        ],
        ocrDiscounts: [],
      }).status
    ).not.toBe('persisted_resolved');
  });

  test('2: positive discountAllocated +2 => NOT persisted_resolved', () => {
    expect(
      isPersistedDiscountAllocationConsistent({
        lineTotal: 100,
        discountAllocated: 2,
        effectiveLineTotal: 102,
      })
    ).toBe(false);
  });

  test('3: abs(discount) > gross (-101) => NOT persisted_resolved', () => {
    expect(
      isPersistedDiscountAllocationConsistent({
        lineTotal: 100,
        discountAllocated: -101,
        effectiveLineTotal: 0,
      })
    ).toBe(false);
  });

  test('4: abs(discount) > gross (-102) => NOT persisted_resolved', () => {
    expect(
      isPersistedDiscountAllocationConsistent({
        lineTotal: 100,
        discountAllocated: -102,
        effectiveLineTotal: 0,
      })
    ).toBe(false);
  });

  test('5: conflicting lineTotal vs line_total => NOT persisted_resolved', () => {
    expect(
      isPersistedDiscountAllocationConsistent({
        lineTotal: 100,
        line_total: 101,
        discountAllocated: -10,
        effectiveLineTotal: 90,
      })
    ).toBe(false);
  });

  test('6: agreeing aliases + valid allocation => valid', () => {
    expect(
      isPersistedDiscountAllocationConsistent({
        lineTotal: 100,
        line_total: 100,
        discountAllocated: -10,
        effectiveLineTotal: 90,
      })
    ).toBe(true);
  });

  test('7: 1 JPY rounding still allowed', () => {
    expect(
      isPersistedDiscountAllocationConsistent({
        lineTotal: 100,
        discountAllocated: -10,
        effectiveLineTotal: 91,
      })
    ).toBe(true);
  });

  test('8: 2 JPY rounding still allowed', () => {
    expect(
      isPersistedDiscountAllocationConsistent({
        lineTotal: 100,
        discountAllocated: -10,
        effectiveLineTotal: 92,
      })
    ).toBe(true);
  });

  test('9: 3 JPY equation gap => invalid', () => {
    expect(
      isPersistedDiscountAllocationConsistent({
        lineTotal: 100,
        discountAllocated: -10,
        effectiveLineTotal: 93,
      })
    ).toBe(false);
  });
});

describe('A1.2.2 snapshot adversarial', () => {
  test('deep determinism across input permutation', () => {
    const a = excludedReceipt('z');
    const b = excludedReceipt('a', {
      items: [{ name: 'x', lineTotal: 3352 }],
      tax: 248,
      total: 3352,
    });
    const c = excludedReceipt('m', {
      items: [{ name: 'y', lineTotal: 1000 }],
      tax: 80,
      total: 1080,
    });
    const s1 = buildAnalysisFoundationSnapshot([a, b, c]);
    const s2 = buildAnalysisFoundationSnapshot([c, a, b]);
    expect(JSON.stringify(s1.receiptAmountBasisAssessments)).toBe(
      JSON.stringify(s2.receiptAmountBasisAssessments)
    );
    expect(s1.version).toBe(s2.version);
  });

  test('no mutation of input receipts', () => {
    const receipts = [
      excludedReceipt('m1'),
      excludedReceipt('m2', {
        items: [{ name: 'x', lineTotal: 3352 }],
        tax: 248,
        total: 3352,
      }),
    ];
    const before = JSON.parse(JSON.stringify(receipts));
    buildAnalysisFoundationSnapshot(receipts);
    expect(receipts).toEqual(before);
  });
});
