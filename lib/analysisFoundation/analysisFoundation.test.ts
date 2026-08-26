/**
 * Meruno Analysis Foundation A1 — unit tests (required scenarios 1–8).
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('../db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import type { ReceiptRow } from '../db';
import {
  buildAnalysisFoundationSnapshot,
  buildCanonicalReceiptGroups,
  buildMonetaryObservation,
  buildShoppingSessionCandidates,
  consolidateReceiptBasket,
  deriveCanonicalMerchant,
  assessReceiptAmountBasis,
  evaluatePriceComparisonEligibility,
  evaluatePurchaseCycleEligibility,
  pickCanonicalRepresentativeReceipt,
  type ExactPriceAmountEvidence,
} from './index';
import { summarizeReceiptForDuplicateAudit } from '../analysisDDuplicateAudit';

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
  amountEvidence: ExactPriceAmountEvidence | null;
}) {
  return {
    rawName: partial.rawName ?? '牛乳',
    quantity: partial.quantity ?? 1,
    lineTotal: partial.lineTotal ?? 200,
    currency: partial.currency ?? 'JPY',
    identityConfidence: partial.identityConfidence ?? 0.9,
    identitySource: partial.identitySource ?? 'high_confidence_rule',
    merchantProductId: partial.merchantProductId === undefined ? 'mp_1' : partial.merchantProductId,
    amountEvidence: partial.amountEvidence,
  };
}

type FixtureItem = {
  name: string;
  lineTotal: number;
  quantity?: number;
  category?: string;
  identity_confidence?: number;
  identity_source?: string;
  merchant_product_id?: string;
  canonical_product_id?: string;
  spec_size_value?: number;
  spec_size_unit?: string;
  effectiveLineTotal?: number;
  discountAllocated?: number;
  amountUserEdited?: boolean;
};

function makeReceipt(args: {
  id: string;
  merchantNormalized?: string;
  merchantRaw?: string;
  transactionAt?: number | null;
  createdAt?: number;
  total?: number;
  tax?: number;
  taxIsKnown?: number;
  items: FixtureItem[];
  discounts?: Array<{ label: string; amount: number }>;
  userEdited?: number;
  finalTotal?: number | null;
  userItems?: FixtureItem[] | null;
  currency?: string;
}): ReceiptRow {
  const itemSum = args.items.reduce(
    (s, it) => s + (it.lineTotal ?? 0),
    0
  );
  const analysis: Record<string, unknown> = { items: args.items };
  if (args.discounts) analysis.discounts = args.discounts;
  return {
    id: args.id,
    created_at: args.createdAt ?? args.transactionAt ?? Date.now(),
    transaction_at:
      args.transactionAt === undefined ? Date.now() : args.transactionAt,
    image_uri: '',
    total: args.total ?? itemSum,
    tax: args.tax ?? 0,
    tax_is_known: args.taxIsKnown ?? 0,
    currency: args.currency ?? 'JPY',
    analysis_json: JSON.stringify(analysis),
    merchant_raw: args.merchantRaw ?? args.merchantNormalized ?? 'イオン',
    merchant_normalized: args.merchantNormalized ?? 'イオン',
    merchant_type: 'supermarket',
    user_edited: args.userEdited ?? 0,
    final_total: args.finalTotal ?? null,
    final_category: null,
    note: null,
    user_items_json:
      args.userItems != null ? JSON.stringify(args.userItems) : null,
  } as ReceiptRow;
}

describe('Analysis Foundation A1', () => {
  // 1. Same merchant + transaction_at + total + similar basket => high-confidence duplicate
  test('1: high-confidence duplicate when merchant/time/total/basket align', () => {
    const at = Date.parse('2024-06-01T14:22:33+09:00');
    const items: FixtureItem[] = [
      { name: '牛乳', lineTotal: 198, quantity: 1 },
      { name: 'パン', lineTotal: 128, quantity: 1 },
    ];
    const r1 = makeReceipt({
      id: 'dup-a',
      merchantNormalized: 'イオン',
      transactionAt: at,
      total: 326,
      createdAt: at - 60_000,
      items,
    });
    const r2 = makeReceipt({
      id: 'dup-b',
      merchantNormalized: 'イオン',
      transactionAt: at,
      total: 326,
      createdAt: at,
      items: [
        { name: '牛乳', lineTotal: 198, quantity: 1 },
        { name: 'パン', lineTotal: 128, quantity: 1 },
      ],
    });
    const groups = buildCanonicalReceiptGroups([r1, r2]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.duplicateCount).toBe(1);
    expect(groups[0]!.sourceReceiptIds).toEqual(['dup-a', 'dup-b']);
    expect(groups[0]!.confidence).toMatch(/DUPLICATE$/);
  });

  // 2. Same total but different dates => do not merge
  test('2: same total different transaction dates stay separate', () => {
    const items: FixtureItem[] = [{ name: '牛乳', lineTotal: 500, quantity: 1 }];
    const r1 = makeReceipt({
      id: 'day-a',
      transactionAt: Date.parse('2024-06-01T12:00:00+09:00'),
      total: 500,
      items,
    });
    const r2 = makeReceipt({
      id: 'day-b',
      transactionAt: Date.parse('2024-06-02T12:00:00+09:00'),
      total: 500,
      items,
    });
    const groups = buildCanonicalReceiptGroups([r1, r2]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.duplicateCount === 0)).toBe(true);
  });

  // 3. Missing transaction_at, only close created_at => no hard merge
  test('3: missing transaction_at prevents automatic hard merge', () => {
    const created = Date.parse('2024-06-01T12:00:00+09:00');
    const items: FixtureItem[] = [{ name: '牛乳', lineTotal: 300, quantity: 1 }];
    const r1 = makeReceipt({
      id: 'no-tx-a',
      transactionAt: null,
      createdAt: created,
      total: 300,
      items,
    });
    const r2 = makeReceipt({
      id: 'no-tx-b',
      transactionAt: null,
      createdAt: created + 5 * 60_000,
      total: 300,
      items,
    });
    const groups = buildCanonicalReceiptGroups([r1, r2]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.confidence === 'SINGLETON')).toBe(true);
  });

  // 4. Same receipt same product 2+2+1 => consolidated quantity 5
  test('4: basket consolidates 2+2+1 lines with same unit price', () => {
    const at = Date.parse('2024-06-01T10:00:00+09:00');
    const receipt = makeReceipt({
      id: 'basket-1',
      transactionAt: at,
      items: [
        {
          name: 'さつまいも',
          lineTotal: 254,
          quantity: 2,
          identity_confidence: 0.8,
          identity_source: 'high_confidence_rule',
        },
        {
          name: 'さつまいも',
          lineTotal: 254,
          quantity: 2,
          identity_confidence: 0.8,
          identity_source: 'high_confidence_rule',
        },
        {
          name: 'さつまいも',
          lineTotal: 127,
          quantity: 1,
          identity_confidence: 0.8,
          identity_source: 'high_confidence_rule',
        },
      ],
      total: 635,
    });
    const basket = consolidateReceiptBasket(receipt);
    const merged = basket.lines.filter((l) => l.sourceItemIndexes.length > 1);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.quantity).toBe(5);
    expect(merged[0]!.unitPrice).toBe(127);
    expect(merged[0]!.lineTotal).toBe(635);
  });

  // 5. Similar names but different specs => no erroneous merge
  test('5: similar names different volume specs are not merged', () => {
    const receipt = makeReceipt({
      id: 'spec-split',
      transactionAt: Date.parse('2024-06-01T11:00:00+09:00'),
      items: [
        {
          name: 'コカ・コーラ 500ml',
          lineTotal: 150,
          quantity: 1,
          identity_confidence: 0.9,
          identity_source: 'high_confidence_rule',
        },
        {
          name: 'コカ・コーラ 1.5L',
          lineTotal: 250,
          quantity: 1,
          identity_confidence: 0.9,
          identity_source: 'high_confidence_rule',
        },
      ],
      total: 400,
    });
    const basket = consolidateReceiptBasket(receipt);
    expect(basket.lines).toHaveLength(2);
    expect(basket.lines.every((l) => l.sourceItemIndexes.length === 1)).toBe(
      true
    );
  });

  // 6. Untrusted price identity => price comparison rejected with reason
  test('6: low-confidence identity rejects price comparison', () => {
    const result = evaluatePriceComparisonEligibility({
      self: side({
        rawName: '不明商品',
        lineTotal: 100,
        identityConfidence: 0,
        identitySource: 'unknown',
        merchantProductId: null,
        amountEvidence: trustedExcluded,
      }),
      peer: side({ amountEvidence: trustedExcluded }),
    });
    expect(result.eligible).toBe(false);
    expect(result.reasonCodes).toContain('identity_unresolved');
  });

  // 7. Same day two stores 33 minutes apart => shopping session candidate, not confirmed
  test('7: two merchants 33 minutes apart form candidate only', () => {
    const base = Date.parse('2024-08-10T18:26:00+09:00');
    const r1 = makeReceipt({
      id: 'shop-gyomu',
      merchantNormalized: '業務スーパー',
      merchantRaw: '業務スーパー',
      transactionAt: base,
      items: [{ name: '卵', lineTotal: 198, quantity: 1 }],
      total: 198,
    });
    const r2 = makeReceipt({
      id: 'shop-york',
      merchantNormalized: 'ヨークベニマル',
      merchantRaw: 'ヨークベニマル',
      transactionAt: base + 33 * 60_000,
      items: [{ name: '牛乳', lineTotal: 218, quantity: 1 }],
      total: 218,
    });
    const candidates = buildShoppingSessionCandidates([r1, r2]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.status).toBe('candidate');
    expect(candidates[0]!.receiptIds).toEqual(['shop-gyomu', 'shop-york']);
    expect(candidates[0]!.merchantKeys.length).toBe(2);
    expect(candidates[0]!.evidence).toContain(
      'shopping_session_candidate_only_not_confirmed'
    );
    expect(candidates[0]!.confidence).toBe('medium');
  });

  // 8. Stores far apart => not in same candidate
  test('8: receipts far apart on same day do not share one candidate', () => {
    const morning = Date.parse('2024-08-10T09:00:00+09:00');
    const evening = Date.parse('2024-08-10T20:00:00+09:00');
    const r1 = makeReceipt({
      id: 'far-a',
      merchantNormalized: '業務スーパー',
      transactionAt: morning,
      items: [{ name: 'a', lineTotal: 100, quantity: 1 }],
    });
    const r2 = makeReceipt({
      id: 'far-b',
      merchantNormalized: 'ヨークベニマル',
      transactionAt: evening,
      items: [{ name: 'b', lineTotal: 200, quantity: 1 }],
    });
    const candidates = buildShoppingSessionCandidates([r1, r2]);
    expect(candidates).toHaveLength(0);
  });
});

describe('Analysis Foundation A1 — representative quality', () => {
  test('prefers user-edited receipt over newer scan', () => {
    const at = Date.parse('2024-07-01T15:30:00+09:00');
    const items: FixtureItem[] = [{ name: '水', lineTotal: 100, quantity: 1 }];
    const edited = makeReceipt({
      id: 'edited',
      transactionAt: at,
      createdAt: at - 120_000,
      userEdited: 1,
      items,
      total: 100,
    });
    const newer = makeReceipt({
      id: 'newer',
      transactionAt: at,
      createdAt: at,
      items,
      total: 100,
    });
    const summaries = [edited, newer].map(summarizeReceiptForDuplicateAudit);
    const rep = pickCanonicalRepresentativeReceipt([edited, newer], summaries);
    expect(rep.id).toBe('edited');
  });
});

describe('Analysis Foundation A1 — canonical merchant', () => {
  test('Costco variants resolve to same retailerKey', () => {
    const costcoJa = makeReceipt({
      id: 'c1',
      merchantRaw: 'コストコ ホールセール',
      merchantNormalized: 'コストコ',
      transactionAt: Date.now(),
      items: [{ name: 'x', lineTotal: 1, quantity: 1 }],
    });
    const costcoEn = makeReceipt({
      id: 'c2',
      merchantRaw: 'Costco Wholesale',
      merchantNormalized: 'Costco Wholesale',
      transactionAt: Date.now(),
      items: [{ name: 'x', lineTotal: 1, quantity: 1 }],
    });
    const m1 = deriveCanonicalMerchant(costcoJa);
    const m2 = deriveCanonicalMerchant(costcoEn);
    expect(m1.retailerKey).toBe('costco');
    expect(m2.retailerKey).toBe('costco');
  });
});

describe('Analysis Foundation A1 — purchase cycle eligibility', () => {
  test('duplicate extra receipt is ineligible for purchase cycle', () => {
    const at = Date.parse('2024-06-01T14:00:00+09:00');
    const items: FixtureItem[] = [{ name: '卵', lineTotal: 200, quantity: 1 }];
    const r1 = makeReceipt({ id: 'pc-a', transactionAt: at, items, total: 200 });
    const r2 = makeReceipt({ id: 'pc-b', transactionAt: at, items, total: 200 });
    const groups = buildCanonicalReceiptGroups([r1, r2]);
    const extraId = groups[0]!.sourceReceiptIds.find(
      (id) => id !== groups[0]!.representativeReceipt.id
    )!;
    const extra = [r1, r2].find((r) => r.id === extraId)!;
    const cycle = evaluatePurchaseCycleEligibility({
      receipt: extra,
      canonicalGroups: groups,
      itemIdentityConfidence: 0.9,
      merchantProductId: 'mp_test',
    });
    expect(cycle.eligible).toBe(false);
    expect(cycle.reasonCodes).toContain('duplicate_receipt_extra');
  });

  test('A1.1: date_only transaction_at is eligible for day-level purchase cycle', () => {
    // Asia/Tokyo midnight → date_only (valid calendar date, no clock time)
    const dateOnly = Date.parse('2024-06-01T00:00:00+09:00');
    const receipt = makeReceipt({
      id: 'pc-date-only',
      transactionAt: dateOnly,
      items: [{ name: '卵', lineTotal: 200, quantity: 1 }],
      total: 200,
    });
    const groups = buildCanonicalReceiptGroups([receipt]);
    const cycle = evaluatePurchaseCycleEligibility({
      receipt,
      canonicalGroups: groups,
      itemIdentityConfidence: 0.9,
      merchantProductId: 'mp_test',
    });
    expect(cycle.eligible).toBe(true);
    expect(cycle.temporalPrecision).toBe('date_only');
    expect(cycle.reasonCodes).not.toContain('transaction_at_missing');
  });

  test('A1.1: exact_time preserves temporalPrecision metadata', () => {
    const at = Date.parse('2024-06-01T14:22:00+09:00');
    const receipt = makeReceipt({
      id: 'pc-exact',
      transactionAt: at,
      items: [{ name: '卵', lineTotal: 200, quantity: 1 }],
      total: 200,
    });
    const groups = buildCanonicalReceiptGroups([receipt]);
    const cycle = evaluatePurchaseCycleEligibility({
      receipt,
      canonicalGroups: groups,
      itemIdentityConfidence: 0.9,
      merchantProductId: 'mp_test',
    });
    expect(cycle.eligible).toBe(true);
    expect(cycle.temporalPrecision).toBe('exact_time');
  });

  test('A1.1: date_only excluded from shopping-session proximity', () => {
    const dateOnly = Date.parse('2024-08-10T00:00:00+09:00');
    const exact = Date.parse('2024-08-10T18:26:00+09:00');
    const r1 = makeReceipt({
      id: 'date-only-sess',
      merchantNormalized: '業務スーパー',
      transactionAt: dateOnly,
      items: [{ name: 'a', lineTotal: 100, quantity: 1 }],
    });
    const r2 = makeReceipt({
      id: 'exact-sess',
      merchantNormalized: 'ヨークベニマル',
      transactionAt: exact,
      items: [{ name: 'b', lineTotal: 200, quantity: 1 }],
    });
    const candidates = buildShoppingSessionCandidates([r1, r2]);
    expect(candidates).toHaveLength(0);
  });
});

describe('Analysis Foundation A1.1 — shopping session anti-chaining', () => {
  test('10:00 / 11:50 / 13:40 must NOT all become one session', () => {
    const t1000 = Date.parse('2024-08-10T10:00:00+09:00');
    const t1150 = Date.parse('2024-08-10T11:50:00+09:00');
    const t1340 = Date.parse('2024-08-10T13:40:00+09:00');
    const r1 = makeReceipt({
      id: 'span-a',
      merchantNormalized: '業務スーパー',
      transactionAt: t1000,
      items: [{ name: 'a', lineTotal: 100, quantity: 1 }],
    });
    const r2 = makeReceipt({
      id: 'span-b',
      merchantNormalized: 'ヨークベニマル',
      transactionAt: t1150,
      items: [{ name: 'b', lineTotal: 200, quantity: 1 }],
    });
    const r3 = makeReceipt({
      id: 'span-c',
      merchantNormalized: 'イオン',
      transactionAt: t1340,
      items: [{ name: 'c', lineTotal: 300, quantity: 1 }],
    });
    const candidates = buildShoppingSessionCandidates([r1, r2, r3]);
    expect(candidates.every((c) => c.status === 'candidate')).toBe(true);
    const allThreeTogether = candidates.some(
      (c) =>
        c.receiptIds.includes('span-a') &&
        c.receiptIds.includes('span-b') &&
        c.receiptIds.includes('span-c')
    );
    expect(allThreeTogether).toBe(false);
    // 10:00–11:50 span 110 ≤ 180 → one candidate; 13:40 starts new (alone → no pair)
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.receiptIds).toEqual(['span-a', 'span-b']);
  });

  test('18:26 / 18:59 remain one candidate', () => {
    const t1826 = Date.parse('2024-08-10T18:26:00+09:00');
    const t1859 = Date.parse('2024-08-10T18:59:00+09:00');
    const r1 = makeReceipt({
      id: 'near-a',
      merchantNormalized: '業務スーパー',
      transactionAt: t1826,
      items: [{ name: 'a', lineTotal: 100, quantity: 1 }],
    });
    const r2 = makeReceipt({
      id: 'near-b',
      merchantNormalized: 'ヨークベニマル',
      transactionAt: t1859,
      items: [{ name: 'b', lineTotal: 200, quantity: 1 }],
    });
    const candidates = buildShoppingSessionCandidates([r1, r2]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.status).toBe('candidate');
    expect(candidates[0]!.receiptIds).toEqual(['near-a', 'near-b']);
  });
});

describe('Analysis Foundation A1 — snapshot', () => {
  test('buildAnalysisFoundationSnapshot is deterministic', () => {
    const r = makeReceipt({
      id: 'snap-1',
      transactionAt: Date.parse('2024-01-01T12:00:00+09:00'),
      items: [{ name: 'a', lineTotal: 50, quantity: 1 }],
    });
    const a = buildAnalysisFoundationSnapshot([r]);
    const b = buildAnalysisFoundationSnapshot([r]);
    expect(a.version).toBe(b.version);
    expect(a.canonicalReceiptGroups[0]!.ephemeralSnapshotGroupId).toBe(
      b.canonicalReceiptGroups[0]!.ephemeralSnapshotGroupId
    );
  });

  test('A1.1: ephemeralSnapshotGroupId changes when membership changes', () => {
    const at = Date.parse('2024-06-01T14:22:33+09:00');
    const items: FixtureItem[] = [
      { name: '牛乳', lineTotal: 198, quantity: 1 },
      { name: 'パン', lineTotal: 128, quantity: 1 },
    ];
    const r1 = makeReceipt({
      id: 'mem-a',
      transactionAt: at,
      total: 326,
      items,
    });
    const r2 = makeReceipt({
      id: 'mem-b',
      transactionAt: at,
      total: 326,
      createdAt: at + 1000,
      items,
    });
    const alone = buildCanonicalReceiptGroups([r1]);
    const together = buildCanonicalReceiptGroups([r1, r2]);
    expect(alone[0]!.ephemeralSnapshotGroupId).not.toBe(
      together[0]!.ephemeralSnapshotGroupId
    );
  });

  test('A1.2: snapshot includes receiptAmountBasisAssessments', () => {
    const r = makeReceipt({
      id: 'snap-basis',
      transactionAt: Date.parse('2024-01-01T12:00:00+09:00'),
      items: [{ name: 'a', lineTotal: 2442, quantity: 1 }],
      tax: 195,
      total: 2637,
      taxIsKnown: 1,
    });
    const snap = buildAnalysisFoundationSnapshot([r]);
    expect(snap.receiptAmountBasisAssessments).toHaveLength(1);
    expect(snap.receiptAmountBasisAssessments[0]!.basis).toBe('tax_excluded');
  });
});

describe('Analysis Foundation A1.2 — amount basis', () => {
  test('1: tax-excluded (Aeon-style 2442 + 195 = 2637)', () => {
    const r = makeReceipt({
      id: 'aeon',
      merchantNormalized: 'イオン',
      items: [{ name: 'merchandise', lineTotal: 2442, quantity: 1 }],
      tax: 195,
      total: 2637,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('tax_excluded');
    expect(a.analyticsItemSum).toBe(2442);
    expect(a.confidence).not.toBe('unknown');
  });

  test('2: tax-included (York-style sum=total with positive tax)', () => {
    const r = makeReceipt({
      id: 'york',
      merchantNormalized: 'ヨークベニマル',
      items: [{ name: 'merchandise', lineTotal: 3352, quantity: 1 }],
      tax: 248,
      total: 3352,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('tax_included');
    expect(a.analyticsItemSum).toBe(3352);
  });

  test('3: tax=0 and item sum = total => unknown (not tax_included)', () => {
    const r = makeReceipt({
      id: 'zero-tax',
      items: [{ name: 'x', lineTotal: 1000, quantity: 1 }],
      tax: 0,
      total: 1000,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('tax_non_positive_cannot_discriminate');
  });

  test('4: neither equation closes => unknown', () => {
    const r = makeReceipt({
      id: 'open',
      items: [{ name: 'x', lineTotal: 1000, quantity: 1 }],
      tax: 100,
      total: 1500,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('neither_hypothesis_closes');
  });

  test('5: both hypotheses close within tolerance => unknown/ambiguous', () => {
    // tax=1 within tol=2: included (100≈100) and excluded (100+1≈100) both close
    const r = makeReceipt({
      id: 'ambig',
      items: [{ name: 'x', lineTotal: 100, quantity: 1 }],
      tax: 1,
      total: 100,
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    expect(a.basis).toBe('unknown');
    expect(a.reasonCodes).toContain('ambiguous_both_hypotheses_close');
  });

  test('6: discounted receipt uses effective amounts + unallocated once', () => {
    // Bound discount via OCR allocation (or remainder) — never double-subtract
    const r = makeReceipt({
      id: 'disc-bound',
      items: [
        {
          name: 'ファンタ',
          lineTotal: 210,
          quantity: 1,
          effectiveLineTotal: 203,
          discountAllocated: -7,
        },
      ],
      discounts: [{ label: 'まとめ売り値引', amount: -7 }],
      tax: 15,
      total: 218, // 203 + 15 tax_excluded
      taxIsKnown: 1,
    });
    const a = assessReceiptAmountBasis(r);
    // Coherent OCR view: allocated effective OR gross+remainder, not both
    expect(a.analyticsItemSum + a.unallocatedDiscountTotal).toBe(203);
    expect(a.basis).toBe('tax_excluded');

    // Receipt-level unallocated coupon: do not double-subtract from analytics sum
    const r2 = makeReceipt({
      id: 'disc-unalloc',
      items: [{ name: '牛乳', lineTotal: 1000, quantity: 1 }],
      discounts: [{ label: 'レシートクーポン', amount: -100 }],
      tax: 72,
      total: 972, // 1000 - 100 + 72
      taxIsKnown: 1,
    });
    const a2 = assessReceiptAmountBasis(r2);
    expect(a2.analyticsItemSum).toBe(1000);
    expect(a2.unallocatedDiscountTotal).toBe(-100);
    expect(a2.basis).toBe('tax_excluded');
  });

  test('7: user-edited amounts/total follow precedence', () => {
    const r = makeReceipt({
      id: 'user-edit',
      items: [{ name: 'ocr', lineTotal: 2442, quantity: 1 }],
      tax: 195,
      total: 2637,
      taxIsKnown: 1,
      userEdited: 1,
      finalTotal: 3352,
      userItems: [
        {
          name: 'edited',
          lineTotal: 3352,
          quantity: 1,
          amountUserEdited: true,
        },
      ],
    });
    // With user items sum 3352 + tax 195 would be excluded→3547 ≠ 3352 final
    // included: 3352 ≈ 3352 → tax_included using final_total + user_items
    const a = assessReceiptAmountBasis(r);
    expect(a.receiptTotal).toBe(3352);
    expect(a.analyticsItemSum).toBe(3352);
    expect(a.basis).toBe('tax_included');
    expect(a.evidence).toContain('paid_total_from_final_total');
  });

  test('8: price comparison tax_included vs tax_excluded => amount_basis_mismatch', () => {
    const result = evaluatePriceComparisonEligibility({
      self: side({ amountEvidence: trustedIncluded }),
      peer: side({ amountEvidence: trustedExcluded }),
    });
    expect(result.eligible).toBe(false);
    expect(result.reasonCodes).toContain('amount_basis_mismatch');
  });

  test('9: known vs unknown => amount_basis_unknown', () => {
    const result = evaluatePriceComparisonEligibility({
      self: side({ amountEvidence: trustedIncluded }),
      peer: side({
        amountEvidence: {
          basis: 'unknown',
          confidence: 'unknown',
          taxProvenance: 'untrusted',
        },
      }),
    });
    expect(result.eligible).toBe(false);
    expect(
      result.reasonCodes.some((c) =>
        c === 'amount_basis_unknown' || c === 'peer_amount_basis_unknown'
      )
    ).toBe(true);
  });

  test('10: same known basis passes amount-basis gate but still needs identity', () => {
    const basisOk = evaluatePriceComparisonEligibility({
      self: side({ amountEvidence: trustedExcluded }),
      peer: side({ amountEvidence: trustedExcluded }),
    });
    expect(basisOk.reasonCodes).not.toContain('amount_basis_mismatch');
    expect(basisOk.reasonCodes).not.toContain('amount_basis_unknown');
    expect(basisOk.eligible).toBe(true);

    const identityFail = evaluatePriceComparisonEligibility({
      self: side({
        rawName: '不明',
        identityConfidence: 0,
        identitySource: 'unknown',
        merchantProductId: null,
        amountEvidence: trustedExcluded,
      }),
      peer: side({ amountEvidence: trustedExcluded }),
    });
    expect(identityFail.reasonCodes).not.toContain('amount_basis_mismatch');
    expect(identityFail.reasonCodes).toContain('identity_unresolved');
    expect(identityFail.eligible).toBe(false);
  });

  test('11: mixed 8%/10% without item tax rate does not fake per-item normalization', () => {
    const obs = buildMonetaryObservation({
      rawAmount: 1080,
      effectiveAmount: 1080,
      taxBasis: 'tax_included',
      itemTaxRatePercent: null,
      confidence: 'high',
    });
    expect(obs.normalizedGrossAmount).toBe(1080);
    expect(obs.normalizedNetAmount).toBeNull();
    expect(obs.evidence).toContain('no_proportional_receipt_tax_split');
    expect(obs.evidence).toContain('normalized_net_null_without_item_tax_rate');

    const excluded = buildMonetaryObservation({
      rawAmount: 1000,
      effectiveAmount: 1000,
      taxBasis: 'tax_excluded',
    });
    expect(excluded.normalizedNetAmount).toBe(1000);
    expect(excluded.normalizedGrossAmount).toBeNull();
  });
});

describe('Analysis Foundation A1.3 — semantic rescan reconciliation', () => {
  const txAt = Date.parse('2024-08-15T18:42:11+09:00');

  test('022 synthetic fixture collapses to 1 physical group; tax-known wins representative', () => {
    const frontTarget = 2707;
    const frontItems: FixtureItem[] = Array.from({ length: 9 }, (_, i) => ({
      name: `Shared Item ${i + 1}`,
      lineTotal: i < 8 ? 300 : frontTarget - 300 * 8,
      quantity: 1,
    }));
    const itemsA: FixtureItem[] = [
      ...frontItems,
      { name: 'Battery AA', lineTotal: 393, quantity: 4 },
      { name: 'Battery AAA', lineTotal: 393, quantity: 4 },
      { name: 'Product X', lineTotal: 794, quantity: 1 },
    ];
    const itemsB: FixtureItem[] = [
      ...frontItems,
      { name: 'Battery AA 4-count', lineTotal: 393, quantity: 1 },
      { name: 'Battery AAA 4-count', lineTotal: 393, quantity: 1 },
      { name: 'Product X', lineTotal: 794, quantity: 2 },
    ];
    const rA = makeReceipt({
      id: '022-a',
      merchantNormalized: 'Merchant A',
      transactionAt: txAt,
      createdAt: txAt,
      total: 4287,
      taxIsKnown: 0,
      items: itemsA,
    });
    const rB = makeReceipt({
      id: '022-b',
      merchantNormalized: 'Merchant A',
      transactionAt: txAt,
      createdAt: txAt + 10_000,
      total: 4287,
      tax: 330,
      taxIsKnown: 1,
      items: itemsB,
    });
    const groups = buildCanonicalReceiptGroups([rA, rB]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.duplicateCount).toBe(1);
    expect(groups[0]!.sourceReceiptIds).toEqual(['022-a', '022-b']);
    expect(groups[0]!.confidence).toBe('SEMANTIC_RESCAN_EXACT_DUPLICATE');
    expect(groups[0]!.representativeReceipt.id).toBe('022-b');
    expect(
      groups[0]!.evidence.some((e) =>
        e.includes('observation_quantity_conflict')
      )
    ).toBe(true);

    const summaries = [rA, rB].map(summarizeReceiptForDuplicateAudit);
    const scoreB = pickCanonicalRepresentativeReceipt([rA, rB], summaries);
    expect(scoreB.id).toBe('022-b');
  });

  test('adversarial: different names with same line amounts stay distinct', () => {
    const rA = makeReceipt({
      id: 'adv-a',
      merchantNormalized: 'Merchant A',
      transactionAt: txAt,
      total: 794,
      items: [{ name: 'Product A', lineTotal: 794, quantity: 1 }],
    });
    const rB = makeReceipt({
      id: 'adv-b',
      merchantNormalized: 'Merchant A',
      transactionAt: txAt,
      total: 794,
      tax: 60,
      taxIsKnown: 1,
      items: [{ name: 'Product B', lineTotal: 794, quantity: 2 }],
    });
    const groups = buildCanonicalReceiptGroups([rA, rB]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.duplicateCount === 0)).toBe(true);
  });

  test('same names qty disagreement => one purchase event for cycle eligibility', () => {
    const rA = makeReceipt({
      id: 'cycle-a',
      merchantNormalized: 'Merchant A',
      transactionAt: txAt,
      total: 794,
      items: [{ name: 'Product X', lineTotal: 794, quantity: 1 }],
    });
    const rB = makeReceipt({
      id: 'cycle-b',
      merchantNormalized: 'Merchant A',
      transactionAt: txAt,
      createdAt: txAt + 1,
      total: 794,
      tax: 60,
      taxIsKnown: 1,
      items: [{ name: 'Product X', lineTotal: 794, quantity: 2 }],
    });
    const groups = buildCanonicalReceiptGroups([rA, rB]);
    expect(groups).toHaveLength(1);
    const extra = groups[0]!.representativeReceipt.id === 'cycle-a' ? rB : rA;
    const cycle = evaluatePurchaseCycleEligibility({
      receipt: extra,
      canonicalGroups: groups,
      itemIdentityConfidence: 0.9,
      itemIdentitySource: 'merchant_exact',
      merchantProductId: 'mp_x',
    });
    expect(cycle.reasonCodes).toContain('duplicate_receipt_extra');
  });
});
