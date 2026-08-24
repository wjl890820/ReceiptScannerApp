/**
 * Product Identity Batch 4.1 — semantic selection dry-run (no live Gemini).
 */

import {
  resolveReceiptItemIdentity,
  type ResolveIdentityResult,
} from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  type ProductIdentityStore,
} from './productIdentityStore';
import {
  evaluateSemanticSufficiency,
  PRODUCT_IDENTITY_SEMANTIC_VERSION,
  type SemanticGateResult,
} from './productIdentitySemanticGate';
import {
  emptyProductAttributes,
  type ProductAttributes,
} from './productIdentityContract';
import type { ShadowIdentityObservation } from './productIdentityShadowAudit';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import type { MerchantProductSemanticCache } from './productIdentitySemanticContract';
import { resolveLocalCategoryForSemanticGate } from './productIdentityLocalCategory';

export type SemanticShadowObservationResult = {
  receiptId: string;
  itemSourceIndex: number;
  rawName: string;
  merchantKey: string;
  existingMatch: boolean;
  newEntity: boolean;
  localCategory: string;
  localCategoryConfidence: number;
  localCategorySource: string;
  gate: SemanticGateResult;
  wouldSendToAi: boolean;
  semanticCacheHit: boolean;
  merchantProductId: string | null;
  comparisonKey: string | null;
};

export type SemanticShadowAuditReport = {
  eligibleObservations: number;
  existingMerchantProductReuse: number;
  newMerchantProduct: number;
  semanticSufficientWithoutAi: number;
  semanticNeedsEnrichment: number;
  distinctMerchantProductsSufficient: number;
  distinctMerchantProductsNeedingEnrichment: number;
  semanticCacheHit: number;
  existingSemanticCacheHits: number;
  wouldSendToAi: number;
  cacheableDistinctProductsNeedingEnrichment: number;
  distinctMerchantProducts: number;
  historicalMaxSemanticItemSendsUncached: number;
  historicalSemanticItemSendsWithCache: number;
  geminiLiveCalls: number;
  ratioDistinctNeedingAi: number;
  observations: SemanticShadowObservationResult[];
};

function attrsFromName(rawName: string): ProductAttributes {
  try {
    return normalizeProductForIdentity(rawName).attributes ?? emptyProductAttributes();
  } catch {
    return emptyProductAttributes();
  }
}

function cacheRecord(
  status: 'enriched' | 'sufficient',
  attrs: ProductAttributes,
  confidence: number,
  reason: string,
  brand: string | null = null
): MerchantProductSemanticCache {
  return {
    status,
    brand,
    suggestedBrand: null,
    canonicalName: null,
    suggestedCanonicalName: null,
    productType: null,
    semanticTags: [],
    attributes: attrs,
    confidence,
    reason,
    conflicts: [],
    semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
    inputFingerprint: '',
    modelVersion: null,
    enrichedAt: new Date().toISOString(),
  };
}

