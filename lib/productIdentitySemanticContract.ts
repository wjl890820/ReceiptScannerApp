/**
 * Product Identity Batch 4 — semantic enrichment contract + sanitize.
 * AI output is evidence only. Never grants product_exact / CanonicalProduct.
 * Deterministic structural attributes always win over AI.
 */

import {
  emptyProductAttributes,
  type ProductAttributeEntry,
  type ProductAttributes,
} from './productIdentityContract';
import {
  PRODUCT_IDENTITY_SEMANTIC_VERSION,
  type SemanticStatus,
} from './productIdentitySemanticGate';

export const SEMANTIC_BRAND_APPLY_THRESHOLD = 0.85;
export const SEMANTIC_CANONICAL_NAME_APPLY_THRESHOLD = 0.9;
export const SEMANTIC_ATTRIBUTE_APPLY_THRESHOLD = 0.75;

export type SemanticEnrichmentRequestItem = {
  index: number;
  rawName: string;
  normalizedName?: string | null;
  merchantName?: string | null;
  knownCategory?: string | null;
  knownFamily?: string | null;
  knownAttributes?: ProductAttributes | null;
};

export type SemanticEnrichmentAiItem = {
  index: number;
  categoryId?: string | null;
  categoryConfidence?: number | null;
  brand?: string | null;
  brandConfidence?: number | null;
  canonicalName?: string | null;
  canonicalNameConfidence?: number | null;
  productType?: string | null;
  semanticTags?: string[] | null;
  attributes?: Array<{
    dimension?: string;
    value?: number | string | null;
    unit?: string | null;
    confidence?: number | null;
  }> | null;
  confidence?: number | null;
  reason?: string | null;
  janCode?: unknown;
  skuId?: unknown;
  barcode?: unknown;
};

export type SemanticAttributeConflict = {
  dimension: string;
  codeValue: string;
  aiValue: string;
};

export type AppliedSemanticEnrichment = {
  status: SemanticStatus;
  brand: string | null;
  suggestedBrand: string | null;
  canonicalName: string | null;
  suggestedCanonicalName: string | null;
  productType: string | null;
  semanticTags: string[];
  attributes: ProductAttributes;
  categoryId: string | null;
  categoryConfidence: number | null;
  overallConfidence: number;
  reason: string | null;
  conflicts: SemanticAttributeConflict[];
  semanticResolverVersion: string;
  appliedBrand: boolean;
  appliedCanonicalName: boolean;
  appliedAttributeCount: number;
  rejectedJan: boolean;
};

