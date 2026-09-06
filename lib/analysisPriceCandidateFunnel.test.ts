/**
 * C2D AP-3 zero-candidate funnel diagnostics.
 */
/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import {
  assertAp3CandidateFunnelInvariants,
  assertAp3MpAmountBasisInvariants,
  assertAp3MpHistoryComparabilityInvariants,
  assertAp3MpMonetaryLayerInvariants,
  assertAp3MpNeitherCloseInvariants,
  classifyNeitherCloseResiduals,
  createEmptyAp3CandidateFunnel,
  emitAp3CandidateFunnel,
  recordAp3InterpretUnavailableReasons,
  recordAp3MpNeitherCloseShape,
  recordAp3MpNotEnoughPointsComparability,
  recordAp3MpTerminal,
  recordAp3SkuTerminal,
  setAp3NeitherCloseDiagnosticsEnabledForTests,
  setAp3TaxProvenanceDiagnosticsEnabledForTests,
  assertAp3MpTaxProvenanceInvariants,
  createAp3TaxProvenanceReceiptMemo,
  shouldRecordAp3NeitherCloseDiagnostics,
} from './analysisPriceCandidateFunnel';
import {
  collectAnalysisTrustedPriceChangeCandidatesWithFunnel,
  collectAnalysisTrustedPriceChangeCandidatesAsync,
  isMerchantProductDuplicateOfSku,
  merchantProductInterpretationPurchasePointsApproved,
  type AnalysisTrustedPriceChangeCandidate,
} from './analysisTrustedPriceChanges';
import type { PreparedAnalysisPriceInsightContext } from './analysisPricePreparedContext';
import type { ProductPriceHistoryResult } from './productPriceHistory';
import type { ProductPriceChangeInterpretation } from './productPriceChangeInterpretation';
import {
  getDiagnosticSnapshot,
  internalDiagnostics,
  recordDiagnosticEvent,
  clearDiagnostics,
} from './internalDiagnostics';
import { setInternalDiagnosticsEnabledForTests } from './internalDiagnosticsGate';
import {
  __resetAnalysisPriceSessionCacheForTests,
  buildAnalysisPriceSnapshotSignature,
  readAnalysisPriceDomainCache,
  writeAnalysisPriceDomainCache,
} from './analysisPriceSessionCache';
import { scheduleDeriveAnalysisPriceDomain } from './analysisPriceDerivation';
import { createAnalysisPriceGeneration } from './analysisPriceScheduler';
import * as analysisTrustedPriceChanges from './analysisTrustedPriceChanges';
import * as internalDiagnosticsModule from './internalDiagnostics';

function emptyPrepared(
  overrides: Partial<PreparedAnalysisPriceInsightContext> = {}
): PreparedAnalysisPriceInsightContext {
  return {
    rows: [],
    seedReceiptIds: new Set(),
    qualified: [],
    rowByKey: new Map(),
    rowIdentityMetadata: new Map(),
    receiptEvidenceCache: new Map(),
    skuBuckets: new Map(),
    merchantProductBuckets: new Map(),
    merchantProductIdentityViews: new Map(),
    seededSkuKeys: new Set(),
    seededMerchantProductIds: new Set(),
    ...overrides,
  };
}

function makeRow(receiptId: string, skuKey?: string) {
  return {
    receiptId,
    sourceIndex: 0,
    skuKey: skuKey ?? null,
  } as never;
}

function availableInterp(
  direction: 'increased' | 'unchanged' = 'increased'
): ProductPriceChangeInterpretation {
  return {
    status: 'available',
    identityAuthority: { kind: 'sku', skuKey: 'sku-a' },
    grossDirection: direction,
    grossDelta: direction === 'unchanged' ? 0 : 10,
    promoTransition: 'none',
    previousPromo: 'none_observed',
    currentPromo: 'none_observed',
    previousDiscountAllocated: null,
    currentDiscountAllocated: null,
    current: {
      receiptId: 'r-cur',
      occurredAt: 200,
      priceValue: 110,
      grossLineAmount: 110,
      purchaseQuantity: 1,
      currency: 'JPY',
      priceKind: 'unit',
      amountBasis: 'tax_included',
      promoContext: { markers: [], explicitDiscount: false },
      promoState: 'none_observed',
      discountAllocated: null,
      effectiveLineAmount: null,
      skuKey: 'sku-a',
    },
    previous: {
      receiptId: 'r-prev',
      occurredAt: 100,
      priceValue: 100,
      grossLineAmount: 100,
      purchaseQuantity: 1,
      currency: 'JPY',
      priceKind: 'unit',
      amountBasis: 'tax_included',
      promoContext: { markers: [], explicitDiscount: false },
      promoState: 'none_observed',
      discountAllocated: null,
      effectiveLineAmount: null,
      skuKey: 'sku-a',
    },
  } as unknown as ProductPriceChangeInterpretation;
}

function unavailableInterp(
  reason: ProductPriceChangeInterpretation extends { status: 'unavailable' }
    ? never
    : string
): ProductPriceChangeInterpretation {
  return {
    status: 'unavailable',
    reasonCodes: [reason as never],
  };
}

function readyHistory(
  status: ProductPriceHistoryResult['status'] = 'ready'
): ProductPriceHistoryResult {
  return {
    target: { type: 'sku', key: 'sku-a' },
    status,
    priceKind: 'purchase_unit',
    currency: 'JPY',
    totalOccurrenceCount: 2,
    comparableOccurrenceCount: 2,
    excludedOccurrenceCount: 0,
    points: [],
    observations: [],
    seriesKind: 'gross',
    amountBasis: 'tax_included',
    canonicalDuplicateSelectionApplied: true,
    identityPresentation: null,
  } as ProductPriceHistoryResult;
}

describe('AP-3 candidate funnel accounting', () => {
  it('SKU terminal partition invariant', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3SkuTerminal(funnel, 'bucket_lt_2');
    recordAp3SkuTerminal(funnel, 'interpret_unavailable');
    recordAp3SkuTerminal(funnel, 'unchanged');
    recordAp3SkuTerminal(funnel, 'changed');
    recordAp3SkuTerminal(funnel, 'exception');
    funnel.finalCandidateCount = 1;
    expect(assertAp3CandidateFunnelInvariants(funnel)).toBe(true);
  });

  it('MP changed before duplicate; final = skuChanged + mpChanged - dup', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3SkuTerminal(funnel, 'changed');
    recordAp3MpTerminal(funnel, 'changed');
    recordAp3MpTerminal(funnel, 'changed');
    funnel.mpDuplicateOfSku = 1;
    funnel.finalCandidateCount = 2; // 1 sku + 1 mp kept
    expect(assertAp3CandidateFunnelInvariants(funnel)).toBe(true);
  });

  it('N — primary interpret reason mapping + history-not-ready detail', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3InterpretUnavailableReasons(
      funnel,
      'sku',
      ['history_not_ready', 'quality_not_trusted'],
      'not_enough_points'
    );
    expect(funnel.skuReasonHistoryNotReady).toBe(1);
    expect(funnel.skuReasonQualityNotTrusted).toBe(0);
    expect(funnel.skuHistNotEnoughPoints).toBe(1);
  });
});

