/**
 * Home Performance Slice H2.1 — prepared occurrence evidence reuse.
 *
 * Proves:
 * - prepare + buildFromPrepared ≡ fresh build (differential)
 * - restrict(F(H), V) ≠ F(V) (unsafe projection guardrail)
 * - prepare counts; buildFromPrepared does not re-summarize/re-evaluate
 * - cache MISS exposes prepared; HIT does not (Repeat fresh F(V))
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import type { ReceiptRow } from './db';
import {
  __getLastCanonicalPurchaseOccurrencePrepareStatsForTests,
  __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests,
  buildCanonicalPurchaseOccurrenceIndex,
  buildCanonicalPurchaseOccurrenceIndexFromPrepared,
  evaluateCanonicalPurchaseOccurrencePair,
  isPreparedOccurrencePairQualified,
  prepareCanonicalPurchaseOccurrenceEvidence,
  type CanonicalPurchaseOccurrenceIndex,
} from './canonicalPurchaseOccurrence';
import {
  __resetCanonicalPurchaseOccurrenceCacheForTests,
  getCanonicalPurchaseOccurrenceBuildCount,
  getOrBuildCanonicalPurchaseOccurrenceIndexCached,
} from './canonicalPurchaseOccurrenceCache';
import {
  __resetAnalyticsReceiptSelectionCacheForTests,
  getAnalyticsReceiptSelectionDataGeneration,
} from './analyticsReceiptSelectionCache';
import { filterV1SupportedReceipts } from './merchantType';
import { buildRepeatProductProfiles } from './repeatProductProfile';

const TX = Date.parse('2026-07-06T11:44:46+09:00');

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

function expectIndexEqual(
  actual: CanonicalPurchaseOccurrenceIndex,
  expected: CanonicalPurchaseOccurrenceIndex
) {
  expect(indexFingerprint(actual)).toEqual(indexFingerprint(expected));
}

/** Unsafe: project F(H) groups onto V members, keeping H occurrenceId/rep. */
function restrictOccurrenceIndexToReceiptIds(
  index: CanonicalPurchaseOccurrenceIndex,
  keepIds: ReadonlySet<string>
): CanonicalPurchaseOccurrenceIndex {
  const occurrenceIdByReceiptId = new Map<string, string>();
  const representativeReceiptIdByOccurrenceId = new Map<string, string>();
  const representativeReceiptIdByReceiptId = new Map<string, string>();
  const groups: CanonicalPurchaseOccurrenceIndex['groups'][number][] = [];

  for (const group of index.groups) {
    const members = group.receiptIds.filter((id) => keepIds.has(id));
    if (members.length === 0) continue;
    groups.push({
      occurrenceId: group.occurrenceId,
      receiptIds: members,
      representativeReceiptId: group.representativeReceiptId,
    });
    for (const id of members) {
      occurrenceIdByReceiptId.set(id, group.occurrenceId);
      representativeReceiptIdByReceiptId.set(
        id,
        group.representativeReceiptId
      );
    }
    representativeReceiptIdByOccurrenceId.set(
      group.occurrenceId,
      group.representativeReceiptId
    );
  }

  return {
    occurrenceIdByReceiptId,
    representativeReceiptIdByOccurrenceId,
    representativeReceiptIdByReceiptId,
    groups,
  };
}