function clamp01(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function cleanText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function attrsByDimension(
  attrs: ProductAttributes | null | undefined
): Map<string, ProductAttributeEntry> {
  const map = new Map<string, ProductAttributeEntry>();
  for (const e of attrs?.entries ?? []) map.set(String(e.dimension), e);
  return map;
}

export function applySemanticEnrichmentEvidence(
  ai: SemanticEnrichmentAiItem,
  codeAttributes: ProductAttributes | null | undefined
): AppliedSemanticEnrichment {
  const conflicts: SemanticAttributeConflict[] = [];
  const rejectedJan = ai.janCode != null || ai.skuId != null || ai.barcode != null;

  const overall = clamp01(ai.confidence);
  const brandConf = clamp01(ai.brandConfidence ?? ai.confidence);
  const canonConf = clamp01(ai.canonicalNameConfidence ?? ai.confidence);

  const brandRaw = cleanText(ai.brand, 80);
  const canonRaw = cleanText(ai.canonicalName, 120);
  const productType = cleanText(ai.productType, 40);
  const reason = cleanText(ai.reason, 160);
  const categoryId = cleanText(ai.categoryId, 40);

  let brand: string | null = null;
  let suggestedBrand: string | null = null;
  let appliedBrand = false;
  if (brandRaw) {
    if (brandConf >= SEMANTIC_BRAND_APPLY_THRESHOLD) {
      brand = brandRaw;
      appliedBrand = true;
    } else {
      suggestedBrand = brandRaw;
    }
  }

  let canonicalName: string | null = null;
  let suggestedCanonicalName: string | null = null;
  let appliedCanonicalName = false;
  if (canonRaw) {
    if (canonConf >= SEMANTIC_CANONICAL_NAME_APPLY_THRESHOLD) {
      canonicalName = canonRaw;
      appliedCanonicalName = true;
    } else {
      suggestedCanonicalName = canonRaw;
    }
  }

  const tags = Array.isArray(ai.semanticTags)
    ? ai.semanticTags.map((t) => cleanText(t, 32)).filter((t): t is string => !!t).slice(0, 12)
    : [];

  const codeMap = attrsByDimension(codeAttributes ?? emptyProductAttributes());
  const merged: ProductAttributeEntry[] = [...(codeAttributes?.entries ?? []).map((e) => ({ ...e }))];
  let appliedAttributeCount = 0;

  for (const raw of ai.attributes ?? []) {
    const dim = cleanText(raw?.dimension, 40);
    if (!dim) continue;
    if (/^(jan|sku|barcode|ean|gtin)/i.test(dim)) continue;
    const conf = clamp01(raw?.confidence ?? ai.confidence);
    if (conf < SEMANTIC_ATTRIBUTE_APPLY_THRESHOLD) continue;

    const unit = cleanText(raw?.unit, 16);
    const value =
      typeof raw?.value === 'number' || typeof raw?.value === 'string' ? raw.value : null;

    const existing = codeMap.get(dim);
    if (existing) {
      const codeVal = `${existing.value ?? ''}${existing.unit ?? ''}`;
      const aiVal = `${value ?? ''}${unit ?? ''}`;
      if (codeVal && aiVal && codeVal !== aiVal) {
        conflicts.push({ dimension: dim, codeValue: codeVal, aiValue: aiVal });
      }
      continue;
    }

    merged.push({
      dimension: dim,
      value,
      unit,
      confidence: conf,
      source: 'ai_semantic',
    });
    appliedAttributeCount += 1;
  }

  const status: SemanticStatus =
    appliedBrand || appliedCanonicalName || appliedAttributeCount > 0
      ? 'enriched'
      : overall >= 0.5
        ? 'partial'
        : 'failed';

  return {
    status,
    brand,
    suggestedBrand,
    canonicalName,
    suggestedCanonicalName,
    productType,
    semanticTags: tags,
    attributes: { version: 'product-attributes-v1', entries: merged },
    categoryId,
    categoryConfidence: clamp01(ai.categoryConfidence ?? ai.confidence),
    overallConfidence: overall,
    reason,
    conflicts,
    semanticResolverVersion: PRODUCT_IDENTITY_SEMANTIC_VERSION,
    appliedBrand,
    appliedCanonicalName,
    appliedAttributeCount,
    rejectedJan,
  };
}

export type MerchantProductSemanticCache = {
  status: SemanticStatus;
  brand: string | null;
  suggestedBrand: string | null;
  canonicalName: string | null;
  suggestedCanonicalName: string | null;
  productType: string | null;
  semanticTags: string[];
  attributes: ProductAttributes | null;
  confidence: number;
  reason: string | null;
  conflicts: SemanticAttributeConflict[];
  semanticResolverVersion: string;
  modelVersion: string | null;
  /** Binds cache to name/merchant/attrs/version — rename/edit must miss. */
  inputFingerprint: string;
  enrichedAt: string;
};


export function buildSemanticInputFingerprint(input: {
  rawName: string;
  merchantKey?: string | null;
  /** Deterministic ProductAttributes only — never AI-enriched attrs. */
  attributes?: ProductAttributes | null;
  semanticResolverVersion: string;
}): string {
  const attrsKey = (input.attributes?.entries ?? [])
    .map((e) => `${e.dimension}:${e.value ?? ''}:${e.unit ?? ''}`)
    .sort()
    .join('|');
  return [
    (input.rawName || '').trim().toLowerCase(),
    (input.merchantKey || '').trim().toLowerCase(),
    attrsKey,
    input.semanticResolverVersion,
  ].join('\u001f');
}

/**
 * Active semantic model pin for cache validation.
 * SSOT = getSemanticGeminiModel() (classify-items / GEMINI_MODEL).
 * NEVER uses OCR_GEMINI_MODEL. Never inferred from cached records.
 */
export function getActiveSemanticModelVersion(): string {
  try {
    // Lazy require avoids circular env imports in pure contract tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const env = require('./env') as {
      getSemanticGeminiModel?: () => string;
      DEFAULT_SEMANTIC_GEMINI_MODEL?: string;
    };
    const pinned =
      typeof process !== 'undefined'
        ? String(
            (process as NodeJS.Process).env?.EXPO_PUBLIC_SEMANTIC_MODEL_VERSION ||
              (process as NodeJS.Process).env?.SEMANTIC_MODEL_VERSION ||
              (process as NodeJS.Process).env?.EXPO_PUBLIC_SEMANTIC_GEMINI_MODEL ||
              (process as NodeJS.Process).env?.SEMANTIC_GEMINI_MODEL ||
              (process as NodeJS.Process).env?.GEMINI_MODEL ||
              ''
          ).trim()
        : '';
    if (pinned) return pinned;
    if (typeof env.getSemanticGeminiModel === 'function') {
      const v = String(env.getSemanticGeminiModel() || '').trim();
      if (v) return v;
    }
    return env.DEFAULT_SEMANTIC_GEMINI_MODEL || 'gemini-3.5-flash';
  } catch {
    return 'gemini-3.5-flash';
  }
}

export function isSemanticModelVersionCompatible(
  cachedModelVersion: string | null | undefined,
  activeModelVersion: string | null | undefined = getActiveSemanticModelVersion()
): boolean {
  const active = (activeModelVersion ?? '').trim();
  if (!active) return true;
  return (cachedModelVersion ?? '').trim() === active;
}

export function buildSemanticCacheRecord(
  applied: AppliedSemanticEnrichment,
  modelVersion: string | null,
  inputFingerprint: string = ''
): MerchantProductSemanticCache {
  return {
    status: applied.status,
    brand: applied.brand,
    suggestedBrand: applied.suggestedBrand,
    canonicalName: applied.canonicalName,
    suggestedCanonicalName: applied.suggestedCanonicalName,
    productType: applied.productType,
    semanticTags: applied.semanticTags,
    attributes: applied.attributes,
    confidence: applied.overallConfidence,
    reason: applied.reason,
    conflicts: applied.conflicts,
    semanticResolverVersion: applied.semanticResolverVersion,
    modelVersion,
    inputFingerprint,
    enrichedAt: new Date().toISOString(),
  };
}

export function semanticCacheMatchesInput(
  cache: MerchantProductSemanticCache | null | undefined,
  inputFingerprint: string,
  semanticResolverVersion: string = PRODUCT_IDENTITY_SEMANTIC_VERSION,
  activeModelVersion: string | null | undefined = getActiveSemanticModelVersion()
): boolean {
  if (!cache) return false;
  if (cache.semanticResolverVersion !== semanticResolverVersion) return false;
  if (!inputFingerprint || cache.inputFingerprint !== inputFingerprint) return false;
  if (!isSemanticModelVersionCompatible(cache.modelVersion, activeModelVersion)) {
    return false;
  }
  return cache.status === 'enriched' || cache.status === 'sufficient';
}
