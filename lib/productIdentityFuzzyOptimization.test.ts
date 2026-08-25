import {
  FUZZY_AUTO_MATCH_THRESHOLD,
  FUZZY_CANDIDATE_FLOOR,
} from './productIdentityResolver';
import {
  combinedNameSimilarity,
  combinedNameSimilarityAtOrAbovePotential,
  combinedNameSimilarityUpperBound,
  type FuzzySimilarityDiagnostics,
} from './productIdentitySimilarity';

type Candidate = { id: string; comparisonKey: string };

function diagnostics(): FuzzySimilarityDiagnostics {
  return {
    candidateVisits: 0,
    upperBoundRejected: 0,
    lengthUpperBoundRejected: 0,
    tokenUpperBoundRejected: 0,
    expensiveSimilarityCalls: 0,
  };
}

function referenceFuzzySelection(query: string, candidates: Candidate[]) {
  const eligible: Array<{ id: string; score: number }> = [];
  let selected: { id: string; score: number } | null = null;
  for (const candidate of candidates) {
    const score = combinedNameSimilarity(query, candidate.comparisonKey);
    if (score < FUZZY_CANDIDATE_FLOOR) continue;
    eligible.push({ id: candidate.id, score });
    if (
      score >= FUZZY_AUTO_MATCH_THRESHOLD &&
      (!selected || score > selected.score)
    ) {
      selected = { id: candidate.id, score };
    }
  }
  return {
    eligible,
    selected,
    action: selected ? 'reuse' : 'create',
    reason: selected ? 'same_merchant_fuzzy_auto' : 'new_merchant_product',
  };
}

function optimizedFuzzySelection(query: string, candidates: Candidate[]) {
  const stats = diagnostics();
  const eligible: Array<{ id: string; score: number }> = [];
  let selected: { id: string; score: number } | null = null;
  for (const candidate of candidates) {
    const score = combinedNameSimilarityAtOrAbovePotential(
      query,
      candidate.comparisonKey,
      FUZZY_CANDIDATE_FLOOR,
      stats
    );
    if (score == null || score < FUZZY_CANDIDATE_FLOOR) continue;
    eligible.push({ id: candidate.id, score });
    if (
      score >= FUZZY_AUTO_MATCH_THRESHOLD &&
      (!selected || score > selected.score)
    ) {
      selected = { id: candidate.id, score };
    }
  }
  return {
    eligible,
    selected,
    action: selected ? 'reuse' : 'create',
    reason: selected ? 'same_merchant_fuzzy_auto' : 'new_merchant_product',
    stats,
  };
}

function tokenSeries(count: number, finalToken: string): string {
  return [
    ...Array.from(
      { length: count - 1 },
      (_, index) => `token${String(index).padStart(3, '0')}`
    ),
    finalToken,
  ].join('-');
}

