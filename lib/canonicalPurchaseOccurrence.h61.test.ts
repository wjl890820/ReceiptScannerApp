/**
 * Home Performance H6.1 — exact occurrence pair candidate generation.
 *
 * Candidate families are a SUPERSET of every pair that can evaluate true.
 * The production evaluator remains authoritative.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from './db';
import {
  __getLastCanonicalPurchaseOccurrencePrepareStatsForTests,
  __prepareCanonicalPurchaseOccurrenceEvidenceAllPairsForTests,
  __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests,
  buildCanonicalPurchaseOccurrenceIndex,
  buildCanonicalPurchaseOccurrenceIndexFromPrepared,
  evaluateCanonicalPurchaseOccurrencePair,
  isPreparedOccurrencePairQualified,
  prepareCanonicalPurchaseOccurrenceEvidence,
  type CanonicalPurchaseOccurrenceIndex,
  type CanonicalPurchaseOccurrencePreparedEvidence,
} from './canonicalPurchaseOccurrence';
import { summarizeReceiptForDuplicateAudit } from './analysisDDuplicateAudit';
import { filterV1SupportedReceipts } from './merchantType';

const TX = Date.parse('2026-07-06T11:44:46+09:00');
const TX_ALT = Date.parse('2026-07-06T12:00:00+09:00');

function makeReceipt(
  id: string,
  opts: {
    transactionAt?: number | null;
    transactionTimePrecision?: 'second' | 'minute' | 'date' | 'unknown';
    createdAt?: number;
    merchant?: string;
    merchantNormalized?: string;
    total?: number;
    tax?: number;
    taxKnown?: boolean;
    items?: unknown[];
    currency?: string | null;
  } = {}
): ReceiptRow {
  const items = opts.items ?? [
    { name: 'KS ORGANIC MILK', quantity: 1, lineTotal: 418 },
    { name: 'ROTISSERIE CHICKEN', quantity: 1, lineTotal: 698 },
  ];
  const total =
    opts.total ??
    (items as Array<{ lineTotal: number }>).reduce((s, i) => s + i.lineTotal, 0);
  const taxKnown = opts.taxKnown !== false;
  const txAt = opts.transactionAt === undefined ? TX : opts.transactionAt;
  const precision =
    opts.transactionTimePrecision ?? (txAt == null ? 'unknown' : 'second');
  const currency = opts.currency === undefined ? 'JPY' : opts.currency;
  const analysis: Record<string, unknown> = {
    merchant: opts.merchant ?? 'コストコ',
    total,
    tax: opts.tax ?? 100,
    tax_is_known: taxKnown,
    currency,
    is_grocery: true,
    merchant_type: 'supermarket',
    items,
    transaction_time_precision: precision,
  };
  if (precision === 'second' && txAt != null) {
    analysis.transactionDate = '2026-07-06 11:44:46';
  } else if (precision === 'minute' && txAt != null) {
    analysis.transactionDate = '2026-07-06 11:44';
  }
  return {
    id,
    created_at: opts.createdAt ?? 2_000,
    transaction_at: txAt,
    transaction_time_precision: precision,
    image_uri: '',
    merchant_raw: opts.merchant ?? 'コストコ',
    merchant_normalized: opts.merchantNormalized ?? opts.merchant ?? 'コストコ',
    merchant_type: 'supermarket',
    total,
    tax: opts.tax ?? 100,
    tax_is_known: taxKnown ? 1 : 0,
    currency: currency ?? 'JPY',
    analysis_json: JSON.stringify(analysis),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  };
}

function qualifiedPairSet(
  prepared: CanonicalPurchaseOccurrencePreparedEvidence
): string[] {
  const out: string[] = [];
  for (const [lo, his] of prepared.qualifiedPairs.entries()) {
    for (const hi of his) {
      out.push(`${lo}\0${hi}`);
    }
  }
  return out.sort();
}

function indexFingerprint(index: CanonicalPurchaseOccurrenceIndex) {
  return {
    occurrenceIdByReceiptId: [...index.occurrenceIdByReceiptId.entries()].sort(
      (a, b) => a[0].localeCompare(b[0])
    ),
    representativeReceiptIdByOccurrenceId: [
      ...index.representativeReceiptIdByOccurrenceId.entries(),
    ].sort((a, b) => a[0].localeCompare(b[0])),
    representativeReceiptIdByReceiptId: [
      ...index.representativeReceiptIdByReceiptId.entries(),
    ].sort((a, b) => a[0].localeCompare(b[0])),
    groups: index.groups.map((g) => ({
      occurrenceId: g.occurrenceId,
      receiptIds: [...g.receiptIds],
      representativeReceiptId: g.representativeReceiptId,
    })),
  };
}

function assertPreparedEqualsOracle(H: ReceiptRow[]) {
  const optimized = prepareCanonicalPurchaseOccurrenceEvidence(H);
  const baseline = __prepareCanonicalPurchaseOccurrenceEvidenceAllPairsForTests(
    H
  );
  const optPairs = qualifiedPairSet(optimized);
  const basePairs = qualifiedPairSet(baseline);
  if (optPairs.join('|') !== basePairs.join('|')) {
    const missing = basePairs.filter((p) => !optPairs.includes(p));
    const extra = optPairs.filter((p) => !basePairs.includes(p));
    throw new Error(
      `H6.1 false-negative/positive sentinel missing=[${missing.join(',')}] extra=[${extra.join(',')}]`
    );
  }
  expect(optPairs).toEqual(basePairs);

  const stats = __getLastCanonicalPurchaseOccurrencePrepareStatsForTests();
  expect(stats).not.toBeNull();
  expect(stats!.pairEvaluationCount).toBe(stats!.candidatePairCount);
  expect(stats!.pairEvaluationCount).toBeLessThanOrEqual(
    stats!.theoreticalPairCount
  );
  expect(stats!.qualifiedPairCount).toBe(optPairs.length);

  expect(indexFingerprint(buildCanonicalPurchaseOccurrenceIndexFromPrepared(H, optimized))).toEqual(
    indexFingerprint(buildCanonicalPurchaseOccurrenceIndexFromPrepared(H, baseline))
  );
  expect(indexFingerprint(buildCanonicalPurchaseOccurrenceIndex(H))).toEqual(
    indexFingerprint(buildCanonicalPurchaseOccurrenceIndexFromPrepared(H, optimized))
  );
}

beforeEach(() => {
  __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests();
});

describe('H6.1 — exact candidate generation', () => {
  it('sparse unique timestamps: evaluation count << theoretical pairs', () => {
    const H: ReceiptRow[] = [];
    for (let i = 0; i < 24; i += 1) {
      H.push(
        makeReceipt(`sparse-${i}`, {
          createdAt: i + 1,
          transactionAt: TX + i * 60_000,
          total: 1000 + i,
          items: [{ name: `ITEM-${i}`, quantity: 1, lineTotal: 1000 + i }],
        })
      );
    }
    const n = H.length;
    const theoretical = (n * (n - 1)) / 2;
    assertPreparedEqualsOracle(H);
    const stats = __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()!;
    expect(stats.theoreticalPairCount).toBe(theoretical);
    // Distinct second timestamps → Family B empty; distinct content → Family A empty.
    expect(stats.candidatePairCount).toBe(0);
    expect(stats.pairEvaluationCount).toBe(0);
    expect(stats.pairEvaluationCount).toBeLessThan(theoretical / 4);
  });

  it('dense shared fingerprint: may evaluate all pairs; truth identical', () => {
    // Force identical analysis payloads so content fingerprints collide.
    const base = makeReceipt('dense-0', { createdAt: 1 });
    const H = [base];
    for (let i = 1; i < 6; i += 1) {
      H.push({
        ...base,
        id: `dense-${i}`,
        created_at: i + 1,
      });
    }
    const n = H.length;
    assertPreparedEqualsOracle(H);
    const stats = __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()!;
    expect(stats.candidatePairCount).toBe((n * (n - 1)) / 2);
    expect(stats.pairEvaluationCount).toBe((n * (n - 1)) / 2);
  });

  it('candidate-family overlap evaluates a pair exactly once', () => {
    // Same second timestamp AND identical content → both families admit the pair.
    const a = makeReceipt('overlap-a', { createdAt: 1 });
    const b = { ...a, id: 'overlap-b', created_at: 2 };
    assertPreparedEqualsOracle([a, b]);
    const stats = __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()!;
    expect(stats.theoreticalPairCount).toBe(1);
    expect(stats.candidatePairCount).toBe(1);
    expect(stats.pairEvaluationCount).toBe(1);
  });

  it('fingerprint match with different total/timestamp/currency still covered', () => {
    const a = makeReceipt('fp-a', {
      createdAt: 1,
      transactionAt: TX,
      total: 1116,
      currency: 'JPY',
    });
    const b = makeReceipt('fp-b', {
      createdAt: 2,
      transactionAt: TX_ALT,
      total: 9999,
      currency: 'USD',
      items: [
        { name: 'KS ORGANIC MILK', quantity: 1, lineTotal: 418 },
        { name: 'ROTISSERIE CHICKEN', quantity: 1, lineTotal: 698 },
      ],
    });
    // Clone analysis so fingerprints match despite header drift on row fields.
    const twin = {
      ...b,
      analysis_json: a.analysis_json,
      total: 9999,
      currency: 'USD',
      transaction_at: TX_ALT,
    };
    // Summaries read analysis_json for fingerprint — force equal fingerprints via same analysis.
    const summaries = [
      summarizeReceiptForDuplicateAudit(a),
      summarizeReceiptForDuplicateAudit({
        ...twin,
        analysis_json: a.analysis_json,
      }),
    ];
    // If fingerprints differ in this fixture, still require oracle equality on prepare.
    void summaries;
    assertPreparedEqualsOracle([
      a,
      {
        ...twin,
        analysis_json: a.analysis_json,
      },
    ]);
  });

  it('precision variants + missing fields: oracle equality', () => {
    const H = [
      makeReceipt('sec', { transactionTimePrecision: 'second' }),
      makeReceipt('min', {
        transactionTimePrecision: 'minute',
        transactionAt: TX,
      }),
      makeReceipt('date', {
        transactionTimePrecision: 'date',
        transactionAt: TX,
      }),
      makeReceipt('unk', {
        transactionTimePrecision: 'unknown',
        transactionAt: null,
      }),
      makeReceipt('miss-tx', { transactionAt: null }),
      makeReceipt('zero-total', { total: 0, items: [] }),
      makeReceipt('other-cur', {
        currency: 'USD',
        transactionAt: TX_ALT,
        total: 50,
        items: [{ name: 'X', quantity: 1, lineTotal: 50 }],
      }),
    ];
    assertPreparedEqualsOracle(H);
  });

  it('mixed-case IDs + reordered input preserve qualified set and F(H)', () => {
    const lower = makeReceipt('a-receipt', { createdAt: 1 });
    const upper = makeReceipt('Z-receipt', { createdAt: 2 });
    assertPreparedEqualsOracle([upper, lower]);
    assertPreparedEqualsOracle([lower, upper]);
  });

  it('non-transitive complete-link graph preserved', () => {
    // A~B and B~C via shared exact second + strong basket; A~C fails merchant/total.
    const items = [
      { name: 'GREEN CURRY', quantity: 1, lineTotal: 88 },
      { name: 'CHOPSTICKS', quantity: 1, lineTotal: 386 },
    ];
    const tx = Date.parse('2026-06-30T13:36:00+09:00');
    const a = makeReceipt('branch-a', {
      transactionAt: tx,
      merchant: '業務スーパー 一吉店',
      merchantNormalized: '業務スーパー 一吉店',
      total: 474,
      tax: 61,
      items,
      createdAt: 1,
    });
    const b = makeReceipt('generic-b', {
      transactionAt: tx,
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
      total: 474,
      tax: 61,
      items,
      createdAt: 2,
    });
    const c = makeReceipt('branch-c', {
      transactionAt: tx,
      merchant: '業務スーパー 別店',
      merchantNormalized: '業務スーパー 別店',
      total: 474,
      tax: 61,
      items,
      createdAt: 3,
    });
    assertPreparedEqualsOracle([a, b, c]);
    const index = buildCanonicalPurchaseOccurrenceIndex([a, b, c]);
    // Baseline complete-link must not merge conflicting branches via generic.
    expect(index.groups.length).toBeGreaterThanOrEqual(2);
  });

  it('F(V) from optimized P(H) equals baseline P(H) for subsets', () => {
    const outside = makeReceipt('aaa-out', {
      createdAt: 1,
      merchant: 'OTHER',
      merchantNormalized: 'OTHER',
      items: [{ name: 'X', quantity: 1, lineTotal: 10 }],
      total: 10,
      transactionAt: TX_ALT,
    });
    const insideA = makeReceipt('bbb-in', { createdAt: 5 });
    const insideB = { ...insideA, id: 'ccc-in', created_at: 6 };
    const H = [outside, insideA, insideB];
    const opt = prepareCanonicalPurchaseOccurrenceEvidence(H);
    const base = __prepareCanonicalPurchaseOccurrenceEvidenceAllPairsForTests(H);
    expect(qualifiedPairSet(opt)).toEqual(qualifiedPairSet(base));

    const V = filterV1SupportedReceipts(H);
    expect(
      indexFingerprint(buildCanonicalPurchaseOccurrenceIndexFromPrepared(V, opt))
    ).toEqual(
      indexFingerprint(buildCanonicalPurchaseOccurrenceIndexFromPrepared(V, base))
    );
    expect(
      indexFingerprint(buildCanonicalPurchaseOccurrenceIndexFromPrepared([insideA], opt))
    ).toEqual(
      indexFingerprint(
        buildCanonicalPurchaseOccurrenceIndexFromPrepared([insideA], base)
      )
    );
  });

  it('seeded randomized universes: oracle equality + F(V)', () => {
    let seed = 0xc0ffee;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let trial = 0; trial < 12; trial += 1) {
      const n = 4 + Math.floor(rand() * 8);
      const H: ReceiptRow[] = [];
      for (let i = 0; i < n; i += 1) {
        const shareTx = rand() < 0.25;
        const shareItems = rand() < 0.3;
        H.push(
          makeReceipt(`r${trial}-${i}`, {
            createdAt: i + 1,
            transactionAt: shareTx ? TX : TX + Math.floor(rand() * 20) * 60_000,
            transactionTimePrecision:
              rand() < 0.1 ? 'minute' : rand() < 0.05 ? 'unknown' : 'second',
            total: shareItems ? 1116 : 100 + Math.floor(rand() * 500),
            merchant: rand() < 0.2 ? 'コストコ' : `店-${Math.floor(rand() * 5)}`,
            items: shareItems
              ? [
                  { name: 'KS ORGANIC MILK', quantity: 1, lineTotal: 418 },
                  { name: 'ROTISSERIE CHICKEN', quantity: 1, lineTotal: 698 },
                ]
              : [
                  {
                    name: `ITEM-${Math.floor(rand() * 10)}`,
                    quantity: 1,
                    lineTotal: 100 + Math.floor(rand() * 500),
                  },
                ],
          })
        );
      }
      assertPreparedEqualsOracle(H);
      const opt = prepareCanonicalPurchaseOccurrenceEvidence(H);
      const base = __prepareCanonicalPurchaseOccurrenceEvidenceAllPairsForTests(
        H
      );
      const subset = H.filter((_, idx) => idx % 2 === 0);
      if (subset.length > 0) {
        expect(
          indexFingerprint(
            buildCanonicalPurchaseOccurrenceIndexFromPrepared(subset, opt)
          )
        ).toEqual(
          indexFingerprint(
            buildCanonicalPurchaseOccurrenceIndexFromPrepared(subset, base)
          )
        );
      }
    }
  });

  it('representative tie-break fixtures unchanged vs oracle', () => {
    const items = [
      { name: 'A', quantity: 1, lineTotal: 100 },
      { name: 'B', quantity: 1, lineTotal: 200 },
    ];
    const early = makeReceipt('rep-early', {
      createdAt: 1,
      taxKnown: false,
      tax: 0,
      total: 300,
      items,
    });
    const lateTax = makeReceipt('rep-late-tax', {
      createdAt: 9,
      taxKnown: true,
      tax: 30,
      total: 300,
      items,
    });
    // Same object analysis for fingerprint+tx collision so they form one occurrence.
    const twin = {
      ...lateTax,
      analysis_json: early.analysis_json,
      transaction_at: early.transaction_at,
    };
    assertPreparedEqualsOracle([early, twin]);
  });

  it('evaluator remains pure: order of args does not change Boolean', () => {
    const a = summarizeReceiptForDuplicateAudit(makeReceipt('p1'));
    const b = summarizeReceiptForDuplicateAudit(
      makeReceipt('p2', { transactionAt: TX_ALT, total: 50, items: [{ name: 'Z', quantity: 1, lineTotal: 50 }] })
    );
    expect(evaluateCanonicalPurchaseOccurrencePair(a, b)).toBe(
      evaluateCanonicalPurchaseOccurrencePair(b, a)
    );
  });
});
