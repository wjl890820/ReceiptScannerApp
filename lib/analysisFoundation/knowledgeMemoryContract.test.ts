/**
 * B1.1.2 — Knowledge & Memory Contract enforcement tests.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('../db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import * as foundation from './index';
import {
  KNOWLEDGE_MEMORY_CONTRACT_VERSION,
  aggregatePurchaseMemoryFacts,
  claimEligibility,
  compareKnowledgeSources,
  createEmptyProductKnowledgeProvider,
  deterministicSum,
  evaluateKnowledgeScopeEligibility,
  evaluatePurchaseMemory,
  isGloballyVerifiedSelection,
  isPersonalManualSelection,
  isUsableKnowledgeSelection,
  memoryClaimAuthorizesExactPriceComparison,
  normalizeProductKnowledgeLookupResult,
  scopeForPersonalManualCorrection,
  selectBestKnowledgeCandidate,
  semanticValuesEqual,
  validateInsightEvidenceClaim,
  validateKnowledgeRecord,
  validateProductKnowledgeQuery,
  type KnowledgeCandidate,
  type KnowledgeSelectionResult,
  type MemoryIdentityEvidence,
  type PatternEvidenceSignal,
  type ProductKnowledgeRecord,
  type PurchaseMemoryObservation,
} from './knowledgeMemoryContract';

function confirmedIdentity(
  overrides: Partial<MemoryIdentityEvidence> = {}
): MemoryIdentityEvidence {
  return {
    status: 'confirmed',
    identityLevel: 'merchant_product',
    identityConfidence: 0.9,
    identitySource: 'merchant_exact',
    merchantProductId: 'mp_a',
    evidence: ['merchant_product_id=mp_a'],
    ...overrides,
  };
}

function candidateIdentity(): MemoryIdentityEvidence {
  return {
    status: 'candidate',
    identityLevel: 'family_only',
    identityConfidence: 0.4,
    identitySource: 'family_only',
    evidence: ['family_match'],
  };
}

function freqSignal(
  overrides: Partial<PatternEvidenceSignal> = {}
): PatternEvidenceSignal {
  return {
    kind: 'frequency',
    confidence: 0.8,
    trusted: true,
    eligibility: claimEligibility('eligible', ['freq_ok']),
    provenance: ['repeat_count_pattern'],
    ...overrides,
  };
}

function cycleSignal(
  overrides: Partial<PatternEvidenceSignal> = {}
): PatternEvidenceSignal {
  return {
    kind: 'cycle',
    confidence: 0.8,
    trusted: true,
    eligibility: claimEligibility('eligible', ['cycle_ok']),
    provenance: ['stable_interval_pattern'],
    ...overrides,
  };
}

function cand(
  partial: Partial<KnowledgeCandidate> &
    Pick<
      KnowledgeCandidate,
      'id' | 'scope' | 'sourceTier' | 'claimValue' | 'knowledgeKind'
    >
): KnowledgeCandidate {
  return {
    claimKey: 'packSize',
    confidence: 0.9,
    evidence: ['e1'],
    ...partial,
  };
}

function sevenEvents(): PurchaseMemoryObservation[] {
  return Array.from({ length: 7 }, (_, i) => ({
    purchaseEventKey: `event-${i}`,
    units: 1,
    purchasedAt: 1_000 + i * 86_400_000,
  }));
}

function pkRecord(
  partial: Partial<ProductKnowledgeRecord> &
    Pick<ProductKnowledgeRecord, 'id' | 'knowledgeKind' | 'scope' | 'sourceTier'>
): ProductKnowledgeRecord {
  return {
    providerId: 'p',
    confidence: 0.9,
    evidence: ['e'],
    reasonCodes: ['r'],
    ...partial,
  };
}

describe('B1.1.1 baseline', () => {
  test('version stamp', () => {
    expect(KNOWLEDGE_MEMORY_CONTRACT_VERSION).toBe(
      'meruno-knowledge-memory-contract-b1.1.2-v1'
    );
  });

  test('personal manual correction => personal', () => {
    expect(scopeForPersonalManualCorrection()).toBe('personal');
  });

  test('source precedence', () => {
    expect(compareKnowledgeSources('personal_manual', 'global_verified')).toBeLessThan(0);
  });

  test('1 event qty=3 => seen', () => {
    const { facts } = aggregatePurchaseMemoryFacts([
      { purchaseEventKey: 'event-1', units: 3, purchasedAt: 1_000 },
    ]);
    expect(facts.totalUnitsPurchased).toBe(3);
    expect(
      evaluatePurchaseMemory({
        facts,
        evidence: { identity: confirmedIdentity() },
      }).stage
    ).toBe('seen');
  });

  test('two events => repeated', () => {
    const { facts } = aggregatePurchaseMemoryFacts([
      { purchaseEventKey: 'e1', units: 1, purchasedAt: 1 },
      { purchaseEventKey: 'e2', units: 1, purchasedAt: 2 },
    ]);
    expect(
      evaluatePurchaseMemory({
        facts,
        evidence: { identity: confirmedIdentity() },
      }).stage
    ).toBe('repeated');
  });

  test('7 events without frequency => not frequent', () => {
    const { facts } = aggregatePurchaseMemoryFacts(sevenEvents());
    expect(
      evaluatePurchaseMemory({
        facts,
        evidence: { identity: confirmedIdentity() },
      }).stage
    ).toBe('repeated');
  });

  test('evidence ladder ordinal', () => {
    expect(
      validateInsightEvidenceClaim({
        declaredEvidenceLevel: 'prediction',
        assertedClaimLevel: 'action',
      }).ok
    ).toBe(false);
  });

  test('memory eligible still cannot authorize exact price', () => {
    const { facts } = aggregatePurchaseMemoryFacts([
      { purchaseEventKey: 'e1', units: 1, purchasedAt: 1 },
      { purchaseEventKey: 'e2', units: 1, purchasedAt: 2 },
    ]);
    const r = evaluatePurchaseMemory({
      facts,
      evidence: { identity: candidateIdentity() },
    });
    expect(r.eligibility.status).toBe('eligible_with_caution');
    expect(memoryClaimAuthorizesExactPriceComparison()).toBe(false);
  });
});

describe('B1.1.1 privacy integrated selection', () => {
  test('1: purchase_frequency + global_verified invalid even conf=1', () => {
    const bad = cand({
      id: 'bad',
      knowledgeKind: 'purchase_frequency',
      claimKey: 'purchase_frequency',
      scope: 'global_verified',
      sourceTier: 'global_verified',
      claimValue: 'weekly',
      confidence: 1,
      evidence: ['agg'],
    });
    expect(validateKnowledgeRecord(bad).ok).toBe(false);
    const r = selectBestKnowledgeCandidate([bad]);
    expect(r.selected).toBeNull();
    expect(r.authorityKind).toBe('none');
  });

  test('2: purchase_history + global_candidate invalid', () => {
    expect(
      validateKnowledgeRecord(
        cand({
          id: 'x',
          knowledgeKind: 'purchase_history',
          scope: 'global_candidate',
          sourceTier: 'local_rule',
          claimValue: '1',
        })
      ).ok
    ).toBe(false);
  });

  test('3: merchant_preference + global_verified invalid', () => {
    expect(
      validateKnowledgeRecord(
        cand({
          id: 'x',
          knowledgeKind: 'merchant_preference',
          scope: 'global_verified',
          sourceTier: 'global_verified',
          claimValue: 'M',
          evidence: ['e'],
        })
      ).ok
    ).toBe(false);
  });

  test('4: product_spec + global_verified valid', () => {
    expect(
      validateKnowledgeRecord(
        cand({
          id: 'ok',
          knowledgeKind: 'product_spec',
          scope: 'global_verified',
          sourceTier: 'global_verified',
          claimValue: '6',
          evidence: ['published'],
        })
      ).ok
    ).toBe(true);
  });

  test('5: product_alias + global_candidate => candidate_only', () => {
    const r = selectBestKnowledgeCandidate([
      cand({
        id: 'gc',
        knowledgeKind: 'product_alias',
        scope: 'global_candidate',
        sourceTier: 'local_rule',
        claimValue: 'Product A',
        confidence: 1,
      }),
    ]);
    expect(r.status).toBe('candidate_only');
    expect(r.authorityKind).toBe('candidate_only');
    expect(isGloballyVerifiedSelection(r)).toBe(false);
  });

  test('6: unknown runtime knowledgeKind invalid', () => {
    expect(
      validateKnowledgeRecord({
        id: 'x',
        knowledgeKind: 'purchase_location_history',
        scope: 'global_verified',
        sourceTier: 'global_verified',
        claimKey: 'loc',
        claimValue: '1',
        confidence: 1,
        evidence: ['e'],
      }).ok
    ).toBe(false);
    expect(
      evaluateKnowledgeScopeEligibility({
        kind: 'purchase_location_history',
        scope: 'global_verified',
      }).reasonCodes
    ).toContain('unknown_knowledge_kind');
  });
});

describe('B1.1.1 authorityKind', () => {
  test('7: personal_manual => personal_manual', () => {
    const r = selectBestKnowledgeCandidate([
      cand({
        id: 'pm',
        knowledgeKind: 'product_category',
        scope: 'personal',
        sourceTier: 'personal_manual',
        claimValue: 'dairy',
      }),
    ]);
    expect(r.authorityKind).toBe('personal_manual');
    expect(isPersonalManualSelection(r)).toBe(true);
  });

  test('8: global_verified => global_verified', () => {
    const r = selectBestKnowledgeCandidate([
      cand({
        id: 'gv',
        knowledgeKind: 'product_spec',
        scope: 'global_verified',
        sourceTier: 'global_verified',
        claimValue: '6',
        evidence: ['pub'],
      }),
    ]);
    expect(r.authorityKind).toBe('global_verified');
    expect(isGloballyVerifiedSelection(r)).toBe(true);
  });

  test('9: personal local_rule => local_preferred', () => {
    const r = selectBestKnowledgeCandidate([
      cand({
        id: 'lr',
        knowledgeKind: 'product_alias',
        scope: 'personal',
        sourceTier: 'local_rule',
        claimValue: 'A',
      }),
    ]);
    expect(r.authorityKind).toBe('local_preferred');
  });

  test('10: personal ai => local_preferred', () => {
    const r = selectBestKnowledgeCandidate([
      cand({
        id: 'ai',
        knowledgeKind: 'product_alias',
        scope: 'personal',
        sourceTier: 'ai',
        claimValue: 'A',
      }),
    ]);
    expect(r.authorityKind).toBe('local_preferred');
  });

  test('11: global_candidate => candidate_only', () => {
    const r = selectBestKnowledgeCandidate([
      cand({
        id: 'gc',
        knowledgeKind: 'product_spec',
        scope: 'global_candidate',
        sourceTier: 'merchant_knowledge',
        claimValue: '6',
      }),
    ]);
    expect(r.authorityKind).toBe('candidate_only');
  });

  test('12: no match => none', () => {
    const r = selectBestKnowledgeCandidate([]);
    expect(r.authorityKind).toBe('none');
    expect(r.status).toBe('no_match');
  });

  test('13: selected_with_conflict keeps winner provenance', () => {
    const r = selectBestKnowledgeCandidate([
      cand({
        id: 'gv',
        knowledgeKind: 'product_spec',
        scope: 'global_verified',
        sourceTier: 'global_verified',
        claimValue: '6',
        evidence: ['pub'],
      }),
      cand({
        id: 'mk',
        knowledgeKind: 'product_spec',
        scope: 'personal',
        sourceTier: 'merchant_knowledge',
        claimValue: '12',
      }),
    ]);
    expect(r.status).toBe('selected_with_conflict');
    expect(r.authorityKind).toBe('global_verified');
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(isUsableKnowledgeSelection(r)).toBe(true);
  });

  test('14: no public authoritative boolean on result', () => {
    const r: KnowledgeSelectionResult = selectBestKnowledgeCandidate([
      cand({
        id: 'pm',
        knowledgeKind: 'product_category',
        scope: 'personal',
        sourceTier: 'personal_manual',
        claimValue: 'x',
      }),
    ]);
    expect('authoritative' in r).toBe(false);
    expect(r.authorityKind).toBeDefined();
  });
});

describe('B1.1.1 structural validation', () => {
  test('15: evidence=null invalid', () => {
    expect(
      validateKnowledgeRecord({
        id: 'x',
        knowledgeKind: 'product_alias',
        scope: 'personal',
        sourceTier: 'local_rule',
        claimKey: 'a',
        claimValue: '1',
        confidence: 0.5,
        evidence: null,
      }).ok
    ).toBe(false);
  });

  test('16: evidence=string invalid', () => {
    expect(
      validateKnowledgeRecord({
        id: 'x',
        knowledgeKind: 'product_alias',
        scope: 'personal',
        sourceTier: 'local_rule',
        claimKey: 'a',
        claimValue: '1',
        confidence: 0.5,
        evidence: 'abc',
      }).ok
    ).toBe(false);
  });

  test('17: reasonCodes=string invalid', () => {
    expect(
      validateKnowledgeRecord({
        id: 'x',
        knowledgeKind: 'product_alias',
        scope: 'personal',
        sourceTier: 'local_rule',
        claimKey: 'a',
        claimValue: '1',
        confidence: 0.5,
        evidence: ['e'],
        reasonCodes: 'bad',
      }).ok
    ).toBe(false);
  });

  test('18: blank record id invalid', () => {
    expect(
      validateKnowledgeRecord(
        cand({
          id: '  ',
          knowledgeKind: 'product_alias',
          scope: 'personal',
          sourceTier: 'local_rule',
          claimValue: '1',
        })
      ).ok
    ).toBe(false);
  });

  test('19: blank claimKey invalid', () => {
    expect(
      validateKnowledgeRecord(
        cand({
          id: 'x',
          knowledgeKind: 'product_alias',
          scope: 'personal',
          sourceTier: 'local_rule',
          claimKey: '   ',
          claimValue: '1',
        })
      ).ok
    ).toBe(false);
  });

  test('20: blank evidence entry invalid', () => {
    expect(
      validateKnowledgeRecord(
        cand({
          id: 'x',
          knowledgeKind: 'product_alias',
          scope: 'personal',
          sourceTier: 'local_rule',
          claimValue: '1',
          evidence: ['ok', '  '],
        })
      ).ok
    ).toBe(false);
  });

  test('21: same evidence different order => same fingerprint equality', () => {
    const a = cand({
      id: 'x',
      knowledgeKind: 'product_alias',
      scope: 'personal',
      sourceTier: 'local_rule',
      claimValue: '1',
      evidence: ['b', 'a'],
    });
    const b = { ...a, evidence: ['a', 'b'] };
    const r = selectBestKnowledgeCandidate([a, b]);
    expect(r.reasonCodes).toContain('exact_duplicate_deduped');
    expect(r.status).toBe('selected');
  });
});

describe('B1.1.1 duplicate determinism', () => {
  test('22: same ID same semantic => dedupe', () => {
    const row = cand({
      id: 'dup',
      knowledgeKind: 'product_spec',
      scope: 'personal',
      sourceTier: 'local_rule',
      claimValue: 'A',
    });
    const r = selectBestKnowledgeCandidate([row, { ...row }]);
    expect(r.selected?.id).toBe('dup');
    expect(r.reasonCodes).toContain('exact_duplicate_deduped');
  });

  test('23: same ID differing semantic => conflict', () => {
    const r = selectBestKnowledgeCandidate([
      cand({
        id: 'same',
        knowledgeKind: 'product_spec',
        scope: 'personal',
        sourceTier: 'local_rule',
        claimValue: 'A',
      }),
      cand({
        id: 'same',
        knowledgeKind: 'product_spec',
        scope: 'personal',
        sourceTier: 'local_rule',
        claimValue: 'B',
      }),
    ]);
    expect(r.status).toBe('invalid_input');
    expect(r.reasonCodes).toContain('duplicate_id_conflict');
  });

  test('24: reverse differing duplicate => identical conflict structure', () => {
    const a = cand({
      id: 'same',
      knowledgeKind: 'product_spec',
      scope: 'personal',
      sourceTier: 'local_rule',
      claimValue: 'A',
    });
    const b = cand({
      id: 'same',
      knowledgeKind: 'product_spec',
      scope: 'personal',
      sourceTier: 'local_rule',
      claimValue: 'B',
    });
    const r1 = selectBestKnowledgeCandidate([a, b]);
    const r2 = selectBestKnowledgeCandidate([b, a]);
    expect(r1.conflicts).toEqual(r2.conflicts);
    expect(r1.reasonCodes).toEqual(r2.reasonCodes);
  });

  test('25: multiple conflicts reverse => identical ordering', () => {
    const rows = [
      cand({
        id: 'a',
        knowledgeKind: 'product_spec',
        scope: 'personal',
        sourceTier: 'local_rule',
        claimValue: '1',
      }),
      cand({
        id: 'b',
        knowledgeKind: 'product_spec',
        scope: 'personal',
        sourceTier: 'ai',
        claimValue: '2',
      }),
      cand({
        id: 'c',
        knowledgeKind: 'product_spec',
        scope: 'personal',
        sourceTier: 'merchant_knowledge',
        claimValue: '3',
      }),
    ];
    const r1 = selectBestKnowledgeCandidate(rows);
    const r2 = selectBestKnowledgeCandidate([...rows].reverse());
    expect(r1.conflicts).toEqual(r2.conflicts);
    expect(r1.selected?.id).toBe(r2.selected?.id);
  });

  test('object property order does not false-conflict', () => {
    expect(semanticValuesEqual({ pack: 6, unit: 'pc' }, { unit: 'pc', pack: 6 })).toBe(
      true
    );
  });
});

describe('B1.1.1 temporal validation', () => {
  test('26: firstPurchasedAt=NaN sanitized', () => {
    const r = evaluatePurchaseMemory({
      facts: {
        distinctPurchaseEventCount: 2,
        totalUnitsPurchased: 2,
        firstPurchasedAt: Number.NaN,
        lastPurchasedAt: 100,
      },
      evidence: { identity: confirmedIdentity() },
    });
    expect(r.stage).toBe('repeated');
    expect(r.facts.firstPurchasedAt).toBeNull();
    expect(Number.isNaN(r.facts.firstPurchasedAt as number)).toBe(false);
    expect(r.eligibility.status).toBe('eligible_with_caution');
  });

  test('27: lastPurchasedAt=Infinity sanitized', () => {
    const r = evaluatePurchaseMemory({
      facts: {
        distinctPurchaseEventCount: 2,
        totalUnitsPurchased: 2,
        firstPurchasedAt: 100,
        lastPurchasedAt: Number.POSITIVE_INFINITY,
      },
      evidence: { identity: confirmedIdentity() },
    });
    expect(r.facts.lastPurchasedAt).toBeNull();
    expect(r.eligibility.status).toBe('eligible_with_caution');
  });

  test('28: first > last => temporal conflict', () => {
    const r = evaluatePurchaseMemory({
      facts: {
        distinctPurchaseEventCount: 2,
        totalUnitsPurchased: 2,
        firstPurchasedAt: 200,
        lastPurchasedAt: 100,
      },
      evidence: { identity: confirmedIdentity() },
    });
    expect(r.facts.firstPurchasedAt).toBeNull();
    expect(r.facts.lastPurchasedAt).toBeNull();
    expect(r.reasonCodes).toContain('conflicting_temporal_fact');
  });

  test('29/30: valid count + invalid temporal => no malformed timestamps; caution', () => {
    const r = evaluatePurchaseMemory({
      facts: {
        distinctPurchaseEventCount: 2,
        totalUnitsPurchased: 2,
        firstPurchasedAt: Number.NaN,
        lastPurchasedAt: Number.POSITIVE_INFINITY,
      },
      evidence: { identity: confirmedIdentity() },
    });
    expect(r.stage).toBe('repeated');
    expect(r.facts.firstPurchasedAt).toBeNull();
    expect(r.facts.lastPurchasedAt).toBeNull();
    expect(r.eligibility.status).toBe('eligible_with_caution');
  });
});

describe('B1.1.1 deterministic units', () => {
  test('31: [1e16,1,1] and reverse identical total', () => {
    const a = [1e16, 1, 1];
    const b = [...a].reverse();
    expect(deterministicSum(a)).toBe(deterministicSum(b));
    const f1 = aggregatePurchaseMemoryFacts([
      { purchaseEventKey: 'e', units: 1e16, purchasedAt: 1 },
      { purchaseEventKey: 'e', units: 1, purchasedAt: 1 },
      { purchaseEventKey: 'e', units: 1, purchasedAt: 1 },
    ]).facts;
    const f2 = aggregatePurchaseMemoryFacts([
      { purchaseEventKey: 'e', units: 1, purchasedAt: 1 },
      { purchaseEventKey: 'e', units: 1, purchasedAt: 1 },
      { purchaseEventKey: 'e', units: 1e16, purchasedAt: 1 },
    ]).facts;
    expect(f1.totalUnitsPurchased).toBe(f2.totalUnitsPurchased);
  });

  test('32: multiple event rows reverse => identical facts', () => {
    const obs: PurchaseMemoryObservation[] = [
      { purchaseEventKey: 'z', units: 1, purchasedAt: 300 },
      { purchaseEventKey: 'a', units: 2, purchasedAt: 100 },
      { purchaseEventKey: 'm', units: 1, purchasedAt: 200 },
    ];
    expect(aggregatePurchaseMemoryFacts(obs).facts).toEqual(
      aggregatePurchaseMemoryFacts([...obs].reverse()).facts
    );
  });

  test('33: ordinary integer quantities', () => {
    const { facts } = aggregatePurchaseMemoryFacts([
      { purchaseEventKey: 'e1', units: 1, purchasedAt: 1 },
      { purchaseEventKey: 'e1', units: 2, purchasedAt: 1 },
    ]);
    expect(facts.distinctPurchaseEventCount).toBe(1);
    expect(facts.totalUnitsPurchased).toBe(3);
  });
});

describe('B1.1.1 query / provider', () => {
  test('34: one-field ProductKnowledgeQuery validates', () => {
    const v = validateProductKnowledgeQuery({ normalizedName: 'Product A' });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.query.normalizedName).toBe('Product A');
    }
  });

  test('35: empty query runtime invalid', () => {
    const v = validateProductKnowledgeQuery({});
    expect(v.ok).toBe(false);
    expect(v.reasonCodes).toContain('invalid_query');
  });

  test('36: whitespace query invalid', () => {
    expect(
      validateProductKnowledgeQuery({ merchantKey: '  ', janCode: '\t' }).ok
    ).toBe(false);
  });

  test('37: validator returns validated query', () => {
    const v = validateProductKnowledgeQuery({
      merchantKey: 'M',
      comparisonKey: 'K',
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.reasonCodes).toContain('query_semantics=AND');
      const empty = createEmptyProductKnowledgeProvider('empty');
      expect(empty.lookup(v.query).status).toBe('no_match');
    }
  });

  test('38: empty provider valid validated query => no_match', () => {
    const v = validateProductKnowledgeQuery({ skuId: 'S1' });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(createEmptyProductKnowledgeProvider('p').lookup(v.query).status).toBe(
        'no_match'
      );
    }
  });

  test('39: only unresolved records => unresolved', () => {
    const n = normalizeProductKnowledgeLookupResult([
      pkRecord({
        id: 'u1',
        knowledgeKind: 'product_alias',
        scope: 'personal',
        sourceTier: 'unresolved',
      }),
    ]);
    expect(n.status).toBe('unresolved');
    expect(n.records).toHaveLength(1);
  });

  test('40: unresolved + resolved => matched path', () => {
    const n = normalizeProductKnowledgeLookupResult([
      pkRecord({
        id: 'u1',
        knowledgeKind: 'product_alias',
        scope: 'personal',
        sourceTier: 'unresolved',
      }),
      pkRecord({
        id: 'r1',
        knowledgeKind: 'product_alias',
        scope: 'personal',
        sourceTier: 'local_rule',
        claimKey: 'alias',
        canonicalName: 'Product A',
      }),
    ]);
    expect(n.status).toBe('matched');
  });

  test('41: resolved disagreement => conflict', () => {
    const n = normalizeProductKnowledgeLookupResult([
      pkRecord({
        id: 'r1',
        knowledgeKind: 'product_spec',
        scope: 'personal',
        sourceTier: 'local_rule',
        claimKey: 'pack',
        canonicalName: 'A',
      }),
      pkRecord({
        id: 'r2',
        knowledgeKind: 'product_spec',
        scope: 'personal',
        sourceTier: 'ai',
        claimKey: 'pack',
        canonicalName: 'B',
      }),
    ]);
    expect(n.status).toBe('conflict');
  });

  test('42: reverse provider record order => identical result', () => {
    const rows = [
      pkRecord({
        id: 'b',
        knowledgeKind: 'product_alias',
        scope: 'personal',
        sourceTier: 'local_rule',
        confidence: 0.5,
      }),
      pkRecord({
        id: 'a',
        knowledgeKind: 'product_alias',
        scope: 'personal',
        sourceTier: 'local_rule',
        confidence: 0.9,
      }),
    ];
    const n1 = normalizeProductKnowledgeLookupResult(rows);
    const n2 = normalizeProductKnowledgeLookupResult([...rows].reverse());
    expect(n1.status).toBe(n2.status);
    expect(n1.records.map((r) => r.id)).toEqual(n2.records.map((r) => r.id));
  });
});

describe('B1.1.1 remaining regressions', () => {
  test('pattern evidence still gated', () => {
    const { facts } = aggregatePurchaseMemoryFacts(sevenEvents());
    expect(
      evaluatePurchaseMemory({
        facts,
        evidence: {
          identity: confirmedIdentity(),
          frequencyEvidence: freqSignal({ trusted: false }),
        },
      }).stage
    ).toBe('repeated');
    expect(
      evaluatePurchaseMemory({
        facts,
        evidence: {
          identity: confirmedIdentity(),
          frequencyEvidence: freqSignal(),
          cycleEvidence: cycleSignal(),
        },
      }).stage
    ).toBe('cycle_candidate');
  });

  test('0 events => stage null', () => {
    expect(
      evaluatePurchaseMemory({
        facts: {
          distinctPurchaseEventCount: 0,
          totalUnitsPurchased: 0,
          firstPurchasedAt: null,
          lastPurchasedAt: null,
        },
        evidence: { identity: confirmedIdentity() },
      }).stage
    ).toBeNull();
  });

  test('blank keys not counted', () => {
    const { facts } = aggregatePurchaseMemoryFacts([
      { purchaseEventKey: '  ', units: 1, purchasedAt: 1 },
      { purchaseEventKey: '', units: 1, purchasedAt: 2 },
    ]);
    expect(facts.distinctPurchaseEventCount).toBe(0);
  });

  test('units NaN => totalUnits null', () => {
    expect(
      aggregatePurchaseMemoryFacts([
        { purchaseEventKey: 'e', units: Number.NaN, purchasedAt: 1 },
      ]).facts.totalUnitsPurchased
    ).toBeNull();
  });

  test('claimKey may differ from knowledgeKind', () => {
    expect(
      validateKnowledgeRecord(
        cand({
          id: 'x',
          knowledgeKind: 'product_spec',
          claimKey: 'merchant-product-123:pack-size',
          scope: 'personal',
          sourceTier: 'local_rule',
          claimValue: 6,
        })
      ).ok
    ).toBe(true);
  });

  test('global_verified empty evidence still rejected', () => {
    expect(
      validateKnowledgeRecord(
        cand({
          id: 'x',
          knowledgeKind: 'product_spec',
          scope: 'global_verified',
          sourceTier: 'global_verified',
          claimValue: '1',
          evidence: [],
        })
      ).ok
    ).toBe(false);
  });

  test('confidence >1 rejected', () => {
    expect(
      validateKnowledgeRecord(
        cand({
          id: 'x',
          knowledgeKind: 'product_alias',
          scope: 'personal',
          sourceTier: 'local_rule',
          claimValue: '1',
          confidence: 1.1,
        })
      ).ok
    ).toBe(false);
  });
});

describe('B1.1.2 authority seal', () => {
  test('1: resolveAuthorityKind not exported from public barrel', () => {
    expect(
      (foundation as Record<string, unknown>).resolveAuthorityKind
    ).toBeUndefined();
  });

  test('2: invalid purchase_frequency global_verified rejected before selection', () => {
    const bad = cand({
      id: 'bad',
      knowledgeKind: 'purchase_frequency',
      claimKey: 'purchase_frequency',
      scope: 'global_verified',
      sourceTier: 'global_verified',
      claimValue: 'weekly',
      confidence: 1,
      evidence: ['agg'],
    });
    const r = selectBestKnowledgeCandidate([bad]);
    expect(r.selected).toBeNull();
    expect(r.authorityKind).toBe('none');
    expect(validateKnowledgeRecord(bad).ok).toBe(false);
  });

  test('3: valid global_verified product_spec => authorityKind global_verified', () => {
    const r = selectBestKnowledgeCandidate([
      cand({
        id: 'gv',
        knowledgeKind: 'product_spec',
        scope: 'global_verified',
        sourceTier: 'global_verified',
        claimValue: '6',
        evidence: ['published'],
      }),
    ]);
    expect(r.authorityKind).toBe('global_verified');
    expect(isGloballyVerifiedSelection(r)).toBe(true);
  });

  test('4: valid personal local_rule => local_preferred', () => {
    const r = selectBestKnowledgeCandidate([
      cand({
        id: 'lr',
        knowledgeKind: 'product_alias',
        scope: 'personal',
        sourceTier: 'local_rule',
        claimValue: 'A',
      }),
    ]);
    expect(r.authorityKind).toBe('local_preferred');
  });
});

describe('B1.1.2 query malformed-field fail-closed', () => {
  test('8: merchantKey number + comparisonKey => invalid_query', () => {
    const v = validateProductKnowledgeQuery({
      merchantKey: 42,
      comparisonKey: 'K',
    });
    expect(v.ok).toBe(false);
    expect(v.reasonCodes).toContain('invalid_query');
    expect(v.reasonCodes).toContain('malformed_discriminator=merchantKey');
  });

  test('9: merchantKey null + comparisonKey => invalid_query', () => {
    const v = validateProductKnowledgeQuery({
      merchantKey: null,
      comparisonKey: 'K',
    });
    expect(v.ok).toBe(false);
    expect(v.reasonCodes).toContain('malformed_discriminator=merchantKey');
  });

  test('10: merchantKey whitespace + comparisonKey => invalid_query', () => {
    const v = validateProductKnowledgeQuery({
      merchantKey: ' ',
      comparisonKey: 'K',
    });
    expect(v.ok).toBe(false);
    expect(v.reasonCodes).toContain('malformed_discriminator=merchantKey');
  });

  test('11: merchantKey M + comparisonKey K => valid AND semantics', () => {
    const v = validateProductKnowledgeQuery({
      merchantKey: 'M',
      comparisonKey: 'K',
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.query.merchantKey).toBe('M');
      expect(v.query.comparisonKey).toBe('K');
      expect(v.reasonCodes).toContain('query_semantics=AND');
    }
  });

  test('12: single-field valid query => valid', () => {
    expect(validateProductKnowledgeQuery({ normalizedName: 'Product A' }).ok).toBe(
      true
    );
  });

  test('merchantKey object + comparisonKey => invalid_query', () => {
    const v = validateProductKnowledgeQuery({
      merchantKey: {},
      comparisonKey: 'K',
    });
    expect(v.ok).toBe(false);
    expect(v.reasonCodes).toContain('malformed_discriminator=merchantKey');
  });
});

describe('B1.1.2 validated query immutability', () => {
  test('4: validated query is frozen', () => {
    const v = validateProductKnowledgeQuery({ comparisonKey: 'ABC' });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(Object.isFrozen(v.query)).toBe(true);
    }
  });

  test('5: validated query fields are trimmed', () => {
    const v = validateProductKnowledgeQuery({ comparisonKey: '  ABC  ' });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.query.comparisonKey).toBe('ABC');
    }
  });

  test('6: mutation attempt does not change validated query value', () => {
    const v = validateProductKnowledgeQuery({ comparisonKey: 'ABC' });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const before = v.query.comparisonKey;
    try {
      (v.query as { comparisonKey: string }).comparisonKey = 'XYZ';
    } catch {
      // Object.freeze throws in strict assignment contexts.
    }
    expect(v.query.comparisonKey).toBe(before);
    expect(v.query.comparisonKey).toBe('ABC');
  });

  test('7: caller raw input mutation does not affect validated query', () => {
    const raw = { comparisonKey: 'ABC' };
    const v = validateProductKnowledgeQuery(raw);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.query).not.toBe(raw);
    raw.comparisonKey = 'XYZ';
    expect(v.query.comparisonKey).toBe('ABC');
  });
});
