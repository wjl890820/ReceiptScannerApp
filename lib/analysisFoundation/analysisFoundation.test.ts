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
  buildShoppingSessionCandidates,
  consolidateReceiptBasket,
  deriveCanonicalMerchant,
  evaluatePriceComparisonEligibility,
  evaluatePurchaseCycleEligibility,
  pickCanonicalRepresentativeReceipt,
} from './index';
import { summarizeReceiptForDuplicateAudit } from '../analysisDDuplicateAudit';

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
};

function makeReceipt(args: {
  id: string;
  merchantNormalized?: string;
  merchantRaw?: string;
  transactionAt?: number | null;
  createdAt?: number;
  total?: number;
  items: FixtureItem[];
  userEdited?: number;
  currency?: string;
}): ReceiptRow {
  const itemSum = args.items.reduce(
    (s, it) => s + (it.lineTotal ?? 0),
    0
  );
  return {
    id: args.id,
    created_at: args.createdAt ?? args.transactionAt ?? Date.now(),
    transaction_at:
      args.transactionAt === undefined ? Date.now() : args.transactionAt,
    image_uri: '',
    total: args.total ?? itemSum,
    tax: 0,
    tax_is_known: 0,
    currency: args.currency ?? 'JPY',
    analysis_json: JSON.stringify({ items: args.items }),
    merchant_raw: args.merchantRaw ?? args.merchantNormalized ?? 'イオン',
    merchant_normalized: args.merchantNormalized ?? 'イオン',
    merchant_type: 'supermarket',
    user_edited: args.userEdited ?? 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
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
      rawName: '不明商品',
      quantity: 1,
      lineTotal: 100,
      currency: 'JPY',
      identityConfidence: 0,
      identitySource: 'unknown',
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
});