describe('AP-3 candidate funnel production path', () => {
  beforeEach(() => {
    setInternalDiagnosticsEnabledForTests(true);
    internalDiagnostics.resetForTests(undefined, {
      hydrated: true,
      debounceMs: 0,
    });
    __resetAnalysisPriceSessionCacheForTests();
  });

  afterEach(async () => {
    internalDiagnostics.resetForTests(undefined, {
      hydrated: true,
      debounceMs: 0,
    });
    await internalDiagnostics.drainStorageForTests();
    setInternalDiagnosticsEnabledForTests(false);
  });

  afterAll(() => {
    setInternalDiagnosticsEnabledForTests(null);
  });

  it('A — SKU bucket <2', () => {
    const prepared = emptyPrepared({
      seededSkuKeys: new Set(['sku-a']),
      skuBuckets: new Map([['sku-a', [makeRow('r1', 'sku-a')]]]),
    });
    const { funnel } = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
    });
    expect(funnel.skuAttempted).toBe(1);
    expect(funnel.skuBucketLt2).toBe(1);
    expect(funnel.skuChanged).toBe(0);
    expect(funnel.finalCandidateCount).toBe(0);
    expect(assertAp3CandidateFunnelInvariants(funnel)).toBe(true);
  });

  it('B/N — SKU interpretation unavailable + reason', () => {
    const prepared = emptyPrepared({
      seededSkuKeys: new Set(['sku-a']),
      skuBuckets: new Map([
        ['sku-a', [makeRow('r1', 'sku-a'), makeRow('r2', 'sku-a')]],
      ]),
    });
    const { funnel } = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => readyHistory('not_enough_points'),
      interpretChange: () => unavailableInterp('history_not_ready'),
    });
    expect(funnel.skuInterpretUnavailable).toBe(1);
    expect(funnel.skuReasonHistoryNotReady).toBe(1);
    expect(funnel.skuHistNotEnoughPoints).toBe(1);
    expect(assertAp3CandidateFunnelInvariants(funnel)).toBe(true);
  });

  it('C — SKU unchanged', () => {
    const prepared = emptyPrepared({
      seededSkuKeys: new Set(['sku-a']),
      skuBuckets: new Map([
        ['sku-a', [makeRow('r1', 'sku-a'), makeRow('r2', 'sku-a')]],
      ]),
    });
    const { funnel } = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => readyHistory(),
      interpretChange: () => availableInterp('unchanged'),
    });
    expect(funnel.skuUnchanged).toBe(1);
    expect(funnel.finalCandidateCount).toBe(0);
  });

  it('D/O — SKU changed', () => {
    const prepared = emptyPrepared({
      seededSkuKeys: new Set(['sku-a']),
      skuBuckets: new Map([
        ['sku-a', [makeRow('r1', 'sku-a'), makeRow('r2', 'sku-a')]],
      ]),
    });
    const { candidates, funnel } =
      collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
        rows: [],
        seedReceiptIds: new Set(),
        prepared,
        buildHistory: () => readyHistory(),
        interpretChange: () => availableInterp('increased'),
      });
    expect(funnel.skuChanged).toBe(1);
    expect(candidates).toHaveLength(1);
    expect(funnel.finalCandidateCount).toBe(1);
    expect(assertAp3CandidateFunnelInvariants(funnel)).toBe(true);
  });

  it('E — SKU exception', () => {
    const prepared = emptyPrepared({
      seededSkuKeys: new Set(['sku-a']),
      skuBuckets: new Map([
        ['sku-a', [makeRow('r1', 'sku-a'), makeRow('r2', 'sku-a')]],
      ]),
    });
    const { funnel } = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => {
        throw new Error('boom');
      },
    });
    expect(funnel.skuException).toBe(1);
    expect(funnel.finalCandidateCount).toBe(0);
    expect(assertAp3CandidateFunnelInvariants(funnel)).toBe(true);
  });

  it('F — MP bucket <2', () => {
    const prepared = emptyPrepared({
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([['mp-a', [makeRow('r1')]]]),
      merchantProductIdentityViews: new Map([['mp-a', { merchantProductId: 'mp-a' } as never]]),
    });
    const { funnel } = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
    });
    expect(funnel.mpBucketLt2).toBe(1);
  });

  it('G — MP identity view missing', () => {
    const prepared = emptyPrepared({
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([
        ['mp-a', [makeRow('r1'), makeRow('r2')]],
      ]),
      merchantProductIdentityViews: new Map(),
    });
    const { funnel } = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
    });
    expect(funnel.mpMissingIdentityView).toBe(1);
  });

  it('H — MP interpretation unavailable', () => {
    const prepared = emptyPrepared({
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([
        ['mp-a', [makeRow('r1'), makeRow('r2')]],
      ]),
      merchantProductIdentityViews: new Map([
        ['mp-a', { merchantProductId: 'mp-a' } as never],
      ]),
    });
    const { funnel } = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => readyHistory('mixed_currency'),
      interpretChange: () => unavailableInterp('history_not_ready'),
    });
    expect(funnel.mpInterpretUnavailable).toBe(1);
    expect(funnel.mpReasonHistoryNotReady).toBe(1);
    expect(funnel.mpHistMixedCurrency).toBe(1);
  });

  it('I — MP unchanged', () => {
    const prepared = emptyPrepared({
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([
        ['mp-a', [makeRow('r1'), makeRow('r2')]],
      ]),
      merchantProductIdentityViews: new Map([
        ['mp-a', { merchantProductId: 'mp-a' } as never],
      ]),
    });
    const { funnel } = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => readyHistory(),
      interpretChange: () => availableInterp('unchanged'),
    });
    expect(funnel.mpUnchanged).toBe(1);
  });

  it('J — MP approval rejected', () => {
    const prepared = emptyPrepared({
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([
        ['mp-a', [makeRow('r1'), makeRow('r2')]],
      ]),
      merchantProductIdentityViews: new Map([
        ['mp-a', { merchantProductId: 'mp-a' } as never],
      ]),
    });
    const { funnel } = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => readyHistory(),
      interpretChange: () => availableInterp('increased'),
    });
    // Without approved exact provenance points, approval fails.
    expect(funnel.mpApprovalRejected).toBe(1);
    expect(funnel.mpChanged).toBe(0);
  });

  it('K/L — MP changed + duplicate-of-SKU', () => {
    const skuCand: AnalysisTrustedPriceChangeCandidate = {
      target: { type: 'sku', key: 'sku-a' },
      displayName: 'x',
      comparableOccurrenceCount: 2,
      latestOccurredAt: 2,
      interpretation: availableInterp('increased') as Extract<
        ProductPriceChangeInterpretation,
        { status: 'available' }
      >,
    };
    // Force approval pass by stubbing history points to approved sources.
    const approvedHistory = {
      ...readyHistory(),
      points: [
        {
          receiptId: 'r-cur',
          qualityLevel: 'trusted',
          identityLevel: 'merchant_product',
          merchantProductId: 'mp-a',
          identitySource: 'normalized_exact',
        },
        {
          receiptId: 'r-prev',
          qualityLevel: 'trusted',
          identityLevel: 'merchant_product',
          merchantProductId: 'mp-a',
          identitySource: 'alias_exact',
        },
      ],
    } as ProductPriceHistoryResult;

    const mpInterp = availableInterp('increased') as Extract<
      ProductPriceChangeInterpretation,
      { status: 'available' }
    >;
    mpInterp.current.skuKey = 'sku-a';
    mpInterp.previous.skuKey = 'sku-a';
    expect(
      merchantProductInterpretationPurchasePointsApproved(
        approvedHistory,
        mpInterp
      )
    ).toBe(true);
    expect(
      isMerchantProductDuplicateOfSku(
        {
          target: { type: 'merchant_product', key: 'mp-a' },
          displayName: 'x',
          comparableOccurrenceCount: 2,
          latestOccurredAt: 2,
          interpretation: mpInterp,
        },
        new Set(['r-cur:sku-a', 'r-prev:sku-a'])
      )
    ).toBe(true);

    const prepared = emptyPrepared({
      seededSkuKeys: new Set(['sku-a']),
      seededMerchantProductIds: new Set(['mp-a']),
      skuBuckets: new Map([
        ['sku-a', [makeRow('r1', 'sku-a'), makeRow('r2', 'sku-a')]],
      ]),
      merchantProductBuckets: new Map([
        ['mp-a', [makeRow('r1'), makeRow('r2')]],
      ]),
      merchantProductIdentityViews: new Map([
        ['mp-a', { merchantProductId: 'mp-a' } as never],
      ]),
    });

    const { candidates, funnel } =
      collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
        rows: [],
        seedReceiptIds: new Set(),
        prepared,
        buildHistory: (target) =>
          target.type === 'sku' ? readyHistory() : approvedHistory,
        interpretChange: ({ targetType }) => {
          if (targetType === 'sku') return availableInterp('increased');
          return mpInterp;
        },
      });

    expect(funnel.skuChanged).toBe(1);
    expect(funnel.mpChanged).toBe(1);
    expect(funnel.mpDuplicateOfSku).toBe(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.target.type).toBe('sku');
    expect(funnel.finalCandidateCount).toBe(1);
    expect(assertAp3CandidateFunnelInvariants(funnel)).toBe(true);
    void skuCand;
  });

  it('M — MP exception', () => {
    const prepared = emptyPrepared({
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([
        ['mp-a', [makeRow('r1'), makeRow('r2')]],
      ]),
      merchantProductIdentityViews: new Map([
        ['mp-a', { merchantProductId: 'mp-a' } as never],
      ]),
    });
    const { funnel } = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => {
        throw new Error('mp boom');
      },
    });
    expect(funnel.mpException).toBe(1);
  });

  it('P — canceled derivation does not emit completed funnel', async () => {
    const result = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:u',
      analyticsReceipts: [{ id: 'r1' } as never],
      rows: [],
      receiptFingerprints: ['r1:0'],
      generation: createAnalysisPriceGeneration(),
      deferUntilPaint: false,
      shouldCancel: () => true,
    }).promise;
    expect(result.status).toBe('canceled');
    const names = getDiagnosticSnapshot().events.map((e) => e.name);
    expect(names).not.toContain('ap3_candidate_funnel');
    expect(names).not.toContain('ap3_candidate_funnel_mp_history_summary');
    expect(names).not.toContain('ap3_candidate_funnel_mp_observation_reasons');
  });

  it('P2 — late-stale after collect before funnel emit does not emit completed funnel', async () => {
    let collectResolved = false;
    const emptyFunnel = createEmptyAp3CandidateFunnel();
    const collectSpy = jest
      .spyOn(
        analysisTrustedPriceChanges,
        'collectAnalysisTrustedPriceChangeCandidatesAsync'
      )
      .mockImplementation(async () => {
        collectResolved = true;
        return { candidates: [], funnel: emptyFunnel };
      });

    let postCollectStaleChecks = 0;
    const result = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:u-late-stale',
      analyticsReceipts: [{ id: 'r1' } as never],
      rows: [],
      receiptFingerprints: ['r1:late-stale'],
      generation: createAnalysisPriceGeneration(),
      deferUntilPaint: false,
      shouldCancel: () => {
        if (!collectResolved) return false;
        postCollectStaleChecks += 1;
        // First post-collect check passes; final pre-emission boundary is stale.
        return postCollectStaleChecks >= 2;
      },
    }).promise;

    expect(result.status).toBe('canceled');
    expect(postCollectStaleChecks).toBeGreaterThanOrEqual(2);
    const names = getDiagnosticSnapshot().events.map((e) => e.name);
    expect(names).not.toContain('ap3_candidate_funnel');
    expect(names).not.toContain('ap3_candidate_funnel_sku_reasons');
    expect(names).not.toContain('ap3_candidate_funnel_mp_reasons');
    expect(names).not.toContain('ap3_candidate_funnel_history');
    expect(names).not.toContain('ap3_candidate_funnel_mp_history_summary');
    expect(names).not.toContain('ap3_candidate_funnel_mp_observation_reasons');
    collectSpy.mockRestore();
  });

  it('S — funnel diagnostics emission failure does not change AP-3 product derivation', async () => {
    const actualRecord = recordDiagnosticEvent;
    const diagSpy = jest
      .spyOn(internalDiagnosticsModule, 'recordDiagnosticEvent')
      .mockImplementation((event) => {
        if (
          typeof event?.name === 'string' &&
          event.name.startsWith('ap3_candidate_funnel')
        ) {
          throw new Error('diag boom');
        }
        return actualRecord(event);
      });

    const result = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:u-diag-fail',
      analyticsReceipts: [{ id: 'r1' } as never],
      rows: [],
      receiptFingerprints: ['r1:diag-fail'],
      generation: createAnalysisPriceGeneration(),
      deferUntilPaint: false,
    }).promise;

    expect(result.status).not.toBe('canceled');
    expect(result.cacheHit).toBe(false);
    expect(['available', 'unavailable']).toContain(result.status);
    expect(result.candidates).toEqual([]);

    const signature = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'user:u-diag-fail',
      seedReceiptIds: ['r1'],
      receiptFingerprints: ['r1:diag-fail'],
      insightRowCount: 0,
    });
    const cached = readAnalysisPriceDomainCache(signature);
    expect(cached).not.toBeNull();
    expect(cached?.candidates).toEqual([]);

    const names = getDiagnosticSnapshot().events.map((e) => e.name);
    expect(names).toContain('ap3_candidates');
    expect(names).toContain('ap3_total');
    expect(names).not.toContain('ap3_candidate_funnel');
    diagSpy.mockRestore();
  });

  it('Q — cache hit does not fabricate a funnel', async () => {
    const signature = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'user:u',
      seedReceiptIds: ['r1'],
      receiptFingerprints: ['r1:1'],
      insightRowCount: 0,
    });
    writeAnalysisPriceDomainCache({
      signature,
      candidates: [],
      generationMatches: true,
    });
    const result = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:u',
      analyticsReceipts: [{ id: 'r1' } as never],
      rows: [],
      receiptFingerprints: ['r1:1'],
      generation: createAnalysisPriceGeneration(),
      deferUntilPaint: false,
    }).promise;
    expect(result.cacheHit).toBe(true);
    const names = getDiagnosticSnapshot().events.map((e) => e.name);
    expect(names).not.toContain('ap3_candidate_funnel');
    expect(names).not.toContain('ap3_candidate_funnel_mp_history_summary');
    expect(names).not.toContain('ap3_candidate_funnel_mp_observation_reasons');
  });

  it('R — funnel meta is primitive counters only (no ids/names)', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    funnel.seededSkuCount = 3;
    funnel.skuAttempted = 3;
    funnel.skuBucketLt2 = 3;
    emitAp3CandidateFunnel(funnel);
    const events = getDiagnosticSnapshot().events.filter((e) =>
      e.name.startsWith('ap3_candidate_funnel')
    );
    expect(events.length).toBe(10);
    const payload = JSON.stringify(events);
    expect(payload).not.toMatch(/sku-[a-z0-9-]{4,}|mp-[a-z0-9-]{4,}/i);
    expect(payload).not.toMatch(/"displayName"|"merchantRaw"|¥[0-9]/);
    for (const event of events) {
      expect(Object.keys(event.meta ?? {}).length).toBeLessThanOrEqual(24);
      for (const value of Object.values(event.meta ?? {})) {
        expect(typeof value).toBe('number');
      }
    }
    const core = events.find((e) => e.name === 'ap3_candidate_funnel');
    expect(core?.meta?.seededSkuCount).toBe(3);
  });
});

