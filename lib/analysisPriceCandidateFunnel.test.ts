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
  createEmptyAp3CandidateFunnel,
  emitAp3CandidateFunnel,
  recordAp3InterpretUnavailableReasons,
  recordAp3MpTerminal,
  recordAp3SkuTerminal,
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
    expect(events.length).toBe(4);
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