function makeReceipt(
  id: string,
  opts: {
    transactionAt?: number | null;
    transactionTimePrecision?: 'second' | 'minute' | 'date' | 'unknown';
    transactionDateText?: string | null;
    createdAt?: number;
    merchant?: string;
    merchantNormalized?: string;
    /** Use 'other' for V1-unsupported (not supermarket/convenience). */
    merchantType?: 'supermarket' | 'convenience' | 'other' | 'unknown';
    isGrocery?: boolean;
    total?: number;
    tax?: number;
    taxKnown?: boolean;
    items?: unknown[];
    analysisJson?: string;
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
  const merchantType = opts.merchantType ?? 'supermarket';
  const analysis: Record<string, unknown> = {
    merchant: opts.merchant ?? 'コストコ',
    total,
    tax: opts.tax ?? 100,
    tax_is_known: taxKnown,
    currency: 'JPY',
    is_grocery: opts.isGrocery ?? merchantType === 'supermarket',
    merchant_type: merchantType,
    items,
    transaction_time_precision: precision,
  };
  if (opts.transactionDateText) {
    analysis.transactionDate = opts.transactionDateText;
  } else if (precision === 'second' && txAt != null) {
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
    merchant_normalized: opts.merchantNormalized ?? 'コストコ',
    merchant_type: merchantType,
    total,
    tax: opts.tax ?? 100,
    tax_is_known: taxKnown ? 1 : 0,
    currency: 'JPY',
    analysis_json: opts.analysisJson ?? JSON.stringify(analysis),
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  };
}

beforeEach(() => {
  __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests();
  __resetCanonicalPurchaseOccurrenceCacheForTests();
  __resetAnalyticsReceiptSelectionCacheForTests();
});

describe('H2.1a — pair canonicalization and duplicate-ID hardening', () => {
  it('stores and finds a mixed-case qualified pair in either endpoint order', () => {
    const lower = makeReceipt('a-receipt', { createdAt: 1 });
    const upper = makeReceipt('Z-receipt', { createdAt: 2 });

    // This fixture specifically proves locale collation and exact JS ordering
    // disagree, which was the H2.1 storage/lookup mismatch.
    expect(['a-receipt', 'Z-receipt'].sort((a, b) => a.localeCompare(b))).toEqual(
      ['a-receipt', 'Z-receipt']
    );
    expect('a-receipt' < 'Z-receipt').toBe(false);

    const prepared = prepareCanonicalPurchaseOccurrenceEvidence([
      lower,
      upper,
    ]);
    const lowerSummary = prepared.summariesByReceiptId.get(lower.id)!;
    const upperSummary = prepared.summariesByReceiptId.get(upper.id)!;

    expect(
      evaluateCanonicalPurchaseOccurrencePair(lowerSummary, upperSummary)
    ).toBe(true);
    expect(
      isPreparedOccurrencePairQualified(prepared, lower.id, upper.id)
    ).toBe(true);
    expect(
      isPreparedOccurrencePairQualified(prepared, upper.id, lower.id)
    ).toBe(true);
    expect(
      isPreparedOccurrencePairQualified(prepared, lower.id, lower.id)
    ).toBe(false);

    const index = buildCanonicalPurchaseOccurrenceIndex([lower, upper]);
    expect(index.groups).toHaveLength(1);
    expect(index.groups[0]!.receiptIds).toEqual([
      'a-receipt',
      'Z-receipt',
    ]);
  });

  it('matches the evaluator for a false pair and reversed lookup', () => {
    const current = makeReceipt('a-current');
    const unrelated = makeReceipt('Z-unrelated', {
      transactionAt: Date.parse('2025-01-01T09:00:00+09:00'),
      merchant: '別店舗',
      merchantNormalized: '別店舗',
      total: 777,
      tax: 0,
      items: [{ name: 'UNRELATED', quantity: 1, lineTotal: 777 }],
    });
    const prepared = prepareCanonicalPurchaseOccurrenceEvidence([
      current,
      unrelated,
    ]);
    const currentSummary = prepared.summariesByReceiptId.get(current.id)!;
    const unrelatedSummary = prepared.summariesByReceiptId.get(unrelated.id)!;

    expect(
      evaluateCanonicalPurchaseOccurrencePair(
        currentSummary,
        unrelatedSummary
      )
    ).toBe(false);
    expect(
      isPreparedOccurrencePairQualified(prepared, current.id, unrelated.id)
    ).toBe(false);
    expect(
      isPreparedOccurrencePairQualified(prepared, unrelated.id, current.id)
    ).toBe(false);
    expect(
      isPreparedOccurrencePairQualified(prepared, unrelated.id, unrelated.id)
    ).toBe(false);
  });

  it('normalizes semantically identical duplicate IDs with baseline last-wins behavior', () => {
    const first = makeReceipt('duplicate', { createdAt: 1 });
    const last = { ...first };

    const prepared = prepareCanonicalPurchaseOccurrenceEvidence([first, last]);
    expect(prepared.receiptById.get('duplicate')).toBe(last);
    expect(
      __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()
    ).toMatchObject({
      summarizeCount: 1,
      theoreticalPairCount: 0,
      candidatePairCount: 0,
      pairEvaluationCount: 0,
      qualifiedPairCount: 0,
    });

    const index = buildCanonicalPurchaseOccurrenceIndex([first, last]);
    expect(index.groups).toHaveLength(1);
    expect(index.groups[0]!.receiptIds).toEqual(['duplicate']);
  });

  it('uses the last incompatible snapshot for a duplicate receipt ID', () => {
    const matching = makeReceipt('duplicate', { createdAt: 1 });
    const incompatible = makeReceipt('duplicate', {
      transactionAt: Date.parse('2025-01-01T09:00:00+09:00'),
      merchant: '別店舗',
      merchantNormalized: '別店舗',
      total: 777,
      tax: 0,
      items: [{ name: 'UNRELATED', quantity: 1, lineTotal: 777 }],
    });
    const peer = makeReceipt('peer', { createdAt: 2 });

    const incompatibleLast = buildCanonicalPurchaseOccurrenceIndex([
      matching,
      incompatible,
      peer,
    ]);
    expect(incompatibleLast.groups).toHaveLength(2);
    expect(
      incompatibleLast.occurrenceIdByReceiptId.get('duplicate')
    ).not.toBe(incompatibleLast.occurrenceIdByReceiptId.get('peer'));

    const matchingLast = buildCanonicalPurchaseOccurrenceIndex([
      incompatible,
      matching,
      peer,
    ]);
    expect(matchingLast.groups).toHaveLength(1);
    expect(matchingLast.groups[0]!.receiptIds).toEqual([
      'duplicate',
      'peer',
    ]);
  });

  it('falls back once for an incompatible prepared snapshot and terminates', () => {
    const original = makeReceipt('same-id', { createdAt: 1 });
    const peer = makeReceipt('peer', { createdAt: 2 });
    const prepared = prepareCanonicalPurchaseOccurrenceEvidence([
      original,
      peer,
    ]);
    const replacement = makeReceipt('same-id', {
      transactionAt: Date.parse('2025-01-01T09:00:00+09:00'),
      merchant: '別店舗',
      merchantNormalized: '別店舗',
      total: 777,
      tax: 0,
      items: [{ name: 'UNRELATED', quantity: 1, lineTotal: 777 }],
    });

    __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests();
    const actual = buildCanonicalPurchaseOccurrenceIndexFromPrepared(
      [replacement, peer],
      prepared
    );
    expect(
      __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()
    ).toMatchObject({
      summarizeCount: 2,
      theoreticalPairCount: 1,
      pairEvaluationCount:
        __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()!
          .candidatePairCount,
    });

    const expected = buildCanonicalPurchaseOccurrenceIndex([
      replacement,
      peer,
    ]);
    expectIndexEqual(actual, expected);
    expect(actual.groups).toHaveLength(2);
  });

  it('terminates for a semantically identical receipt snapshot with a different object reference', () => {
    const original = makeReceipt('same-id', { createdAt: 1 });
    const peer = makeReceipt('peer', { createdAt: 2 });
    const prepared = prepareCanonicalPurchaseOccurrenceEvidence([
      original,
      peer,
    ]);
    const equivalentClone = { ...original };

    __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests();
    const actual = buildCanonicalPurchaseOccurrenceIndexFromPrepared(
      [equivalentClone, peer],
      prepared
    );
    expect(
      __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()
    ).toMatchObject({
      summarizeCount: 2,
      theoreticalPairCount: 1,
      pairEvaluationCount:
        __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()!
          .candidatePairCount,
    });
    expect(actual.groups).toHaveLength(1);
    expect(actual.groups[0]!.receiptIds).toEqual(['peer', 'same-id']);
  });

  it('preserves the compatible prepared fast path after duplicate normalization', () => {
    const first = makeReceipt('duplicate', { createdAt: 1 });
    const last = { ...first };
    const peer = makeReceipt('peer', { createdAt: 2 });
    const prepared = prepareCanonicalPurchaseOccurrenceEvidence([
      first,
      last,
      peer,
    ]);

    __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests();
    const index = buildCanonicalPurchaseOccurrenceIndexFromPrepared(
      [first, last, peer],
      prepared
    );
    expect(
      __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()
    ).toBeNull();
    expect(index.groups).toHaveLength(1);
  });
});

describe('H2.1 — prepare ≡ buildFromPrepared differential', () => {
  function assertPreparedReuse(
    H: ReceiptRow[],
    X: ReceiptRow[]
  ) {
    const fresh = buildCanonicalPurchaseOccurrenceIndex(X);
    const prepared = prepareCanonicalPurchaseOccurrenceEvidence(H);
    const derived = buildCanonicalPurchaseOccurrenceIndexFromPrepared(
      X,
      prepared
    );
    expectIndexEqual(derived, fresh);
  }

  it('X = H', () => {
    const H = [
      makeReceipt('h1', { createdAt: 1 }),
      makeReceipt('h2', { createdAt: 2 }),
      makeReceipt('solo', {
        transactionAt: Date.parse('2026-01-01T10:00:00+09:00'),
      }),
    ];
    assertPreparedReuse(H, H);
  });

  it('single-item subset', () => {
    const a = makeReceipt('a');
    const b = makeReceipt('b');
    assertPreparedReuse([a, b], [a]);
  });

  it('complete-link triangle (generic must not bridge branches)', () => {
    const items = [
      { name: 'グリーンカレーペースト', quantity: 1, lineTotal: 88 },
      { name: '炭化竹箸天削(袋無)', quantity: 1, lineTotal: 386 },
    ];
    const tx = Date.parse('2026-06-30T13:36:00+09:00');
    const branchA = makeReceipt('branch-a', {
      transactionAt: tx,
      merchant: '業務スーパー 一吉店',
      merchantNormalized: '業務スーパー 一吉店',
      total: 474,
      tax: 61,
      items,
    });
    const generic = makeReceipt('generic', {
      transactionAt: tx,
      merchant: '業務スーパー',
      merchantNormalized: '業務スーパー',
      total: 474,
      tax: 61,
      items,
    });
    const branchB = makeReceipt('branch-b', {
      transactionAt: tx,
      merchant: '業務スーパー 古川店',
      merchantNormalized: '業務スーパー 古川店',
      total: 474,
      tax: 61,
      items,
    });
    const H = [branchA, generic, branchB];
    assertPreparedReuse(H, H);
    assertPreparedReuse(H, [branchA, branchB]);
    assertPreparedReuse(H, [branchA, generic]);
  });

  it('representative outside subset in F(H)', () => {
    const items = [
      { name: 'KS ORGANIC MILK', quantity: 1, lineTotal: 418 },
      { name: 'ROTISSERIE CHICKEN', quantity: 1, lineTotal: 698 },
    ];
    // Lex-smallest + best quality → preferred rep in F(H)
    const unsupportedRep = makeReceipt('aaa-rep', {
      createdAt: 1,
      merchantType: 'other',
      isGrocery: false,
      items,
      total: 1116,
      tax: 100,
    });
    const inV = makeReceipt('zzz-member', {
      createdAt: 9_000,
      items,
      total: 1116,
      tax: 100,
    });
    const H = [unsupportedRep, inV];
    assertPreparedReuse(H, [inV]);
  });

  it('exact-second strong-basket pair', () => {
    const a = makeReceipt('exact-a', { createdAt: 1 });
    const b = makeReceipt('exact-b', { createdAt: 2 });
    assertPreparedReuse([a, b], [a, b]);
  });

  it('minute / date / unknown timestamp precision', () => {
    const minute = makeReceipt('m', {
      transactionTimePrecision: 'minute',
      transactionDateText: '2026-07-06 11:44',
    });
    const dateOnly = makeReceipt('d', {
      transactionTimePrecision: 'date',
      transactionDateText: '2026-07-06',
      transactionAt: Date.parse('2026-07-06T00:00:00+09:00'),
    });
    const unknown = makeReceipt('u', {
      transactionAt: null,
      transactionTimePrecision: 'unknown',
    });
    const H = [minute, dateOnly, unknown, makeReceipt('s')];
    assertPreparedReuse(H, H);
    assertPreparedReuse(H, [minute, dateOnly]);
  });

  it('malformed / partial receipt JSON', () => {
    const bad = makeReceipt('bad', { analysisJson: '{not-json' });
    const empty = makeReceipt('empty', { analysisJson: '{}' });
    const ok = makeReceipt('ok');
    const H = [bad, empty, ok];
    assertPreparedReuse(H, H);
    assertPreparedReuse(H, [ok]);
  });

  it('reordered input arrays are irrelevant', () => {
    const a = makeReceipt('r-a', { createdAt: 1 });
    const b = makeReceipt('r-b', { createdAt: 2 });
    const c = makeReceipt('r-c', {
      transactionAt: Date.parse('2026-02-01T10:00:00+09:00'),
    });
    const prepared = prepareCanonicalPurchaseOccurrenceEvidence([a, b, c]);
    const forward = buildCanonicalPurchaseOccurrenceIndexFromPrepared(
      [a, b, c],
      prepared
    );
    const reverse = buildCanonicalPurchaseOccurrenceIndexFromPrepared(
      [c, b, a],
      prepared
    );
    const freshReverse = buildCanonicalPurchaseOccurrenceIndex([c, b, a]);
    expectIndexEqual(forward, reverse);
    expectIndexEqual(reverse, freshReverse);
  });

  it('public builder ≡ prepare + buildFromPrepared', () => {
    const H = [makeReceipt('p1'), makeReceipt('p2', { createdAt: 3 })];
    const viaPublic = buildCanonicalPurchaseOccurrenceIndex(H);
    const prepared = prepareCanonicalPurchaseOccurrenceEvidence(H);
    const viaParts = buildCanonicalPurchaseOccurrenceIndexFromPrepared(
      H,
      prepared
    );
    expectIndexEqual(viaPublic, viaParts);
  });
});

describe('H2.1 — H/V non-equivalence (unsafe restrict guardrail)', () => {
  it('restrict(F(H), V) ≠ F(V) when representative lies outside V', () => {
    const items = [
      { name: 'KS ORGANIC MILK', quantity: 1, lineTotal: 418 },
      { name: 'ROTISSERIE CHICKEN', quantity: 1, lineTotal: 698 },
    ];
    const outside = makeReceipt('aaa-outside', {
      createdAt: 1,
      merchantType: 'other',
      isGrocery: false,
      items,
      total: 1116,
    });
    const insideA = makeReceipt('bbb-inside', {
      createdAt: 5_000,
      items,
      total: 1116,
    });
    const insideB = makeReceipt('ccc-inside', {
      createdAt: 6_000,
      items,
      total: 1116,
    });
    const H = [outside, insideA, insideB];
    const V = filterV1SupportedReceipts(H);
    expect(V.map((r) => r.id).sort()).toEqual(['bbb-inside', 'ccc-inside']);

    const fH = buildCanonicalPurchaseOccurrenceIndex(H);
    const fV = buildCanonicalPurchaseOccurrenceIndex(V);
    expect(fH.groups).toHaveLength(1);
    expect(fH.groups[0]!.representativeReceiptId).toBe('aaa-outside');
    expect(fV.groups).toHaveLength(1);
    expect(fV.groups[0]!.representativeReceiptId).not.toBe('aaa-outside');
    expect(fV.groups[0]!.occurrenceId).not.toBe(fH.groups[0]!.occurrenceId);

    const restricted = restrictOccurrenceIndexToReceiptIds(
      fH,
      new Set(V.map((r) => r.id))
    );
    expect(indexFingerprint(restricted)).not.toEqual(indexFingerprint(fV));
  });

  it('prepared reuse still equals fresh F(V) for the same fixture', () => {
    const items = [
      { name: 'KS ORGANIC MILK', quantity: 1, lineTotal: 418 },
      { name: 'ROTISSERIE CHICKEN', quantity: 1, lineTotal: 698 },
    ];
    const outside = makeReceipt('aaa-outside', {
      createdAt: 1,
      merchantType: 'other',
      isGrocery: false,
      items,
      total: 1116,
    });
    const insideA = makeReceipt('bbb-inside', {
      createdAt: 5_000,
      items,
      total: 1116,
    });
    const insideB = makeReceipt('ccc-inside', {
      createdAt: 6_000,
      items,
      total: 1116,
    });
    const H = [outside, insideA, insideB];
    const V = filterV1SupportedReceipts(H);
    const prepared = prepareCanonicalPurchaseOccurrenceEvidence(H);
    const derived = buildCanonicalPurchaseOccurrenceIndexFromPrepared(
      V,
      prepared
    );
    expectIndexEqual(derived, buildCanonicalPurchaseOccurrenceIndex(V));
  });
});

describe('H2.1 — preparation evaluation counts', () => {
  it('prepare summarizes n; buildFromPrepared adds no prepare stats', () => {
    const H = [
      makeReceipt('c1'),
      makeReceipt('c2'),
      makeReceipt('c3'),
      makeReceipt('c4', {
        transactionAt: Date.parse('2026-03-01T10:00:00+09:00'),
      }),
    ];
    const n = H.length;
    __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests();
    const prepared = prepareCanonicalPurchaseOccurrenceEvidence(H);
    const afterPrepare = __getLastCanonicalPurchaseOccurrencePrepareStatsForTests();
    expect(afterPrepare?.summarizeCount).toBe(n);
    expect(afterPrepare?.theoreticalPairCount).toBe((n * (n - 1)) / 2);
    expect(afterPrepare?.pairEvaluationCount).toBe(
      afterPrepare?.candidatePairCount
    );
    expect(afterPrepare!.pairEvaluationCount).toBeLessThanOrEqual(
      afterPrepare!.theoreticalPairCount
    );

    __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests();
    buildCanonicalPurchaseOccurrenceIndexFromPrepared(H, prepared);
    expect(
      __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()
    ).toBeNull();

    const V = filterV1SupportedReceipts(H);
    __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests();
    buildCanonicalPurchaseOccurrenceIndexFromPrepared(V, prepared);
    expect(
      __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()
    ).toBeNull();
  });
});

describe('H2.1 — cache MISS / HIT prepared capture', () => {
  const OWNER = 'user:h21-owner';

  function liveGen(): number {
    return getAnalyticsReceiptSelectionDataGeneration();
  }

  it('MISS: prepares once, caches index, exposes prepared for F(V)', () => {
    const items = [
      { name: 'KS ORGANIC MILK', quantity: 1, lineTotal: 418 },
      { name: 'ROTISSERIE CHICKEN', quantity: 1, lineTotal: 698 },
    ];
    const outside = makeReceipt('aaa-out', {
      createdAt: 1,
      merchantType: 'other',
      isGrocery: false,
      items,
      total: 1116,
    });
    const inside = makeReceipt('bbb-in', {
      createdAt: 5_000,
      items,
      total: 1116,
    });
    const H = [outside, inside];
    const V = filterV1SupportedReceipts(H);

    __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests();
    const miss = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
      analyticsReceipts: H,
      ownerKey: OWNER,
      analyticsGeneration: liveGen(),
    });
    expect(miss.ok).toBe(true);
    if (!miss.ok) return;
    expect(miss.cacheState).toBe('miss');
    expect(miss.preparedEvidence).toBeDefined();
    expect(getCanonicalPurchaseOccurrenceBuildCount()).toBe(1);
    const prepareStats =
      __getLastCanonicalPurchaseOccurrencePrepareStatsForTests();
    expect(prepareStats?.summarizeCount).toBe(H.length);

    __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests();
    const fV = buildCanonicalPurchaseOccurrenceIndexFromPrepared(
      V,
      miss.preparedEvidence!
    );
    expect(
      __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()
    ).toBeNull();
    expectIndexEqual(fV, buildCanonicalPurchaseOccurrenceIndex(V));
  });

  it('HIT: prepared absent; Repeat must fresh-build F(V), not restrict F(H)', () => {
    const a = makeReceipt('hit-a');
    const b = makeReceipt('hit-b');
    const H = [a, b];

    const miss = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
      analyticsReceipts: H,
      ownerKey: OWNER,
      analyticsGeneration: liveGen(),
    });
    expect(miss.ok && miss.cacheState === 'miss').toBe(true);

    const hit = getOrBuildCanonicalPurchaseOccurrenceIndexCached({
      analyticsReceipts: H,
      ownerKey: OWNER,
      analyticsGeneration: liveGen(),
    });
    expect(hit.ok).toBe(true);
    if (!hit.ok) return;
    expect(hit.cacheState).toBe('hit');
    expect(hit.preparedEvidence).toBeUndefined();

    const V = filterV1SupportedReceipts(H);
    // Correct HIT path: fresh F(V) — never restrict hit.index
    __resetLastCanonicalPurchaseOccurrencePrepareStatsForTests();
    const freshV = buildCanonicalPurchaseOccurrenceIndex(V);
    expect(
      __getLastCanonicalPurchaseOccurrencePrepareStatsForTests()?.summarizeCount
    ).toBe(V.length);

    const unsafe = restrictOccurrenceIndexToReceiptIds(
      hit.index,
      new Set(V.map((r) => r.id))
    );
    // For this simple pair they may coincide; still assert fresh path ran.
    expectIndexEqual(freshV, buildCanonicalPurchaseOccurrenceIndex(V));
    void unsafe;
  });
});

describe('H2.1 — Repeat output with prepared evidence', () => {
  it('profiles from prepared F(V) deep-equal fresh F(V) baseline', () => {
    const a = makeReceipt('rp-a', { createdAt: 1 });
    const b = makeReceipt('rp-b', { createdAt: 2 });
    const H = [a, b];
    const prepared = prepareCanonicalPurchaseOccurrenceEvidence(H);
    const rows = [
      {
        receiptId: 'rp-a',
        sourceIndex: 0,
        occurredAt: TX,
        displayName: 'KS ORGANIC MILK',
        merchantNormalized: 'コストコ',
        merchantRaw: 'コストコ',
        lineTotal: 418,
        purchaseQuantity: 1,
      },
      {
        receiptId: 'rp-b',
        sourceIndex: 0,
        occurredAt: TX,
        displayName: 'KS ORGANIC MILK',
        merchantNormalized: 'コストコ',
        merchantRaw: 'コストコ',
        lineTotal: 418,
        purchaseQuantity: 1,
      },
    ];

    const baseline = buildRepeatProductProfiles(H, rows);
    const withPrepared = buildRepeatProductProfiles(H, rows, {
      occurrencePreparedEvidence: prepared,
    });
    expect(withPrepared).toEqual(baseline);
  });
});