describe('AP-3 MP history comparability breakdown', () => {
  beforeEach(() => {
    setInternalDiagnosticsEnabledForTests(true);
    internalDiagnostics.resetForTests(undefined, {
      hydrated: true,
      debounceMs: 0,
    });
    __resetAnalysisPriceSessionCacheForTests();
  });

  afterEach(async () => {
    internalDiagnostics.resetForTests(undefined, {
      hydrated: true,
      debounceMs: 0,
    });
    await internalDiagnostics.drainStorageForTests();
    setInternalDiagnosticsEnabledForTests(false);
  });

  afterAll(() => {
    setInternalDiagnosticsEnabledForTests(null);
  });

  function identityView(historyPointCount: number) {
    return {
      merchantProductId: 'mp-a',
      historyPoints: Array.from({ length: historyPointCount }, (_, i) => ({
        receiptId: `hp-${i}`,
        itemSourceIndex: 0,
        occurredAt: i + 1,
        rawName: 'x',
        purchaseUnitPrice: 100,
        quality: 'trusted',
      })),
    } as never;
  }

  function obs(
    eligible: boolean,
    reasons: string[]
  ): ProductPriceHistoryResult['observations'][number] {
    return {
      receiptId: 'r',
      itemId: 'i',
      sourceIndex: 0,
      occurredAt: 1,
      level: 1,
      seriesKind: 'gross',
      grossLineAmount: 100,
      effectiveLineAmount: null,
      purchaseQuantity: 1,
      currency: 'JPY',
      amountProvenance: null,
      itemAmountEvidenceState: null,
      priceObservationVersion: null,
      amountBasis: null,
      exactComparisonTrusted: false,
      monetaryCoherenceState: null,
      monetaryProvenanceSufficient: false,
      discountOwnershipStatus: null,
      promoContext: 'none_observed',
      promoMarkers: [],
      level2Eligible: eligible,
      level2RejectReasons: reasons,
      qualityLevel: null,
      discountAllocated: null,
    } as never;
  }

  function notEnoughHistory(overrides: {
    observations?: ProductPriceHistoryResult['observations'];
    pointsLength?: number;
  } = {}): ProductPriceHistoryResult {
    const pointsLength = overrides.pointsLength ?? 0;
    return {
      ...readyHistory('not_enough_points'),
      target: { type: 'merchant_product', key: 'mp-a' },
      observations: overrides.observations ?? [],
      points: Array.from({ length: pointsLength }, (_, i) => ({
        receiptId: `p-${i}`,
        occurredAt: i + 1,
      })) as never,
      comparableOccurrenceCount: pointsLength,
    };
  }

  function collectCohort(input: {
    identityPointCount: number;
    history: ProductPriceHistoryResult;
  }) {
    const prepared = emptyPrepared({
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([
        ['mp-a', [makeRow('r1'), makeRow('r2')]],
      ]),
      merchantProductIdentityViews: new Map([
        ['mp-a', identityView(input.identityPointCount)],
      ]),
    });
    return collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => input.history,
      interpretChange: () => unavailableInterp('history_not_ready'),
    });
  }

  it('A — membership >=2 but identityRows = 0', () => {
    const { funnel } = collectCohort({
      identityPointCount: 0,
      history: notEnoughHistory({
        observations: [obs(false, ['legacy_unbackfilled']), obs(false, ['legacy_unbackfilled'])],
      }),
    });
    expect(funnel.mpHistoryTargetCount).toBe(1);
    expect(funnel.mpHistoryMembershipRowsTotal).toBe(2);
    expect(funnel.mpHistoryIdentityRowsTotal).toBe(0);
    expect(funnel.mpHistoryTargetsIdentityRows0).toBe(1);
    expect(funnel.mpHistoryTargetsWith0ComparablePoints).toBe(1);
    expect(assertAp3MpHistoryComparabilityInvariants(funnel)).toBe(true);
  });

  it('B — membership >=2 but identityRows = 1', () => {
    const { funnel } = collectCohort({
      identityPointCount: 1,
      history: notEnoughHistory({
        observations: [obs(false, ['legacy_unbackfilled']), obs(false, ['legacy_unbackfilled'])],
        pointsLength: 0,
      }),
    });
    expect(funnel.mpHistoryTargetsIdentityRows1).toBe(1);
    expect(funnel.mpHistoryIdentityRowsTotal).toBe(1);
  });

  it('C — identityRows >=2 but structural rejection leaves 0 points', () => {
    const { funnel } = collectCohort({
      identityPointCount: 2,
      history: notEnoughHistory({
        observations: [
          obs(false, ['monetary_incoherent']),
          obs(false, ['monetary_provenance_insufficient']),
        ],
        pointsLength: 0,
      }),
    });
    expect(funnel.mpHistoryTargetsIdentityRows2Plus).toBe(1);
    expect(funnel.mpHistoryTargetsWith0ComparablePoints).toBe(1);
    expect(funnel.mpObsMonetaryIncoherent).toBe(1);
    expect(funnel.mpObsMonetaryProvenanceInsufficient).toBe(1);
  });

  it('D — identityRows >=2 but quality rejection leaves <2 points', () => {
    const { funnel } = collectCohort({
      identityPointCount: 2,
      history: notEnoughHistory({
        observations: [
          obs(false, ['price_quality_invalid']),
          obs(true, []),
        ],
        pointsLength: 1,
      }),
    });
    expect(funnel.mpObsPriceQualityInvalid).toBe(1);
    expect(funnel.mpHistoryLevel2EligibleObservations).toBe(1);
    expect(funnel.mpHistoryRejectedObservations).toBe(1);
    expect(funnel.mpHistoryTargetsWith1ComparablePoints).toBe(1);
  });

  it('E — amount_basis_mismatch path', () => {
    const { funnel } = collectCohort({
      identityPointCount: 2,
      history: notEnoughHistory({
        observations: [
          obs(false, ['amount_basis_mismatch']),
          obs(false, ['amount_basis_mismatch']),
        ],
      }),
    });
    expect(funnel.mpObsAmountBasisMismatch).toBe(2);
  });

  it('F — legacy_unbackfilled', () => {
    const { funnel } = collectCohort({
      identityPointCount: 2,
      history: notEnoughHistory({
        observations: [
          obs(false, ['legacy_unbackfilled']),
          obs(false, ['legacy_unbackfilled']),
        ],
      }),
    });
    expect(funnel.mpObsLegacyUnbackfilled).toBe(2);
  });

  it('G — one observation with multiple reject reasons increments multiple counters', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: notEnoughHistory({
        observations: [
          obs(false, [
            'item_amount_evidence_state',
            'amount_basis_untrusted',
            'monetary_incoherent',
          ]),
        ],
      }),
    });
    expect(funnel.mpHistoryRejectedObservations).toBe(1);
    expect(funnel.mpObsItemAmountEvidenceState).toBe(1);
    expect(funnel.mpObsAmountBasisUntrusted).toBe(1);
    expect(funnel.mpObsMonetaryIncoherent).toBe(1);
    expect(
      funnel.mpObsItemAmountEvidenceState +
        funnel.mpObsAmountBasisUntrusted +
        funnel.mpObsMonetaryIncoherent
    ).toBeGreaterThan(funnel.mpHistoryRejectedObservations);
  });

  it('H — unknown reject reason increments only mpObsUnknownRejectReason', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 0,
      history: notEnoughHistory({
        observations: [obs(false, ['totally_made_up_reason'])],
      }),
    });
    expect(funnel.mpObsUnknownRejectReason).toBe(1);
    emitAp3CandidateFunnel(funnel);
    const payload = JSON.stringify(getDiagnosticSnapshot().events);
    expect(payload).not.toContain('totally_made_up_reason');
  });

  it('I — 0 comparable distribution', () => {
    const { funnel } = collectCohort({
      identityPointCount: 2,
      history: notEnoughHistory({ pointsLength: 0 }),
    });
    expect(funnel.mpHistoryTargetsWith0ComparablePoints).toBe(1);
    expect(funnel.mpHistoryComparablePoints).toBe(0);
  });

  it('J — 1 comparable distribution', () => {
    const { funnel } = collectCohort({
      identityPointCount: 2,
      history: notEnoughHistory({
        observations: [obs(true, []), obs(false, ['legacy_unbackfilled'])],
        pointsLength: 1,
      }),
    });
    expect(funnel.mpHistoryTargetsWith1ComparablePoints).toBe(1);
    expect(funnel.mpHistoryComparablePoints).toBe(1);
  });

  it('K — all accounting invariants', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 3,
      identityRowCount: 0,
      history: notEnoughHistory({
        observations: [obs(false, ['legacy_unbackfilled']), obs(true, [])],
        pointsLength: 0,
      }),
    });
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 1,
      history: notEnoughHistory({
        observations: [obs(false, ['price_quality_suspected_anomaly'])],
        pointsLength: 1,
      }),
    });
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 4,
      identityRowCount: 3,
      history: notEnoughHistory({
        observations: [
          obs(false, ['currency_not_jpy']),
          obs(false, ['invalid_gross_amount']),
        ],
        pointsLength: 0,
      }),
    });
    expect(funnel.mpHistoryTargetCount).toBe(3);
    expect(assertAp3MpHistoryComparabilityInvariants(funnel)).toBe(true);
    expect(assertAp3CandidateFunnelInvariants(funnel)).toBe(true);
  });

  it('L — canceled/stale derivation emits no completed breakdown', async () => {
    const result = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:u-break-cancel',
      analyticsReceipts: [{ id: 'r1' } as never],
      rows: [],
      receiptFingerprints: ['r1:0'],
      generation: createAnalysisPriceGeneration(),
      deferUntilPaint: false,
      shouldCancel: () => true,
    }).promise;
    expect(result.status).toBe('canceled');
    const names = getDiagnosticSnapshot().events.map((e) => e.name);
    expect(names).not.toContain('ap3_candidate_funnel_mp_history_summary');
    expect(names).not.toContain('ap3_candidate_funnel_mp_observation_reasons');
  });

  it('M — cache hit emits no breakdown', async () => {
    const signature = buildAnalysisPriceSnapshotSignature({
      ownerKey: 'user:u-break-cache',
      seedReceiptIds: ['r1'],
      receiptFingerprints: ['r1:cache'],
      insightRowCount: 0,
    });
    writeAnalysisPriceDomainCache({
      signature,
      candidates: [],
      generationMatches: true,
    });
    const result = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:u-break-cache',
      analyticsReceipts: [{ id: 'r1' } as never],
      rows: [],
      receiptFingerprints: ['r1:cache'],
      generation: createAnalysisPriceGeneration(),
      deferUntilPaint: false,
    }).promise;
    expect(result.cacheHit).toBe(true);
    const names = getDiagnosticSnapshot().events.map((e) => e.name);
    expect(names).not.toContain('ap3_candidate_funnel_mp_history_summary');
    expect(names).not.toContain('ap3_candidate_funnel_mp_observation_reasons');
  });

  it('N — diagnostics emission failure does not alter AP-3 result', async () => {
    const actualRecord = recordDiagnosticEvent;
    const diagSpy = jest
      .spyOn(internalDiagnosticsModule, 'recordDiagnosticEvent')
      .mockImplementation((event) => {
        if (
          typeof event?.name === 'string' &&
          event.name.startsWith('ap3_candidate_funnel')
        ) {
          throw new Error('diag boom');
        }
        return actualRecord(event);
      });
    const result = await scheduleDeriveAnalysisPriceDomain({
      ownerKey: 'user:u-break-diag',
      analyticsReceipts: [{ id: 'r1' } as never],
      rows: [],
      receiptFingerprints: ['r1:diag'],
      generation: createAnalysisPriceGeneration(),
      deferUntilPaint: false,
    }).promise;
    expect(result.status).not.toBe('canceled');
    expect(result.cacheHit).toBe(false);
    diagSpy.mockRestore();
  });

  it('O — both event schemas remain <=24 keys', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: notEnoughHistory({
        observations: [obs(false, ['legacy_unbackfilled', 'missing_observation'])],
      }),
    });
    emitAp3CandidateFunnel(funnel);
    const summary = getDiagnosticSnapshot().events.find(
      (e) => e.name === 'ap3_candidate_funnel_mp_history_summary'
    );
    const reasons = getDiagnosticSnapshot().events.find(
      (e) => e.name === 'ap3_candidate_funnel_mp_observation_reasons'
    );
    expect(Object.keys(summary?.meta ?? {}).length).toBeLessThanOrEqual(24);
    expect(Object.keys(summary?.meta ?? {}).length).toBe(13);
    expect(Object.keys(reasons?.meta ?? {}).length).toBeLessThanOrEqual(24);
    expect(Object.keys(reasons?.meta ?? {}).length).toBe(15);
    const basisSummary = getDiagnosticSnapshot().events.find(
      (e) => e.name === 'ap3_candidate_funnel_mp_amount_basis_summary'
    );
    const basisReasons = getDiagnosticSnapshot().events.find(
      (e) => e.name === 'ap3_candidate_funnel_mp_amount_basis_reasons'
    );
    expect(Object.keys(basisSummary?.meta ?? {}).length).toBeLessThanOrEqual(24);
    expect(Object.keys(basisSummary?.meta ?? {}).length).toBe(19);
    expect(Object.keys(basisReasons?.meta ?? {}).length).toBeLessThanOrEqual(24);
    expect(Object.keys(basisReasons?.meta ?? {}).length).toBe(19);
    const layer = getDiagnosticSnapshot().events.find(
      (e) => e.name === 'ap3_candidate_funnel_mp_monetary_layer_shape'
    );
    expect(Object.keys(layer?.meta ?? {}).length).toBeLessThanOrEqual(24);
    expect(Object.keys(layer?.meta ?? {}).length).toBe(14);
    const taxShape = getDiagnosticSnapshot().events.find(
      (e) => e.name === 'ap3_candidate_funnel_mp_tax_provenance_shape'
    );
    expect(Object.keys(taxShape?.meta ?? {}).length).toBeLessThanOrEqual(24);
    expect(Object.keys(taxShape?.meta ?? {}).length).toBe(23);
  });

  it('P — privacy: no dynamic identifiers/strings', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: notEnoughHistory({
        observations: [obs(false, ['legacy_unbackfilled', 'secret_reason_xyz'])],
      }),
    });
    emitAp3CandidateFunnel(funnel);
    const events = getDiagnosticSnapshot().events.filter(
      (e) =>
        e.name === 'ap3_candidate_funnel_mp_history_summary' ||
        e.name === 'ap3_candidate_funnel_mp_observation_reasons'
    );
    const payload = JSON.stringify(events);
    expect(payload).not.toContain('secret_reason_xyz');
    expect(payload).not.toContain('mp-a');
    expect(payload).not.toMatch(/"displayName"/);
    for (const event of events) {
      for (const value of Object.values(event.meta ?? {})) {
        expect(typeof value).toBe('number');
      }
    }
  });

  it('mixed_currency / ready histories are excluded from cohort', () => {
    const prepared = emptyPrepared({
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([
        ['mp-a', [makeRow('r1'), makeRow('r2')]],
      ]),
      merchantProductIdentityViews: new Map([['mp-a', identityView(2)]]),
    });
    const mixed = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => readyHistory('mixed_currency'),
      interpretChange: () => unavailableInterp('history_not_ready'),
    });
    expect(mixed.funnel.mpHistoryTargetCount).toBe(0);

    const ready = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => readyHistory('ready'),
      interpretChange: () => availableInterp('unchanged'),
    });
    expect(ready.funnel.mpHistoryTargetCount).toBe(0);
    expect(ready.funnel.mpBasisCohortTargetCount).toBe(0);
  });
});