export function runSemanticShadowSelectionAudit(
  observations: ShadowIdentityObservation[],
  store: ProductIdentityStore = createMemoryProductIdentityStore()
): SemanticShadowAuditReport {
  const rows: SemanticShadowObservationResult[] = [];
  const mpNeed = new Set<string>();
  const mpSufficient = new Set<string>();
  const mpAll = new Set<string>();
  const mpEvaluated = new Set<string>();

  let existingReuse = 0;
  let newEntityCount = 0;
  let sufficient = 0;
  let needs = 0;
  let cacheHits = 0;
  let existingSemanticCacheHits = 0;
  let wouldSend = 0;

  for (const obs of observations) {
    const resolved: ResolveIdentityResult = resolveReceiptItemIdentity(
      {
        rawName: obs.rawName,
        merchantKey: obs.merchantKey,
        receiptId: obs.receiptId,
        itemSourceIndex: obs.itemSourceIndex,
        quantity: obs.quantity,
        lineTotal: obs.lineTotal,
      },
      store
    );

    const existingMatch =
      !resolved.createdMerchantProduct && !!resolved.link.merchantProductId;
    const created = !!resolved.createdMerchantProduct;
    if (existingMatch) existingReuse += 1;
    if (created) newEntityCount += 1;

    const mpId = resolved.link.merchantProductId;
    const mp = mpId
      ? store.listMerchantProducts(obs.merchantKey).find((m) => m.id === mpId) ?? null
      : null;
    if (mp) mpAll.add(mp.id);

    const cachedStatus = mp?.semanticStatus ?? null;
    const semanticCacheHit =
      cachedStatus === 'enriched' || cachedStatus === 'sufficient';
    if (semanticCacheHit) {
      cacheHits += 1;
      if (existingMatch) existingSemanticCacheHits += 1;
    }

    const local = resolveLocalCategoryForSemanticGate(
      obs.rawName,
      mp?.normalizedName ?? resolved.normalizedName ?? obs.rawName,
      obs.merchantKey
    );

    const attrs = mp?.attributes ?? resolved.attributes ?? attrsFromName(obs.rawName);
    const gate = evaluateSemanticSufficiency({
      rawName: obs.rawName,
      normalizedName: mp?.normalizedName ?? resolved.normalizedName ?? obs.rawName,
      comparisonKey: mp?.comparisonKey ?? resolved.comparisonKey ?? null,
      merchantKey: obs.merchantKey,
      existingMerchantProductMatch: existingMatch,
      createdMerchantProduct: created,
      brand: mp?.brand ?? null,
      category: local.category,
      categoryConfidence: local.confidence,
      categorySource: local.source,
      attributes: attrs,
      cachedSemanticStatus: cachedStatus,
      identityLevel: resolved.link.identityLevel,
      identityConfidence: resolved.link.identityConfidence,
    });

    if (!gate.needsEnrichment) sufficient += 1;
    else needs += 1;

    const wouldSendToAi = gate.needsEnrichment && !semanticCacheHit;
    if (wouldSendToAi) {
      wouldSend += 1;
      if (mp) mpNeed.add(mp.id);
    }

    if (mp && !mpEvaluated.has(mp.id)) {
      mpEvaluated.add(mp.id);
      if (gate.needsEnrichment) mpNeed.add(mp.id);
      else mpSufficient.add(mp.id);
    }

    if (wouldSendToAi && mp && !semanticCacheHit) {
      store.saveMerchantProductSemantic(
        mp.id,
        cacheRecord('enriched', attrs, 0, 'dry_run_cache_mark')
      );
    } else if (
      mp &&
      !semanticCacheHit &&
      !gate.needsEnrichment &&
      (gate.status === 'sufficient' || gate.status === 'partial')
    ) {
      store.saveMerchantProductSemantic(
        mp.id,
        cacheRecord(
          'sufficient',
          attrs,
          local.confidence,
          'dry_run_sufficient',
          mp.brand ?? null
        )
      );
      if (!mpNeed.has(mp.id)) mpSufficient.add(mp.id);
    }

    rows.push({
      receiptId: obs.receiptId,
      itemSourceIndex: obs.itemSourceIndex,
      rawName: obs.rawName,
      merchantKey: obs.merchantKey,
      existingMatch,
      newEntity: created,
      localCategory: local.category,
      localCategoryConfidence: local.confidence,
      localCategorySource: local.source,
      gate,
      wouldSendToAi,
      semanticCacheHit,
      merchantProductId: mpId,
      comparisonKey: mp?.comparisonKey ?? null,
    });
  }

  const distinct = mpAll.size;
  const distinctNeed = mpNeed.size;
  return {
    eligibleObservations: observations.length,
    existingMerchantProductReuse: existingReuse,
    newMerchantProduct: newEntityCount,
    semanticSufficientWithoutAi: sufficient,
    semanticNeedsEnrichment: needs,
    distinctMerchantProductsSufficient: mpSufficient.size,
    distinctMerchantProductsNeedingEnrichment: distinctNeed,
    semanticCacheHit: cacheHits,
    existingSemanticCacheHits,
    wouldSendToAi: wouldSend,
    cacheableDistinctProductsNeedingEnrichment: distinctNeed,
    distinctMerchantProducts: distinct,
    historicalMaxSemanticItemSendsUncached: needs,
    historicalSemanticItemSendsWithCache: distinctNeed,
    geminiLiveCalls: 0,
    ratioDistinctNeedingAi: distinct > 0 ? distinctNeed / distinct : 0,
    observations: rows,
  };
}