describe('Product Identity fuzzy negative-path upper bound', () => {
  const comparisonPairs = [
    ['水', '米'],
    ['天然水レモン500ml', '天然水レモン500ml'],
    ['天然水-レモン-500ml', '天然水-レモン-600ml'],
    ['コカコーラZERO500ml', 'コカコーラ500ml'],
    ['abc-123-product', 'abc 123 product'],
    ['short', 'a-very-long-product-name'],
    [tokenSeries(10, 'queryx'), tokenSeries(10, 'otherx')],
    [tokenSeries(12, 'queryx'), tokenSeries(12, 'otherx')],
    [tokenSeries(100, 'queryx'), tokenSeries(100, 'otherx')],
  ] as const;

  it('never places the cheap upper bound below the exact combined score', () => {
    for (const [left, right] of comparisonPairs) {
      expect(combinedNameSimilarityUpperBound(left, right)).toBeGreaterThanOrEqual(
        combinedNameSimilarity(left, right)
      );
    }
  });

  it('returns the exact unchanged score whenever the bound cannot reject', () => {
    for (const [left, right] of comparisonPairs) {
      const exact = combinedNameSimilarity(left, right);
      const atExactBoundary = combinedNameSimilarityAtOrAbovePotential(
        left,
        right,
        exact
      );
      expect(atExactBoundary).not.toBeNull();
      expect(atExactBoundary).toBe(exact);

      const atResolverFloor = combinedNameSimilarityAtOrAbovePotential(
        left,
        right,
        FUZZY_CANDIDATE_FLOOR
      );
      if (atResolverFloor == null) {
        expect(exact).toBeLessThan(FUZZY_CANDIDATE_FLOOR);
      } else {
        expect(atResolverFloor).toBe(exact);
      }
    }
  });

  it('preserves exact fuzzy-floor and auto-threshold boundary decisions', () => {
    const floorLeft = 'abcdefghijklm';
    const floorRight = 'ABcdefghijklm';
    const autoLeft = 'a'.repeat(65);
    const autoRight = `AA${'a'.repeat(63)}`;
    const floorScore = combinedNameSimilarity(floorLeft, floorRight);
    const autoScore = combinedNameSimilarity(autoLeft, autoRight);

    expect(floorScore).toBeCloseTo(FUZZY_CANDIDATE_FLOOR, 14);
    expect(autoScore).toBeCloseTo(FUZZY_AUTO_MATCH_THRESHOLD, 14);
    expect(
      combinedNameSimilarityAtOrAbovePotential(
        floorLeft,
        floorRight,
        FUZZY_CANDIDATE_FLOOR
      )
    ).toBe(floorScore);
    expect(
      combinedNameSimilarityAtOrAbovePotential(
        autoLeft,
        autoRight,
        FUZZY_CANDIDATE_FLOOR
      )
    ).toBe(autoScore);

    const floorSelection = optimizedFuzzySelection(floorLeft, [
      { id: 'at-floor', comparisonKey: floorRight },
    ]);
    const autoSelection = optimizedFuzzySelection(autoLeft, [
      { id: 'at-auto', comparisonKey: autoRight },
    ]);
    expect(floorSelection.eligible).toEqual([
      { id: 'at-floor', score: floorScore },
    ]);
    expect(floorSelection.selected).toBeNull();
    expect(autoSelection.selected).toEqual({ id: 'at-auto', score: autoScore });
  });

  it('preserves below-floor, candidate-only, auto-match, and tie ordering', () => {
    const belowFloor = tokenSeries(9, 'queryx');
    const candidateOnly = tokenSeries(10, 'queryx');
    const autoMatch = tokenSeries(100, 'token099');
    const belowCandidate = tokenSeries(9, 'otherx');
    const candidateOnlyCandidate = tokenSeries(10, 'otherx');
    const tieFirst = tokenSeries(100, 'tokenx99');
    const tieSecond = tokenSeries(100, 'tokeny99');

    expect(combinedNameSimilarity(belowFloor, belowCandidate)).toBeLessThan(
      FUZZY_CANDIDATE_FLOOR
    );
    const candidateOnlyScore = combinedNameSimilarity(
      candidateOnly,
      candidateOnlyCandidate
    );
    expect(candidateOnlyScore).toBeGreaterThanOrEqual(FUZZY_CANDIDATE_FLOOR);
    expect(candidateOnlyScore).toBeLessThan(FUZZY_AUTO_MATCH_THRESHOLD);
    expect(combinedNameSimilarity(autoMatch, tieFirst)).toBeGreaterThanOrEqual(
      FUZZY_AUTO_MATCH_THRESHOLD
    );
    expect(combinedNameSimilarity(autoMatch, tieFirst)).toBe(
      combinedNameSimilarity(autoMatch, tieSecond)
    );

    const fixtures: Array<{ query: string; candidates: Candidate[] }> = [
      {
        query: belowFloor,
        candidates: [
          { id: 'dissimilar', comparisonKey: '全く違う商品' },
          { id: 'below', comparisonKey: belowCandidate },
        ],
      },
      {
        query: candidateOnly,
        candidates: [
          { id: 'dissimilar', comparisonKey: '全く違う商品' },
          { id: 'candidate-only', comparisonKey: candidateOnlyCandidate },
        ],
      },
      {
        query: autoMatch,
        candidates: [
          { id: 'dissimilar', comparisonKey: '全く違う商品' },
          { id: 'tie-first', comparisonKey: tieFirst },
          { id: 'tie-second', comparisonKey: tieSecond },
        ],
      },
    ];

    for (const fixture of fixtures) {
      const reference = referenceFuzzySelection(
        fixture.query,
        fixture.candidates
      );
      const optimized = optimizedFuzzySelection(
        fixture.query,
        fixture.candidates
      );
      expect(optimized.eligible).toEqual(reference.eligible);
      expect(optimized.selected).toEqual(reference.selected);
      expect(optimized.action).toBe(reference.action);
      expect(optimized.reason).toBe(reference.reason);
    }

    const tied = optimizedFuzzySelection(autoMatch, fixtures[2]!.candidates);
    expect(tied.selected?.id).toBe('tie-first');
  });

  it('retains exact reference decisions across Japanese, ASCII, punctuation, and length cases', () => {
    const candidates = comparisonPairs.map(([left], index) => ({
      id: `candidate-${index}`,
      comparisonKey: left,
    }));
    for (const [, query] of comparisonPairs) {
      const reference = referenceFuzzySelection(query, candidates);
      const optimized = optimizedFuzzySelection(query, candidates);
      expect(optimized.eligible).toEqual(reference.eligible);
      expect(optimized.selected).toEqual(reference.selected);
      expect(optimized.action).toBe(reference.action);
      expect(optimized.reason).toBe(reference.reason);
    }
  });
});