describe('AP-3 MP amount-basis untrusted breakdown', () => {
  beforeEach(() => {
    setInternalDiagnosticsEnabledForTests(true);
    internalDiagnostics.resetForTests(undefined, {
      hydrated: true,
      debounceMs: 0,
    });
    __resetAnalysisPriceSessionCacheForTests();
  });

  afterEach(async () => {
    internalDiagnostics.resetForTests(undefined, {
      hydrated: true,
      debounceMs: 0,
    });
    await internalDiagnostics.drainStorageForTests();
    setInternalDiagnosticsEnabledForTests(false);
  });

  afterAll(() => {
    setInternalDiagnosticsEnabledForTests(null);
  });

  function identityView(historyPointCount: number) {
    return {
      merchantProductId: 'mp-a',
      historyPoints: Array.from({ length: historyPointCount }, (_, i) => ({
        receiptId: `hp-${i}`,
        itemSourceIndex: 0,
        occurredAt: i + 1,
        rawName: 'x',
        purchaseUnitPrice: 100,
        quality: 'trusted',
      })),
    } as never;
  }

  function obs(
    receiptId: string,
    reasons: string[],
    eligible = false
  ): ProductPriceHistoryResult['observations'][number] {
    return {
      receiptId,
      itemId: 'i',
      sourceIndex: 0,
      occurredAt: 1,
      level: 1,
      seriesKind: 'gross',
      level2Eligible: eligible,
      level2RejectReasons: reasons,
      qualityLevel: null,
    } as never;
  }

  function notEnoughHistory(
    observations: ProductPriceHistoryResult['observations']
  ): ProductPriceHistoryResult {
    return {
      ...readyHistory('not_enough_points'),
      target: { type: 'merchant_product', key: 'mp-a' },
      observations,
      points: [],
      comparableOccurrenceCount: 0,
    };
  }

  function assessment(overrides: {
    receiptId: string;
    basis?: 'tax_included' | 'tax_excluded' | 'unknown';
    confidence?: 'high' | 'medium' | 'low' | 'unknown';
    taxProvenance?: 'trusted' | 'untrusted';
    exactComparisonTrusted?: boolean;
    reasonCodes?: string[];
  }) {
    return {
      receiptId: overrides.receiptId,
      basis: overrides.basis ?? 'unknown',
      receiptTotal: 100,
      receiptTax: 8,
      analyticsItemSum: 100,
      unallocatedDiscountTotal: 0,
      expectedTotalIfTaxIncluded: null,
      expectedTotalIfTaxExcluded: null,
      confidence: overrides.confidence ?? 'unknown',
      taxProvenance: overrides.taxProvenance ?? 'untrusted',
      exactComparisonTrusted: overrides.exactComparisonTrusted ?? false,
      evidence: [],
      reasonCodes: overrides.reasonCodes ?? [],
    };
  }

  function cacheFor(
    ...entries: ReturnType<typeof assessment>[]
  ): Map<string, { amountBasisAssessment: ReturnType<typeof assessment> }> {
    return new Map(
      entries.map((a) => [
        a.receiptId,
        { amountBasisAssessment: a, monetaryCoherenceEvidence: {} as never },
      ])
    );
  }

  function collectWithCache(
    history: ProductPriceHistoryResult,
    cache: ReturnType<typeof cacheFor>
  ) {
    const prepared = emptyPrepared({
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([
        ['mp-a', [makeRow('r1'), makeRow('r2')]],
      ]),
      merchantProductIdentityViews: new Map([['mp-a', identityView(2)]]),
      receiptEvidenceCache: cache as never,
    });
    return collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => history,
      interpretChange: () => unavailableInterp('history_not_ready'),
    });
  }

  it('A — unknown + tax_untrusted', () => {
    const { funnel } = collectWithCache(
      notEnoughHistory([obs('rx', ['amount_basis_untrusted'])]),
      cacheFor(
        assessment({
          receiptId: 'rx',
          basis: 'unknown',
          confidence: 'unknown',
          taxProvenance: 'untrusted',
          reasonCodes: ['tax_untrusted'],
        })
      )
    );
    expect(funnel.mpBasisUntrustedObservationCount).toBe(1);
    expect(funnel.mpBasisUnknown).toBe(1);
    expect(funnel.mpBasisTaxProvenanceUntrusted).toBe(1);
    expect(funnel.mpBasisReasonTaxUntrusted).toBe(1);
    expect(assertAp3MpAmountBasisInvariants(funnel)).toBe(true);
  });

  it('B — unknown + trusted tax + tax_non_positive_cannot_discriminate', () => {
    const { funnel } = collectWithCache(
      notEnoughHistory([obs('rx', ['amount_basis_untrusted'])]),
      cacheFor(
        assessment({
          receiptId: 'rx',
          basis: 'unknown',
          confidence: 'unknown',
          taxProvenance: 'trusted',
          reasonCodes: ['tax_non_positive_cannot_discriminate'],
        })
      )
    );
    expect(funnel.mpBasisUnknown).toBe(1);
    expect(funnel.mpBasisTaxProvenanceTrusted).toBe(1);
    expect(funnel.mpBasisReasonTaxNonPositive).toBe(1);
  });

  it('C — tax_included + medium + trusted + exact false + empty reasonCodes', () => {
    const { funnel } = collectWithCache(
      notEnoughHistory([obs('rx', ['amount_basis_untrusted'])]),
      cacheFor(
        assessment({
          receiptId: 'rx',
          basis: 'tax_included',
          confidence: 'medium',
          taxProvenance: 'trusted',
          exactComparisonTrusted: false,
          reasonCodes: [],
        })
      )
    );
    expect(funnel.mpBasisTaxIncluded).toBe(1);
    expect(funnel.mpBasisConfidenceMedium).toBe(1);
    expect(funnel.mpBasisTaxProvenanceTrusted).toBe(1);
    expect(funnel.mpBasisExactTrustedFalse).toBe(1);
    expect(funnel.mpBasisKnownButUntrusted).toBe(1);
    expect(funnel.mpBasisKnownConfidenceMedium).toBe(1);
    expect(funnel.mpBasisReasonNoReasonCodes).toBe(1);
    expect(assertAp3MpAmountBasisInvariants(funnel)).toBe(true);
  });

  it('D — monetary_source_incoherent', () => {
    const { funnel } = collectWithCache(
      notEnoughHistory([obs('rx', ['amount_basis_untrusted', 'monetary_incoherent'])]),
      cacheFor(
        assessment({
          receiptId: 'rx',
          basis: 'unknown',
          reasonCodes: ['monetary_source_incoherent'],
        })
      )
    );
    expect(funnel.mpBasisReasonMonetarySourceIncoherent).toBe(1);
    expect(funnel.mpObsMonetaryIncoherent).toBe(1);
  });

  it('E — assessment missing', () => {
    const { funnel } = collectWithCache(
      notEnoughHistory([obs('rx', ['amount_basis_untrusted'])]),
      cacheFor()
    );
    expect(funnel.mpBasisAssessmentMissing).toBe(1);
    expect(funnel.mpBasisUnknown).toBe(0);
    expect(funnel.mpBasisReasonUnknown).toBe(0);
    expect(assertAp3MpAmountBasisInvariants(funnel)).toBe(true);
  });

  it('F — multi-label reasonCodes', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: notEnoughHistory([obs('rx', ['amount_basis_untrusted'])]),
      receiptEvidenceCache: cacheFor(
        assessment({
          receiptId: 'rx',
          reasonCodes: [
            'invalid_authoritative_total',
            'missing_item_monetary_evidence',
          ],
        })
      ) as never,
    });
    expect(funnel.mpBasisReasonObservationCount).toBe(1);
    expect(funnel.mpBasisReasonInvalidAuthoritativeTotal).toBe(1);
    expect(funnel.mpBasisReasonMissingItemMonetaryEvidence).toBe(1);
  });

  it('G — unknown reason → Unknown only; raw string not emitted', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: notEnoughHistory([obs('rx', ['amount_basis_untrusted'])]),
      receiptEvidenceCache: cacheFor(
        assessment({
          receiptId: 'rx',
          reasonCodes: ['totally_invented_basis_reason'],
        })
      ) as never,
    });
    expect(funnel.mpBasisReasonUnknown).toBe(1);
    emitAp3CandidateFunnel(funnel);
    const payload = JSON.stringify(getDiagnosticSnapshot().events);
    expect(payload).not.toContain('totally_invented_basis_reason');
  });

  it('H — exactTrustedTrue is drift for assert but does not break product collect', () => {
    const { funnel, candidates } = collectWithCache(
      notEnoughHistory([obs('rx', ['amount_basis_untrusted'])]),
      cacheFor(
        assessment({
          receiptId: 'rx',
          basis: 'tax_included',
          confidence: 'high',
          taxProvenance: 'trusted',
          exactComparisonTrusted: true,
          reasonCodes: [],
        })
      )
    );
    expect(funnel.mpBasisExactTrustedTrue).toBe(1);
    expect(assertAp3MpAmountBasisInvariants(funnel)).toBe(false);
    expect(candidates).toEqual([]);
    expect(funnel.mpInterpretUnavailable).toBe(1);
  });

  it('I — non-cohort statuses excluded from amount-basis breakdown', () => {
    const prepared = emptyPrepared({
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([
        ['mp-a', [makeRow('r1'), makeRow('r2')]],
      ]),
      merchantProductIdentityViews: new Map([['mp-a', identityView(2)]]),
      receiptEvidenceCache: cacheFor(
        assessment({
          receiptId: 'rx',
          reasonCodes: ['tax_untrusted'],
        })
      ) as never,
    });
    const mixed = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => readyHistory('mixed_currency'),
      interpretChange: () => unavailableInterp('history_not_ready'),
    });
    expect(mixed.funnel.mpBasisCohortTargetCount).toBe(0);
    expect(mixed.funnel.mpBasisUntrustedObservationCount).toBe(0);

    const bucketLt2 = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared: emptyPrepared({
        seededMerchantProductIds: new Set(['mp-a']),
        merchantProductBuckets: new Map([['mp-a', [makeRow('r1')]]]),
        merchantProductIdentityViews: new Map([['mp-a', identityView(0)]]),
      }),
    });
    expect(bucketLt2.funnel.mpBasisCohortTargetCount).toBe(0);
  });

  it('J — schema spelling mpHistoryTargetsWith1ComparablePoints', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: {
        ...notEnoughHistory([obs('rx', ['legacy_unbackfilled'])]),
        points: [{ receiptId: 'p0' }] as never,
        comparableOccurrenceCount: 1,
      },
    });
    expect(funnel.mpHistoryTargetsWith1ComparablePoints).toBe(1);
    emitAp3CandidateFunnel(funnel);
    const summary = getDiagnosticSnapshot().events.find(
      (e) => e.name === 'ap3_candidate_funnel_mp_history_summary'
    );
    expect(summary?.meta).toHaveProperty('mpHistoryTargetsWith1ComparablePoints');
    expect(summary?.meta).not.toHaveProperty('mpHistoryTargetsWith1ComparablePoint');
  });
});

