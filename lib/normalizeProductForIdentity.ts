/**
 * Product Identity Batch 2 — combined normalization + structural parse API.
 *
 * Does not write to DB / receipts / entities.
 * Does not call Gemini.
 * Does not change Analysis D or live `parseProductSpecification`.
 */

import type { ProductAttributes } from './productIdentityContract';
import {
  normalizeProductText,
  UNIVERSAL_PRODUCT_NORMALIZER_VERSION,
  type NormalizedProductText,
} from './universalProductNormalizer';
import {
  parseStructuralProductAttributes,
  UNIVERSAL_PRODUCT_SPEC_PARSER_VERSION,
  type StructuralParseEvidence,
} from './universalProductSpecParser';

export const PRODUCT_NORMALIZATION_PIPELINE_VERSION =
  'meruno-product-normalization-pipeline-v1' as const;

export type ProductNormalizationResult = {
  rawName: string;
  normalizedName: string;
  comparisonKey: string;
  tokens: string[];
  attributes: ProductAttributes;
  evidence: StructuralParseEvidence[];
  normalizerVersion: typeof UNIVERSAL_PRODUCT_NORMALIZER_VERSION;
  parserVersion: typeof UNIVERSAL_PRODUCT_SPEC_PARSER_VERSION;
  pipelineVersion: typeof PRODUCT_NORMALIZATION_PIPELINE_VERSION;
};

/**
 * Normalize OCR product text and extract structural ProductAttributes.
 * Safe for unknown / non-grocery products; partial attributes are OK.
 */
export function normalizeProductForIdentity(
  rawName: string
): ProductNormalizationResult {
  const text: NormalizedProductText = normalizeProductText(rawName);
  const parsed = parseStructuralProductAttributes(rawName);

  return {
    rawName: typeof rawName === 'string' ? rawName : '',
    normalizedName: text.normalized,
    comparisonKey: text.comparisonKey,
    tokens: text.tokens,
    attributes: parsed.attributes,
    evidence: parsed.evidence,
    normalizerVersion: UNIVERSAL_PRODUCT_NORMALIZER_VERSION,
    parserVersion: UNIVERSAL_PRODUCT_SPEC_PARSER_VERSION,
    pipelineVersion: PRODUCT_NORMALIZATION_PIPELINE_VERSION,
  };
}

/**
 * H8.4 — pass-local normalize memo counters (real operation increments).
 * Lifetime: one consumer pass / inventory build. No module/global cache.
 */
export type ProductIdentityNormalizePassStats = {
  normalizeRequests: number;
  normalizeComputations: number;
  normalizeCacheHits: number;
};

export type ProductIdentityNormalizePassCache = {
  readonly map: Map<string, ProductNormalizationResult>;
  readonly stats: ProductIdentityNormalizePassStats;
};

/** Create an empty pass-local normalize cache. */
export function createProductIdentityNormalizePassCache(): ProductIdentityNormalizePassCache {
  return {
    map: new Map(),
    stats: {
      normalizeRequests: 0,
      normalizeComputations: 0,
      normalizeCacheHits: 0,
    },
  };
}

/**
 * Resolve pass-local cache for a consumer/inventory boundary.
 * Default: create a fresh cache. Explicit `normalizePassCache` wins.
 * `__disableNormalizePassCacheForTests` forces no memo (baseline oracle).
 */
export function resolveProductIdentityNormalizePassCache(options?: {
  normalizePassCache?: ProductIdentityNormalizePassCache | null;
  __disableNormalizePassCacheForTests?: boolean;
}): ProductIdentityNormalizePassCache | null {
  if (options?.__disableNormalizePassCacheForTests) return null;
  if (options && Object.prototype.hasOwnProperty.call(options, 'normalizePassCache')) {
    return options.normalizePassCache ?? null;
  }
  return createProductIdentityNormalizePassCache();
}

/**
 * H8.4 — exact-key pass-local memo over `normalizeProductForIdentity`.
 * Cache key is the exact `rawName` argument (no trim/case canonicalization).
 * When `cache` is null/undefined, delegates to the uncached function.
 */
export function normalizeProductForIdentityCached(
  rawName: string,
  cache?: ProductIdentityNormalizePassCache | null
): ProductNormalizationResult {
  if (!cache) {
    return normalizeProductForIdentity(rawName);
  }
  cache.stats.normalizeRequests += 1;
  const hit = cache.map.get(rawName);
  if (hit) {
    cache.stats.normalizeCacheHits += 1;
    return hit;
  }
  cache.stats.normalizeComputations += 1;
  const computed = normalizeProductForIdentity(rawName);
  cache.map.set(rawName, computed);
  return computed;
}