describe('AP-3 MP monetary layer shape breakdown', () => {
  beforeEach(() => {
    setInternalDiagnosticsEnabledForTests(true);
    internalDiagnostics.resetForTests(undefined, {
      hydrated: true,
      debounceMs: 0,
    });
  });

  afterEach(async () => {
    internalDiagnostics.resetForTests(undefined, {
      hydrated: true,
      debounceMs: 0,
    });
    await internalDiagnostics.drainStorageForTests();
    setInternalDiagnosticsEnabledForTests(false);
  });

  afterAll(() => {
    setInternalDiagnosticsEnabledForTests(null);
  });

  function layerRow(
    receiptId: string,
    overrides: {
      receiptUserEdited?: number | null;
      receiptUserItemsJson?: string | null;
      receiptFinalTotal?: number | null;
    } = {}
  ) {
    return {
      receiptId,
      sourceIndex: 0,
      receiptUserEdited: overrides.receiptUserEdited ?? 0,
      receiptUserItemsJson: overrides.receiptUserItemsJson ?? null,
      receiptFinalTotal: overrides.receiptFinalTotal ?? null,
    } as never;
  }

  function obs(receiptId: string, reasons: string[] = ['amount_basis_untrusted']) {
    return {
      receiptId,
      itemId: 'i',
      sourceIndex: 0,
      occurredAt: 1,
      level: 1,
      seriesKind: 'gross',
      level2Eligible: false,
      level2RejectReasons: reasons,
      qualityLevel: null,
    } as never;
  }

  function notEnough(
    observations: ProductPriceHistoryResult['observations']
  ): ProductPriceHistoryResult {
    return {
      ...readyHistory('not_enough_points'),
      target: { type: 'merchant_product', key: 'mp-a' },
      observations,
      points: [],
      comparableOccurrenceCount: 0,
    };
  }

  function assessment(
    receiptId: string,
    reasonCodes: string[]
  ) {
    return {
      receiptId,
      basis: 'unknown' as const,
      receiptTotal: 100,
      receiptTax: null,
      analyticsItemSum: 0,
      unallocatedDiscountTotal: 0,
      expectedTotalIfTaxIncluded: null,
      expectedTotalIfTaxExcluded: null,
      confidence: 'unknown' as const,
      taxProvenance: 'untrusted' as const,
      exactComparisonTrusted: false,
      evidence: [],
      reasonCodes,
    };
  }

  function recordLayer(input: {
    rows: ReturnType<typeof layerRow>[];
    receiptId: string;
    reasonCodes: string[];
  }) {
    const funnel = createEmptyAp3CandidateFunnel();
    const cache = new Map([
      [
        input.receiptId,
        {
          amountBasisAssessment: assessment(input.receiptId, input.reasonCodes),
          monetaryCoherenceEvidence: {} as never,
        },
      ],
    ]);
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: Math.max(2, input.rows.length),
      identityRowCount: 2,
      history: notEnough([obs(input.receiptId)]),
      receiptEvidenceCache: cache as never,
      membershipRows: input.rows.length >= 2 ? input.rows : [...input.rows, layerRow('pad')],
    });
    return funnel;
  }

  it('1 — edited + no items + no total → EditedNoItemsNoTotal + legacy metadata', () => {
    const funnel = recordLayer({
      rows: [
        layerRow('rx', {
          receiptUserEdited: 1,
          receiptUserItemsJson: null,
          receiptFinalTotal: null,
        }),
        layerRow('pad'),
      ],
      receiptId: 'rx',
      reasonCodes: [
        'inconsistent_legacy_user_edit_metadata',
        'monetary_source_incoherent',
      ],
    });
    expect(funnel.mpLayerEditedNoItemsNoTotal).toBe(1);
    expect(funnel.mpLayerUserEdited1).toBe(1);
    expect(funnel.mpBasisReasonLegacyEditMetadata).toBe(1);
    expect(funnel.mpBasisReasonMonetarySourceIncoherent).toBe(1);
    expect(assertAp3MpMonetaryLayerInvariants(funnel)).toBe(true);
  });

  it('2 — edited + items + total → EditedItemsAndTotal', () => {
    const funnel = recordLayer({
      rows: [
        layerRow('rx', {
          receiptUserEdited: 1,
          receiptUserItemsJson: '[{"name":"a","amount":100}]',
          receiptFinalTotal: 100,
        }),
        layerRow('pad'),
      ],
      receiptId: 'rx',
      reasonCodes: [],
    });
    expect(funnel.mpLayerEditedItemsAndTotal).toBe(1);
  });

  it('3 — not edited + no user layer → NotEditedNoItemsNoTotal', () => {
    const funnel = recordLayer({
      rows: [
        layerRow('rx', {
          receiptUserEdited: 0,
          receiptUserItemsJson: null,
          receiptFinalTotal: null,
        }),
        layerRow('pad'),
      ],
      receiptId: 'rx',
      reasonCodes: ['tax_untrusted'],
    });
    expect(funnel.mpLayerNotEditedNoItemsNoTotal).toBe(1);
    expect(funnel.mpLayerUserEdited0).toBe(1);
  });

  it('4 — items without total', () => {
    const funnel = recordLayer({
      rows: [
        layerRow('rx', {
          receiptUserEdited: 1,
          receiptUserItemsJson: '[{"name":"a"}]',
          receiptFinalTotal: null,
        }),
        layerRow('pad'),
      ],
      receiptId: 'rx',
      reasonCodes: [
        'user_items_without_authoritative_total',
        'monetary_source_incoherent',
      ],
    });
    expect(funnel.mpLayerEditedItemsNoTotal).toBe(1);
    expect(funnel.mpBasisReasonUserItemsWithoutTotal).toBe(1);
  });

  it('5 — total without items', () => {
    const funnel = recordLayer({
      rows: [
        layerRow('rx', {
          receiptUserEdited: 1,
          receiptUserItemsJson: null,
          receiptFinalTotal: 120,
        }),
        layerRow('pad'),
      ],
      receiptId: 'rx',
      reasonCodes: [
        'final_total_without_matching_item_layer',
        'monetary_source_incoherent',
      ],
    });
    expect(funnel.mpLayerEditedNoItemsHasTotal).toBe(1);
    expect(funnel.mpBasisReasonFinalTotalWithoutItems).toBe(1);
  });

  it('6 — malformed items JSON', () => {
    const funnel = recordLayer({
      rows: [
        layerRow('rx', {
          receiptUserEdited: 1,
          receiptUserItemsJson: '{not-json',
          receiptFinalTotal: 100,
        }),
        layerRow('pad'),
      ],
      receiptId: 'rx',
      reasonCodes: ['malformed_user_items_json', 'monetary_source_incoherent'],
    });
    expect(funnel.mpLayerMalformedUserItems).toBe(1);
    expect(funnel.mpLayerHasUserItems).toBe(1);
    expect(funnel.mpBasisReasonMalformedUserItems).toBe(1);
  });

  it('7 — discount ownership unresolved', () => {
    const funnel = recordLayer({
      rows: [layerRow('rx'), layerRow('pad')],
      receiptId: 'rx',
      reasonCodes: [
        'discount_ownership_unresolved',
        'insufficient_evidence_for_reallocation',
        'monetary_source_incoherent',
      ],
    });
    expect(funnel.mpBasisReasonDiscountOwnershipUnresolved).toBe(1);
    expect(funnel.mpBasisReasonInsufficientReallocationEvidence).toBe(1);
  });

  it('8 — duplicate monetary_source_incoherent counts once', () => {
    const funnel = recordLayer({
      rows: [layerRow('rx'), layerRow('pad')],
      receiptId: 'rx',
      reasonCodes: [
        'monetary_source_incoherent',
        'monetary_source_incoherent',
        'inconsistent_legacy_user_edit_metadata',
      ],
    });
    expect(funnel.mpBasisReasonMonetarySourceIncoherent).toBe(1);
    expect(funnel.mpBasisReasonLegacyEditMetadata).toBe(1);
  });

  it('9 — unknown reason only increments Unknown; raw string not emitted', () => {
    const funnel = recordLayer({
      rows: [layerRow('rx'), layerRow('pad')],
      receiptId: 'rx',
      reasonCodes: ['brand_new_unlisted_reason'],
    });
    expect(funnel.mpBasisReasonUnknown).toBe(1);
    emitAp3CandidateFunnel(funnel);
    const payload = JSON.stringify(getDiagnosticSnapshot().events);
    expect(payload).not.toContain('brand_new_unlisted_reason');
  });

  it('10 — non-cohort exclusions unchanged', () => {
    const prepared = emptyPrepared({
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([
        [
          'mp-a',
          [
            layerRow('r1', { receiptUserEdited: 1 }),
            layerRow('r2', { receiptUserEdited: 1 }),
          ],
        ],
      ]),
      merchantProductIdentityViews: new Map([
        ['mp-a', { merchantProductId: 'mp-a', historyPoints: [{}, {}] } as never],
      ]),
    });
    const mixed = collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
      rows: [],
      seedReceiptIds: new Set(),
      prepared,
      buildHistory: () => readyHistory('mixed_currency'),
      interpretChange: () => unavailableInterp('history_not_ready'),
    });
    expect(mixed.funnel.mpLayerObservationCount).toBe(0);
    expect(mixed.funnel.mpBasisCohortTargetCount).toBe(0);
    expect(mixed.funnel.mpTaxObservationCount).toBe(0);
  });
});

describe('AP-3 MP tax provenance shape (tax_untrusted cohort)', () => {
  beforeEach(() => {
    setInternalDiagnosticsEnabledForTests(true);
    setAp3TaxProvenanceDiagnosticsEnabledForTests(true);
    void clearDiagnostics();
  });
  afterEach(() => {
    setAp3TaxProvenanceDiagnosticsEnabledForTests(null);
    setInternalDiagnosticsEnabledForTests(null);
  });

  function taxRow(
    receiptId: string,
    overrides: {
      receiptTax?: number | null;
      receiptTaxIsKnown?: number;
      receiptAnalysisJson?: string | null;
      receiptRecognitionSnapshotJson?: string | null;
    } = {}
  ) {
    return {
      receiptId,
      sourceIndex: 0,
      receiptTax: overrides.receiptTax ?? 0,
      receiptTaxIsKnown: overrides.receiptTaxIsKnown ?? 0,
      receiptAnalysisJson: overrides.receiptAnalysisJson ?? null,
      receiptRecognitionSnapshotJson:
        overrides.receiptRecognitionSnapshotJson ?? null,
    } as never;
  }

  function taxObs(receiptId: string, reasons: string[] = ['amount_basis_untrusted']) {
    return {
      receiptId,
      itemId: 'i',
      sourceIndex: 0,
      occurredAt: 1,
      level: 1,
      seriesKind: 'gross',
      level2Eligible: false,
      level2RejectReasons: reasons,
      qualityLevel: null,
    } as never;
  }

  function taxNotEnough(
    observations: ProductPriceHistoryResult['observations']
  ): ProductPriceHistoryResult {
    return {
      ...readyHistory('not_enough_points'),
      target: { type: 'merchant_product', key: 'mp-tax' },
      observations,
      points: [],
      comparableOccurrenceCount: 0,
    };
  }

  function taxAssessment(receiptId: string, reasonCodes: string[]) {
    return {
      receiptId,
      basis: 'unknown' as const,
      receiptTotal: 100,
      receiptTax: null,
      analyticsItemSum: 0,
      unallocatedDiscountTotal: 0,
      expectedTotalIfTaxIncluded: null,
      expectedTotalIfTaxExcluded: null,
      confidence: 'unknown' as const,
      taxProvenance: 'untrusted' as const,
      exactComparisonTrusted: false,
      evidence: [],
      reasonCodes,
    };
  }

  function recordTax(input: {
    rows: ReturnType<typeof taxRow>[];
    observations: ReturnType<typeof taxObs>[];
    assessments: ReturnType<typeof taxAssessment>[];
  }) {
    const funnel = createEmptyAp3CandidateFunnel();
    const cache = new Map(
      input.assessments.map((a) => [
        a.receiptId,
        {
          amountBasisAssessment: a,
          monetaryCoherenceEvidence: {} as never,
        },
      ])
    );
    const rows =
      input.rows.length >= 2
        ? input.rows
        : [...input.rows, taxRow('pad-membership')];
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: Math.max(2, rows.length),
      identityRowCount: 2,
      history: taxNotEnough(input.observations),
      receiptEvidenceCache: cache as never,
      membershipRows: rows,
    });
    return funnel;
  }

  it('1 — persisted=0 + analysis resolver known → Persisted0AnalysisKnown', () => {
    const funnel = recordTax({
      rows: [
        taxRow('r1', {
          receiptTax: 80,
          receiptTaxIsKnown: 0,
          receiptAnalysisJson: JSON.stringify({
            tax: 80,
            tax_is_known: true,
            items: [{ name: 'milk', lineTotal: 1000 }],
            total: 1080,
          }),
        }),
      ],
      observations: [taxObs('r1')],
      assessments: [taxAssessment('r1', ['tax_untrusted'])],
    });
    expect(funnel.mpTaxObservationCount).toBe(1);
    expect(funnel.mpTaxPersistedKnown0).toBe(1);
    expect(funnel.mpTaxAnalysisResolvedKnown).toBe(1);
    expect(funnel.mpTaxPersisted0AnalysisKnown).toBe(1);
    expect(funnel.mpTaxAnalysisResolvedKnownPositive).toBe(1);
    expect(assertAp3MpTaxProvenanceInvariants(funnel)).toBe(true);
  });

  it('2 — analysis unknown + snapshot known → AnalysisUnknownSnapshotKnown', () => {
    const funnel = recordTax({
      rows: [
        taxRow('r1', {
          receiptTaxIsKnown: 0,
          receiptTax: 0,
          receiptAnalysisJson: JSON.stringify({ tax: 0, items: [] }),
          receiptRecognitionSnapshotJson: JSON.stringify({
            tax: 80,
            tax_is_known: true,
            items: [],
          }),
        }),
      ],
      observations: [taxObs('r1')],
      assessments: [taxAssessment('r1', ['tax_untrusted'])],
    });
    expect(funnel.mpTaxAnalysisResolvedUnknown).toBe(1);
    expect(funnel.mpTaxSnapshotResolvedKnown).toBe(1);
    expect(funnel.mpTaxAnalysisUnknownSnapshotKnown).toBe(1);
    expect(assertAp3MpTaxProvenanceInvariants(funnel)).toBe(true);
  });

  it('3 — analysis unknown + snapshot unknown → AnalysisUnknownSnapshotUnknown', () => {
    const funnel = recordTax({
      rows: [
        taxRow('r1', {
          receiptTaxIsKnown: 0,
          receiptAnalysisJson: JSON.stringify({ tax: 0 }),
          receiptRecognitionSnapshotJson: JSON.stringify({ tax: 0 }),
        }),
      ],
      observations: [taxObs('r1')],
      assessments: [taxAssessment('r1', ['tax_untrusted'])],
    });
    expect(funnel.mpTaxAnalysisUnknownSnapshotUnknown).toBe(1);
    expect(assertAp3MpTaxProvenanceInvariants(funnel)).toBe(true);
  });

  it('4 — analysis unknown + snapshot unavailable → AnalysisUnknownSnapshotUnavailable', () => {
    const funnel = recordTax({
      rows: [
        taxRow('r1', {
          receiptTaxIsKnown: 0,
          receiptAnalysisJson: JSON.stringify({ tax: 0 }),
          receiptRecognitionSnapshotJson: null,
        }),
      ],
      observations: [taxObs('r1')],
      assessments: [taxAssessment('r1', ['tax_untrusted'])],
    });
    expect(funnel.mpTaxSnapshotUnavailable).toBe(1);
    expect(funnel.mpTaxAnalysisUnknownSnapshotUnavailable).toBe(1);
    expect(assertAp3MpTaxProvenanceInvariants(funnel)).toBe(true);
  });

  it('5 — analysis marker true / false / missing partitions', () => {
    const funnel = recordTax({
      rows: [
        taxRow('ra', {
          receiptAnalysisJson: JSON.stringify({ tax: 10, tax_is_known: true }),
        }),
        taxRow('rb', {
          receiptAnalysisJson: JSON.stringify({ tax: 0, tax_is_known: false }),
        }),
        taxRow('rc', {
          receiptAnalysisJson: JSON.stringify({ tax: 0 }),
        }),
      ],
      observations: [taxObs('ra'), taxObs('rb'), taxObs('rc')],
      assessments: [
        taxAssessment('ra', ['tax_untrusted']),
        taxAssessment('rb', ['tax_untrusted']),
        taxAssessment('rc', ['tax_untrusted']),
      ],
    });
    expect(funnel.mpTaxAnalysisMarkerTrue).toBe(1);
    expect(funnel.mpTaxAnalysisMarkerFalse).toBe(1);
    expect(funnel.mpTaxAnalysisMarkerMissing).toBe(1);
    expect(assertAp3MpTaxProvenanceInvariants(funnel)).toBe(true);
  });

  it('6 — analysis resolved known positive / nonpositive partitions', () => {
    const funnel = recordTax({
      rows: [
        taxRow('rp', {
          receiptAnalysisJson: JSON.stringify({
            tax: 80,
            tax_is_known: true,
          }),
        }),
        taxRow('rz', {
          receiptAnalysisJson: JSON.stringify({
            tax: 0,
            tax_is_known: true,
          }),
        }),
      ],
      observations: [taxObs('rp'), taxObs('rz')],
      assessments: [
        taxAssessment('rp', ['tax_untrusted']),
        taxAssessment('rz', ['tax_untrusted']),
      ],
    });
    expect(funnel.mpTaxAnalysisResolvedKnownPositive).toBe(1);
    expect(funnel.mpTaxAnalysisResolvedKnownNonPositive).toBe(1);
    expect(assertAp3MpTaxProvenanceInvariants(funnel)).toBe(true);
  });

  it('7 — malformed analysis → unavailable', () => {
    const funnel = recordTax({
      rows: [
        taxRow('r1', {
          receiptAnalysisJson: '{not-json',
        }),
      ],
      observations: [taxObs('r1')],
      assessments: [taxAssessment('r1', ['tax_untrusted'])],
    });
    expect(funnel.mpTaxAnalysisUnavailable).toBe(1);
    expect(assertAp3MpTaxProvenanceInvariants(funnel)).toBe(true);
  });

  it('8 — malformed snapshot → unavailable', () => {
    const funnel = recordTax({
      rows: [
        taxRow('r1', {
          receiptAnalysisJson: JSON.stringify({ tax: 0 }),
          receiptRecognitionSnapshotJson: '{bad',
        }),
      ],
      observations: [taxObs('r1')],
      assessments: [taxAssessment('r1', ['tax_untrusted'])],
    });
    expect(funnel.mpTaxSnapshotUnavailable).toBe(1);
    expect(funnel.mpTaxAnalysisUnknownSnapshotUnavailable).toBe(1);
    expect(assertAp3MpTaxProvenanceInvariants(funnel)).toBe(true);
  });

  it('9 — non-tax_untrusted observation excluded', () => {
    const funnel = recordTax({
      rows: [
        taxRow('r1', {
          receiptAnalysisJson: JSON.stringify({ tax: 80, tax_is_known: true }),
        }),
      ],
      observations: [taxObs('r1')],
      assessments: [
        taxAssessment('r1', ['monetary_source_incoherent']),
      ],
    });
    expect(funnel.mpBasisUntrustedObservationCount).toBe(1);
    expect(funnel.mpTaxObservationCount).toBe(0);
    expect(funnel.mpTaxCohortTargetCount).toBe(0);
  });

  it('10 — bucket<2 / wrong status / gate-off exclusions', () => {
    const funnelOff = createEmptyAp3CandidateFunnel();
    setAp3TaxProvenanceDiagnosticsEnabledForTests(false);
    recordAp3MpNotEnoughPointsComparability(funnelOff, {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: taxNotEnough([taxObs('r1')]),
      receiptEvidenceCache: new Map([
        [
          'r1',
          {
            amountBasisAssessment: taxAssessment('r1', ['tax_untrusted']),
            monetaryCoherenceEvidence: {} as never,
          },
        ],
      ]) as never,
      membershipRows: [taxRow('r1'), taxRow('r2')],
    });
    expect(funnelOff.mpTaxObservationCount).toBe(0);

    setAp3TaxProvenanceDiagnosticsEnabledForTests(true);
    const funnelBucket = createEmptyAp3CandidateFunnel();
    recordAp3MpNotEnoughPointsComparability(funnelBucket, {
      membershipRowCount: 1,
      identityRowCount: 1,
      history: taxNotEnough([taxObs('r1')]),
      receiptEvidenceCache: new Map([
        [
          'r1',
          {
            amountBasisAssessment: taxAssessment('r1', ['tax_untrusted']),
            monetaryCoherenceEvidence: {} as never,
          },
        ],
      ]) as never,
      membershipRows: [taxRow('r1')],
    });
    expect(funnelBucket.mpTaxObservationCount).toBe(0);
  });

  it('11 — duplicate receipt observations counted per obs; resolve memoized', () => {
    const resolveSpy = jest.spyOn(
      require('./receiptOcrNormalize') as typeof import('./receiptOcrNormalize'),
      'resolveReceiptTax'
    );
    const analysis = JSON.stringify({ tax: 80, tax_is_known: true });
    const funnel = recordTax({
      rows: [taxRow('r1', { receiptAnalysisJson: analysis })],
      observations: [taxObs('r1'), taxObs('r1')],
      assessments: [taxAssessment('r1', ['tax_untrusted'])],
    });
    expect(funnel.mpTaxObservationCount).toBe(2);
    // analysis + snapshot resolve once each per receipt (snapshot null → unavailable, no resolve)
    expect(resolveSpy.mock.calls.length).toBe(1);
    resolveSpy.mockRestore();
    expect(assertAp3MpTaxProvenanceInvariants(funnel)).toBe(true);
  });

  it('12 — all invariants hold for mixed tax cohort', () => {
    const funnel = recordTax({
      rows: [
        taxRow('r1', {
          receiptTax: 80,
          receiptTaxIsKnown: 0,
          receiptAnalysisJson: JSON.stringify({ tax: 80, tax_is_known: true }),
          receiptRecognitionSnapshotJson: null,
        }),
        taxRow('r2', {
          receiptTax: 0,
          receiptTaxIsKnown: 0,
          receiptAnalysisJson: JSON.stringify({ tax: 0 }),
          receiptRecognitionSnapshotJson: JSON.stringify({ tax: 0 }),
        }),
      ],
      observations: [taxObs('r1'), taxObs('r2')],
      assessments: [
        taxAssessment('r1', ['tax_untrusted']),
        taxAssessment('r2', ['tax_untrusted']),
      ],
    });
    expect(funnel.mpTaxCohortTargetCount).toBe(1);
    expect(funnel.mpTaxObservationCount).toBe(2);
    expect(assertAp3MpTaxProvenanceInvariants(funnel)).toBe(true);
    expect(assertAp3MpAmountBasisInvariants(funnel)).toBe(true);
  });

  it('13 — diagnostic helper error does not alter candidate result', () => {
    const resolveSpy = jest
      .spyOn(
        require('./receiptOcrNormalize') as typeof import('./receiptOcrNormalize'),
        'resolveReceiptTax'
      )
      .mockImplementation(() => {
        throw new Error('diag boom');
      });

    expect(() =>
      recordTax({
        rows: [
          taxRow('r1', {
            receiptAnalysisJson: JSON.stringify({ tax: 80, tax_is_known: true }),
          }),
        ],
        observations: [taxObs('r1')],
        assessments: [taxAssessment('r1', ['tax_untrusted'])],
      })
    ).not.toThrow();

    const taxFunnel = recordTax({
      rows: [
        taxRow('r1', {
          receiptAnalysisJson: JSON.stringify({ tax: 80, tax_is_known: true }),
        }),
      ],
      observations: [taxObs('r1')],
      assessments: [taxAssessment('r1', ['tax_untrusted'])],
    });
    expect(taxFunnel.mpTaxObservationCount).toBe(1);
    expect(taxFunnel.mpTaxAnalysisUnavailable).toBe(1);
    expect(taxFunnel.mpBasisUntrustedObservationCount).toBe(1);

    const prepared = emptyPrepared({
      seededSkuKeys: new Set(['sku-a']),
      skuBuckets: new Map([
        ['sku-a', [makeRow('r1', 'sku-a'), makeRow('r2', 'sku-a')]],
      ]),
      seededMerchantProductIds: new Set(['mp-a']),
      merchantProductBuckets: new Map([
        [
          'mp-a',
          [
            taxRow('r1', {
              receiptAnalysisJson: JSON.stringify({ tax: 80, tax_is_known: true }),
            }),
            taxRow('r2'),
          ],
        ],
      ]),
      merchantProductIdentityViews: new Map([
        [
          'mp-a',
          {
            merchantProductId: 'mp-a',
            historyPoints: [{}, {}],
          } as never,
        ],
      ]),
      receiptEvidenceCache: new Map([
        [
          'r1',
          {
            amountBasisAssessment: taxAssessment('r1', ['tax_untrusted']),
            monetaryCoherenceEvidence: {} as never,
          },
        ],
      ]) as never,
    });
    const { candidates, funnel } =
      collectAnalysisTrustedPriceChangeCandidatesWithFunnel({
        rows: [],
        seedReceiptIds: new Set(),
        prepared,
        buildHistory: (target) => {
          if (target.type === 'sku') {
            return {
              ...readyHistory('ready'),
              target: { type: 'sku', key: 'sku-a' },
              points: [
                {
                  receiptId: 'r-cur',
                  occurredAt: 200,
                  qualityLevel: 'trusted',
                } as never,
                {
                  receiptId: 'r-prev',
                  occurredAt: 100,
                  qualityLevel: 'trusted',
                } as never,
              ],
              comparableOccurrenceCount: 2,
            };
          }
          return taxNotEnough([taxObs('r1')]);
        },
        interpretChange: ({ targetType }) => {
          if (targetType === 'sku') return availableInterp('increased');
          return unavailableInterp('history_not_ready');
        },
      });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.target.type).toBe('sku');
    expect(funnel.finalCandidateCount).toBe(1);
    expect(funnel.mpTaxAnalysisUnavailable).toBe(1);
    resolveSpy.mockRestore();
  });

  it('emit companion event includes 23 tax keys', () => {
    const funnel = recordTax({
      rows: [
        taxRow('r1', {
          receiptAnalysisJson: JSON.stringify({ tax: 0 }),
        }),
      ],
      observations: [taxObs('r1')],
      assessments: [taxAssessment('r1', ['tax_untrusted'])],
    });
    emitAp3CandidateFunnel(funnel);
    const taxShape = getDiagnosticSnapshot().events.find(
      (e) => e.name === 'ap3_candidate_funnel_mp_tax_provenance_shape'
    );
    expect(taxShape).toBeTruthy();
    expect(Object.keys(taxShape?.meta ?? {}).length).toBe(23);
    expect(taxShape?.meta?.mpTaxObservationCount).toBe(1);
  });

  it('A2 — shared memo: two MP targets, same receipt → parse/resolve once', () => {
    const analysis = JSON.stringify({ tax: 80, tax_is_known: true });
    const snapshot = JSON.stringify({ tax: 80, tax_is_known: true });
    const row = taxRow('r-shared', {
      receiptTaxIsKnown: 0,
      receiptAnalysisJson: analysis,
      receiptRecognitionSnapshotJson: snapshot,
    });
    const sharedMemo = createAp3TaxProvenanceReceiptMemo();
    const funnel = createEmptyAp3CandidateFunnel();
    const cache = new Map([
      [
        'r-shared',
        {
          amountBasisAssessment: taxAssessment('r-shared', ['tax_untrusted']),
          monetaryCoherenceEvidence: {} as never,
        },
      ],
    ]);

    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: taxNotEnough([taxObs('r-shared')]),
      receiptEvidenceCache: cache as never,
      membershipRows: [row, taxRow('pad-a')],
      taxProvenanceReceiptMemo: sharedMemo,
    });
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: taxNotEnough([taxObs('r-shared')]),
      receiptEvidenceCache: cache as never,
      membershipRows: [row, taxRow('pad-b')],
      taxProvenanceReceiptMemo: sharedMemo,
    });

    expect(funnel.mpTaxObservationCount).toBe(2);
    expect(funnel.mpTaxCohortTargetCount).toBe(2);
    expect(sharedMemo.byReceiptId.size).toBe(1);
    expect(sharedMemo.analysisParseCalls).toBe(1);
    expect(sharedMemo.analysisResolveCalls).toBe(1);
    expect(sharedMemo.snapshotParseCalls).toBe(1);
    expect(sharedMemo.snapshotResolveCalls).toBe(1);
    expect(assertAp3MpTaxProvenanceInvariants(funnel)).toBe(true);
  });

  it('A2 — new derivation memo does not leak across runs', () => {
    const analysis = JSON.stringify({ tax: 80, tax_is_known: true });
    const snapshot = JSON.stringify({ tax: 10, tax_is_known: true });
    const row = taxRow('r1', {
      receiptAnalysisJson: analysis,
      receiptRecognitionSnapshotJson: snapshot,
    });
    const cache = new Map([
      [
        'r1',
        {
          amountBasisAssessment: taxAssessment('r1', ['tax_untrusted']),
          monetaryCoherenceEvidence: {} as never,
        },
      ],
    ]);

    const memo1 = createAp3TaxProvenanceReceiptMemo();
    recordAp3MpNotEnoughPointsComparability(createEmptyAp3CandidateFunnel(), {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: taxNotEnough([taxObs('r1')]),
      receiptEvidenceCache: cache as never,
      membershipRows: [row, taxRow('pad')],
      taxProvenanceReceiptMemo: memo1,
    });
    expect(memo1.analysisResolveCalls).toBe(1);
    expect(memo1.snapshotResolveCalls).toBe(1);

    const memo2 = createAp3TaxProvenanceReceiptMemo();
    recordAp3MpNotEnoughPointsComparability(createEmptyAp3CandidateFunnel(), {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: taxNotEnough([taxObs('r1')]),
      receiptEvidenceCache: cache as never,
      membershipRows: [row, taxRow('pad')],
      taxProvenanceReceiptMemo: memo2,
    });
    expect(memo2.analysisParseCalls).toBe(1);
    expect(memo2.analysisResolveCalls).toBe(1);
    expect(memo2.snapshotParseCalls).toBe(1);
    expect(memo2.snapshotResolveCalls).toBe(1);
    expect(memo1.byReceiptId).not.toBe(memo2.byReceiptId);
  });
});

describe('AP-3 MP neither-hypothesis-closes residual shape', () => {
  beforeEach(() => {
    setInternalDiagnosticsEnabledForTests(true);
    setAp3NeitherCloseDiagnosticsEnabledForTests(true);
    setAp3TaxProvenanceDiagnosticsEnabledForTests(false);
    internalDiagnostics.resetForTests(undefined, {
      hydrated: true,
      debounceMs: 0,
    });
  });

  afterEach(() => {
    setAp3NeitherCloseDiagnosticsEnabledForTests(null);
    setAp3TaxProvenanceDiagnosticsEnabledForTests(null);
  });

  function neitherAssessment(args: {
    receiptId: string;
    receiptTotal: number;
    expectedIncluded: number | null;
    expectedExcluded: number | null;
    unallocated?: number;
    reasonCodes?: string[];
  }) {
    return {
      receiptId: args.receiptId,
      basis: 'unknown' as const,
      receiptTotal: args.receiptTotal,
      receiptTax: 80,
      analyticsItemSum: 1000,
      unallocatedDiscountTotal: args.unallocated ?? 0,
      expectedTotalIfTaxIncluded: args.expectedIncluded,
      expectedTotalIfTaxExcluded: args.expectedExcluded,
      confidence: 'unknown' as const,
      taxProvenance: 'trusted' as const,
      exactComparisonTrusted: false,
      evidence: [],
      reasonCodes: args.reasonCodes ?? ['neither_hypothesis_closes'],
    };
  }

  function monetary(args: {
    state: 'known_coherent' | 'known_incoherent' | 'unknown';
    sufficient?: boolean;
    layer?: 'ocr' | 'user' | null;
  }) {
    return {
      receiptId: 'x',
      state: args.state,
      authoritativeLayer: args.layer ?? 'ocr',
      discountOwnershipStatus: 'persisted_resolved',
      monetaryProvenanceSufficient: args.sufficient ?? true,
      closureHypothesis: null,
      evidence: [],
      reasonCodes: [],
    };
  }

  function obs(receiptId: string, reasons: string[] = ['amount_basis_untrusted']) {
    return {
      receiptId,
      itemId: `item-${receiptId}`,
      sourceIndex: 0,
      occurredAt: 1,
      level: 1,
      seriesKind: 'gross',
      grossLineAmount: 1000,
      effectiveLineAmount: 1000,
      purchaseQuantity: 1,
      currency: 'JPY',
      amountProvenance: 'ocr_observed',
      itemAmountEvidenceState: 'coherent',
      priceObservationVersion: 1,
      amountBasis: null,
      exactComparisonTrusted: false,
      monetaryCoherenceState: null,
      monetaryProvenanceSufficient: false,
      discountOwnershipStatus: null,
      promoContext: 'none_observed',
      promoMarkers: [],
      level2Eligible: false,
      level2RejectReasons: reasons,
      qualityLevel: null,
      discountAllocated: null,
    } as never;
  }

  function notEnough(observations: never[]) {
    return {
      status: 'not_enough_points',
      target: { type: 'merchant_product', key: 'mp-a' },
      observations,
      points: [],
      comparableOccurrenceCount: 0,
    } as never;
  }

  function recordNeither(args: {
    assessments: ReturnType<typeof neitherAssessment>[];
    monetaryByReceipt?: Record<string, ReturnType<typeof monetary>>;
    observations?: never[];
  }) {
    const funnel = createEmptyAp3CandidateFunnel();
    const cache = new Map(
      args.assessments.map((a) => [
        a.receiptId,
        {
          amountBasisAssessment: a,
          monetaryCoherenceEvidence:
            args.monetaryByReceipt?.[a.receiptId] ??
            monetary({ state: 'known_incoherent', sufficient: false }),
        },
      ])
    );
    const observations =
      args.observations ??
      (args.assessments.map((a) =>
        obs(a.receiptId, ['amount_basis_untrusted'])
      ) as never[]);
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: notEnough(observations),
      receiptEvidenceCache: cache as never,
    });
    return funnel;
  }

  it('classifier buckets + closer sides', () => {
    expect(
      classifyNeitherCloseResiduals({
        receiptTotal: 1000,
        expectedTotalIfTaxIncluded: 1003,
        expectedTotalIfTaxExcluded: 1100,
      })
    ).toMatchObject({ bucket: 'le3', closer: 'included', closestResidual: 3 });

    expect(
      classifyNeitherCloseResiduals({
        receiptTotal: 1000,
        expectedTotalIfTaxIncluded: 1100,
        expectedTotalIfTaxExcluded: 1004.5,
      })
    ).toMatchObject({ bucket: '4to5', closer: 'excluded' });

    expect(
      classifyNeitherCloseResiduals({
        receiptTotal: 1000,
        expectedTotalIfTaxIncluded: 1008,
        expectedTotalIfTaxExcluded: 1200,
      }).bucket
    ).toBe('6to10');

    expect(
      classifyNeitherCloseResiduals({
        receiptTotal: 1000,
        expectedTotalIfTaxIncluded: 1030,
        expectedTotalIfTaxExcluded: 1200,
      }).bucket
    ).toBe('11to50');

    expect(
      classifyNeitherCloseResiduals({
        receiptTotal: 1000,
        expectedTotalIfTaxIncluded: 1200,
        expectedTotalIfTaxExcluded: 1300,
      }).bucket
    ).toBe('gt50');

    expect(
      classifyNeitherCloseResiduals({
        receiptTotal: 1000,
        expectedTotalIfTaxIncluded: 1010,
        expectedTotalIfTaxExcluded: 1010,
      })
    ).toMatchObject({ closer: 'equal', bucket: '6to10' });

    expect(
      classifyNeitherCloseResiduals({
        receiptTotal: 1000,
        expectedTotalIfTaxIncluded: null,
        expectedTotalIfTaxExcluded: null,
      })
    ).toMatchObject({
      bucket: 'unavailable',
      closer: 'unavailable',
    });
  });

  it('Case 1 — residual 3 → Le3 + IncludedCloser', () => {
    const funnel = recordNeither({
      assessments: [
        neitherAssessment({
          receiptId: 'r1',
          receiptTotal: 1000,
          expectedIncluded: 1003,
          expectedExcluded: 1080,
        }),
      ],
    });
    expect(funnel.mpNeitherObservationCount).toBe(1);
    expect(funnel.mpNeitherTargetCount).toBe(1);
    expect(funnel.mpNeitherClosestResidualLe3).toBe(1);
    expect(funnel.mpNeitherIncludedCloser).toBe(1);
    expect(assertAp3MpNeitherCloseInvariants(funnel)).toBe(true);
  });

  it('Cases 2–5 residual buckets', () => {
    const funnel = recordNeither({
      assessments: [
        neitherAssessment({
          receiptId: 'a',
          receiptTotal: 1000,
          expectedIncluded: 1004,
          expectedExcluded: 1200,
        }),
        neitherAssessment({
          receiptId: 'b',
          receiptTotal: 1000,
          expectedIncluded: 1007,
          expectedExcluded: 1200,
        }),
        neitherAssessment({
          receiptId: 'c',
          receiptTotal: 1000,
          expectedIncluded: 1025,
          expectedExcluded: 1200,
        }),
        neitherAssessment({
          receiptId: 'd',
          receiptTotal: 1000,
          expectedIncluded: 1200,
          expectedExcluded: 1300,
        }),
      ],
    });
    expect(funnel.mpNeitherClosestResidual4To5).toBe(1);
    expect(funnel.mpNeitherClosestResidual6To10).toBe(1);
    expect(funnel.mpNeitherClosestResidual11To50).toBe(1);
    expect(funnel.mpNeitherClosestResidualGt50).toBe(1);
    expect(funnel.mpNeitherObservationCount).toBe(4);
    expect(assertAp3MpNeitherCloseInvariants(funnel)).toBe(true);
  });

  it('Case 6 — equal residual', () => {
    const funnel = recordNeither({
      assessments: [
        neitherAssessment({
          receiptId: 'eq',
          receiptTotal: 1000,
          expectedIncluded: 1010,
          expectedExcluded: 1010,
        }),
      ],
    });
    expect(funnel.mpNeitherEqualResidual).toBe(1);
  });

  it('Case 7 — missing expected → unavailable, no crash', () => {
    const funnel = recordNeither({
      assessments: [
        neitherAssessment({
          receiptId: 'miss',
          receiptTotal: 1000,
          expectedIncluded: null,
          expectedExcluded: null,
        }),
      ],
    });
    expect(funnel.mpNeitherClosestResidualUnavailable).toBe(1);
    expect(funnel.mpNeitherResidualComparisonUnavailable).toBe(1);
    expect(assertAp3MpNeitherCloseInvariants(funnel)).toBe(true);
  });

  it('cohort excludes tax_untrusted / incoherent-only / known medium coupon', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    const cache = new Map([
      [
        'tax-u',
        {
          amountBasisAssessment: neitherAssessment({
            receiptId: 'tax-u',
            receiptTotal: 1000,
            expectedIncluded: 1000,
            expectedExcluded: 1080,
            reasonCodes: ['tax_untrusted'],
          }),
          monetaryCoherenceEvidence: monetary({ state: 'unknown' }),
        },
      ],
      [
        'incoh',
        {
          amountBasisAssessment: neitherAssessment({
            receiptId: 'incoh',
            receiptTotal: 1000,
            expectedIncluded: 1000,
            expectedExcluded: 1080,
            reasonCodes: ['monetary_source_incoherent'],
          }),
          monetaryCoherenceEvidence: monetary({ state: 'unknown' }),
        },
      ],
      [
        'coupon',
        {
          amountBasisAssessment: {
            ...neitherAssessment({
              receiptId: 'coupon',
              receiptTotal: 972,
              expectedIncluded: 900,
              expectedExcluded: 972,
              unallocated: -100,
              reasonCodes: [],
            }),
            basis: 'tax_excluded' as const,
            confidence: 'medium' as const,
            evidence: ['unallocated_discount_present'],
          },
          monetaryCoherenceEvidence: monetary({
            state: 'known_coherent',
            sufficient: true,
          }),
        },
      ],
      [
        'neither',
        {
          amountBasisAssessment: neitherAssessment({
            receiptId: 'neither',
            receiptTotal: 1000,
            expectedIncluded: 1003,
            expectedExcluded: 1100,
          }),
          monetaryCoherenceEvidence: monetary({
            state: 'known_incoherent',
            sufficient: false,
            layer: 'ocr',
          }),
        },
      ],
    ]);
    recordAp3MpNotEnoughPointsComparability(funnel, {
      membershipRowCount: 2,
      identityRowCount: 2,
      history: notEnough([
        obs('tax-u'),
        obs('incoh'),
        obs('coupon'),
        obs('neither'),
      ] as never[]),
      receiptEvidenceCache: cache as never,
    });
    expect(funnel.mpNeitherObservationCount).toBe(1);
    expect(funnel.mpNeitherClosestResidualLe3).toBe(1);
    expect(funnel.mpNeitherMonetaryStateIncoherent).toBe(1);
    expect(funnel.mpNeitherMonetaryProvenanceInsufficient).toBe(1);
    expect(funnel.mpNeitherLayerOcr).toBe(1);
    expect(funnel.mpNeitherRemainderZero).toBe(1);
    expect(assertAp3MpNeitherCloseInvariants(funnel)).toBe(true);
  });

  it('monetary Case A — known_coherent + sufficient', () => {
    const funnel = recordNeither({
      assessments: [
        neitherAssessment({
          receiptId: 'coh',
          receiptTotal: 1000,
          expectedIncluded: 1003,
          expectedExcluded: 1100,
        }),
      ],
      monetaryByReceipt: {
        coh: monetary({ state: 'known_coherent', sufficient: true }),
      },
    });
    expect(funnel.mpNeitherMonetaryStateCoherent).toBe(1);
    expect(funnel.mpNeitherMonetaryProvenanceSufficient).toBe(1);
    expect(funnel.mpNeitherMonetaryStateIncoherent).toBe(0);
    expect(funnel.mpNeitherMonetaryProvenanceInsufficient).toBe(0);
    expect(assertAp3MpNeitherCloseInvariants(funnel)).toBe(true);
  });

  it('monetary Case B — known_incoherent + insufficient (not swallowed as only insufficient)', () => {
    const funnel = recordNeither({
      assessments: [
        neitherAssessment({
          receiptId: 'inc',
          receiptTotal: 1000,
          expectedIncluded: 1003,
          expectedExcluded: 1100,
        }),
      ],
      monetaryByReceipt: {
        inc: monetary({ state: 'known_incoherent', sufficient: false }),
      },
    });
    expect(funnel.mpNeitherMonetaryStateIncoherent).toBe(1);
    expect(funnel.mpNeitherMonetaryProvenanceInsufficient).toBe(1);
    expect(funnel.mpNeitherMonetaryStateUnknown).toBe(0);
    expect(funnel.mpNeitherMonetaryProvenanceSufficient).toBe(0);
    expect(assertAp3MpNeitherCloseInvariants(funnel)).toBe(true);
  });

  it('monetary Case C — unknown + insufficient (state Unknown preserved)', () => {
    const funnel = recordNeither({
      assessments: [
        neitherAssessment({
          receiptId: 'unk',
          receiptTotal: 1000,
          expectedIncluded: 1003,
          expectedExcluded: 1100,
        }),
      ],
      monetaryByReceipt: {
        unk: monetary({ state: 'unknown', sufficient: false }),
      },
    });
    expect(funnel.mpNeitherMonetaryStateUnknown).toBe(1);
    expect(funnel.mpNeitherMonetaryProvenanceInsufficient).toBe(1);
    expect(funnel.mpNeitherMonetaryStateIncoherent).toBe(0);
    expect(assertAp3MpNeitherCloseInvariants(funnel)).toBe(true);
  });

  it('orthogonal monetary families: state + provenance each partition observationCount', () => {
    const funnel = recordNeither({
      assessments: [
        neitherAssessment({
          receiptId: 'a',
          receiptTotal: 1000,
          expectedIncluded: 1003,
          expectedExcluded: 1100,
        }),
        neitherAssessment({
          receiptId: 'b',
          receiptTotal: 1000,
          expectedIncluded: 1004,
          expectedExcluded: 1100,
        }),
        neitherAssessment({
          receiptId: 'c',
          receiptTotal: 1000,
          expectedIncluded: 1008,
          expectedExcluded: 1100,
        }),
      ],
      monetaryByReceipt: {
        a: monetary({ state: 'known_coherent', sufficient: true }),
        b: monetary({ state: 'known_incoherent', sufficient: false }),
        c: monetary({ state: 'unknown', sufficient: false }),
      },
    });
    expect(funnel.mpNeitherObservationCount).toBe(3);
    expect(
      funnel.mpNeitherMonetaryStateCoherent +
        funnel.mpNeitherMonetaryStateIncoherent +
        funnel.mpNeitherMonetaryStateUnknown
    ).toBe(3);
    expect(
      funnel.mpNeitherMonetaryProvenanceSufficient +
        funnel.mpNeitherMonetaryProvenanceInsufficient
    ).toBe(3);
    expect(funnel.mpNeitherMonetaryStateCoherent).toBe(1);
    expect(funnel.mpNeitherMonetaryStateIncoherent).toBe(1);
    expect(funnel.mpNeitherMonetaryStateUnknown).toBe(1);
    expect(funnel.mpNeitherMonetaryProvenanceSufficient).toBe(1);
    expect(funnel.mpNeitherMonetaryProvenanceInsufficient).toBe(2);
    expect(assertAp3MpNeitherCloseInvariants(funnel)).toBe(true);
  });

  it('gating — Analysis-D OFF: no companion event; ON: emitted with 23 keys', () => {
    const funnel = recordNeither({
      assessments: [
        neitherAssessment({
          receiptId: 'r1',
          receiptTotal: 1000,
          expectedIncluded: 1003,
          expectedExcluded: 1100,
        }),
      ],
    });

    setAp3NeitherCloseDiagnosticsEnabledForTests(false);
    emitAp3CandidateFunnel(funnel);
    expect(
      getDiagnosticSnapshot().events.some(
        (e) => e.name === 'ap3_candidate_funnel_mp_neither_close_shape'
      )
    ).toBe(false);

    clearDiagnostics();
    setAp3NeitherCloseDiagnosticsEnabledForTests(true);
    emitAp3CandidateFunnel(funnel);
    const event = getDiagnosticSnapshot().events.find(
      (e) => e.name === 'ap3_candidate_funnel_mp_neither_close_shape'
    );
    expect(event).toBeTruthy();
    expect(Object.keys(event?.meta ?? {}).length).toBe(23);
    expect(Object.keys(event?.meta ?? {}).length).toBeLessThanOrEqual(24);
    expect(event?.meta).toHaveProperty('mpNeitherMonetaryStateCoherent');
    expect(event?.meta).toHaveProperty('mpNeitherMonetaryStateIncoherent');
    expect(event?.meta).toHaveProperty('mpNeitherMonetaryStateUnknown');
    expect(event?.meta).toHaveProperty(
      'mpNeitherMonetaryProvenanceSufficient'
    );
    expect(event?.meta).toHaveProperty(
      'mpNeitherMonetaryProvenanceInsufficient'
    );
    expect(event?.meta).not.toHaveProperty('mpNeitherMonetaryCoherent');
    expect(event?.meta).not.toHaveProperty('mpNeitherMonetaryIncoherent');
    expect(event?.meta).not.toHaveProperty('mpNeitherMonetaryInsufficient');
    expect(event?.meta).not.toHaveProperty('mpNeitherMonetaryUnknown');
    for (const value of Object.values(event?.meta ?? {})) {
      expect(typeof value).toBe('number');
    }
    expect(JSON.stringify(event)).not.toContain('r1');
  });

  it('gate helper respects Internal+Analysis-D production contract via test seam', () => {
    setAp3NeitherCloseDiagnosticsEnabledForTests(false);
    expect(shouldRecordAp3NeitherCloseDiagnostics()).toBe(false);
    setAp3NeitherCloseDiagnosticsEnabledForTests(true);
    expect(shouldRecordAp3NeitherCloseDiagnostics()).toBe(true);
  });

  it('direct recorder increments remainder non-zero + user layer', () => {
    const funnel = createEmptyAp3CandidateFunnel();
    recordAp3MpNeitherCloseShape(funnel, {
      history: notEnough([obs('u1')] as never[]),
      receiptEvidenceCache: new Map([
        [
          'u1',
          {
            amountBasisAssessment: neitherAssessment({
              receiptId: 'u1',
              receiptTotal: 1000,
              expectedIncluded: 1003,
              expectedExcluded: 1100,
              unallocated: -50,
            }),
            monetaryCoherenceEvidence: monetary({
              state: 'known_coherent',
              sufficient: true,
              layer: 'user',
            }),
          },
        ],
      ]) as never,
    });
    expect(funnel.mpNeitherRemainderNonZero).toBe(1);
    expect(funnel.mpNeitherLayerUser).toBe(1);
    expect(funnel.mpNeitherMonetaryStateCoherent).toBe(1);
    expect(funnel.mpNeitherMonetaryProvenanceSufficient).toBe(1);
    expect(assertAp3MpNeitherCloseInvariants(funnel)).toBe(true);
  });
});
