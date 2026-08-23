/**
 * Product Identity Contract V1 (Batch 1 — foundation only).
 *
 * Layered model (future resolver consumes this; Batch 1 does not resolve):
 *
 *   ReceiptItem
 *     → MerchantProduct
 *       → CanonicalProduct
 *         → ProductVariant / SKU (optional)
 *
 * Existing `lib/productIdentity.ts` / `productFamily` remain the live analysis
 * path. This module is additive: types, validators, attribute helpers, and
 * optional entity-table schema. No OCR / generative-AI / price / UI wiring.
 *
 * Contract version stamps enable future recomputation without destructive
 * rewrite of historical receipts.
 */

import type { ProductIdentity } from './productIdentity';
import type { ProductSpecification } from './productSpecification';

export const PRODUCT_IDENTITY_CONTRACT_VERSION =
  'meruno-product-identity-contract-v1' as const;

/**
 * Resolver stamp. Batch 3 shadow resolver uses v1.
 * Live Analysis enrichment still does not consume these links.
 */
export const PRODUCT_IDENTITY_RESOLVER_VERSION =
  'meruno-product-identity-resolver-v1' as const;

/**
 * Identity strength ladder. Lower rows do not imply higher ones.
 * `family_*` levels correspond to today's semantic-family analysis capability,
 * not a Merchant/Canonical entity id.
 */
export const PRODUCT_IDENTITY_LEVELS = [
  'sku_exact',
  'product_exact',
  'merchant_product',
  'family_spec',
  'family_only',
  'unresolved',
] as const;

export type ProductIdentityLevel = (typeof PRODUCT_IDENTITY_LEVELS)[number];

/**
 * Extensible provenance for how an identity link was produced.
 * Includes today's live sources plus future resolver/AI sources.
 */
export type ProductIdentitySourceV1 =
  | 'user_confirmed'
  | 'merchant_alias'
  | 'dictionary'
  | 'high_confidence_rule'
  | 'legacy_fallback'
  | 'unknown'
  | 'resolver_v1'
  | 'semantic_enrichment'
  | 'manual'
  /** Batch 3 resolution provenance (no AI). */
  | 'cache'
  | 'merchant_exact'
  | 'alias_exact'
  | 'dictionary_exact'
  | 'normalized_exact'
  | 'fuzzy_exact'
  | 'family_spec'
  | 'family_only'
  | 'unresolved';

/** Known physical / pack attribute dimensions (open set — string allows growth). */
export type ProductAttributeDimension =
  | 'mass'
  | 'volume'
  | 'count'
  | 'length'
  | 'pack_count'
  | 'battery_size'
  | 'size'
  | 'color'
  | 'model'
  | 'roll_count'
  | 'ply'
  | 'connector'
  | (string & {});

export type ProductAttributeEntry = {
  dimension: ProductAttributeDimension;
  /** Numeric magnitude when applicable; null for categorical attrs (color/model). */
  value: number | string | null;
  unit: string | null;
  confidence?: number | null;
  source?: string | null;
};

/**
 * Schema-A: versioned JSON attribute bag.
 * New product types add entries — never new DB columns.
 */
export type ProductAttributes = {
  version: 'product-attributes-v1';
  entries: ProductAttributeEntry[];
};

export type MerchantProduct = {
  id: string;
  merchantKey: string;
  /** Deterministic same-merchant lookup key (from universal normalizer). */
  comparisonKey: string | null;
  canonicalDisplayName: string | null;
  normalizedName: string | null;
  brand: string | null;
  attributes: ProductAttributes | null;
  createdAt: string;
  updatedAt: string;
  resolverVersion: string;
};

export type CanonicalProduct = {
  id: string;
  canonicalName: string;
  brand: string | null;
  categoryId: string | null;
  attributes: ProductAttributes | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Optional SKU / JAN / variant layer. All identity fields nullable.
 * Batch 1 does not build a JAN catalog.
 */
export type ProductVariant = {
  id: string;
  canonicalProductId: string | null;
  skuId: string | null;
  janCode: string | null;
  variantAttributes: ProductAttributes | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Additive link a ReceiptItem may carry in the future.
 * All entity ids nullable — unresolved / family-only rows remain valid.
 *
 * Note: today's `receipt_items.sku_key` / `identity_*` columns remain the live
 * projection of `lib/productIdentity.ts`. This link is the Batch-1+ contract
 * for entity ids and the explicit identity-level ladder.
 */
export type ReceiptItemIdentityLink = {
  merchantProductId: string | null;
  canonicalProductId: string | null;
  skuId: string | null;
  identityLevel: ProductIdentityLevel;
  identityConfidence: number;
  identitySource: ProductIdentitySourceV1 | string;
  resolverVersion: string;
};

export function isProductIdentityLevel(value: unknown): value is ProductIdentityLevel {
  return (
    typeof value === 'string' &&
    (PRODUCT_IDENTITY_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Clamp confidence into [0, 1]. Non-finite → 0 (never invent mid-range scores).
 */
export function clampIdentityConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function emptyProductAttributes(): ProductAttributes {
  return { version: 'product-attributes-v1', entries: [] };
}

export function buildProductAttributes(
  entries: readonly ProductAttributeEntry[]
): ProductAttributes {
  return {
    version: 'product-attributes-v1',
    entries: entries.map((entry) => ({
      dimension: entry.dimension,
      value: entry.value,
      unit: entry.unit,
      confidence:
        entry.confidence === undefined
          ? undefined
          : clampIdentityConfidence(entry.confidence),
      source: entry.source ?? null,
    })),
  };
}

/** Map today's ProductSpecification into generic attributes (no family-specific columns). */
export function productAttributesFromSpecification(
  spec: Pick<
    ProductSpecification,
    | 'dimension'
    | 'sizeValue'
    | 'sizeUnit'
    | 'packCount'
    | 'volumeBaseMl'
    | 'weightBaseG'
    | 'countBase'
    | 'reliability'
    | 'confidence'
    | 'sourceText'
  >
): ProductAttributes {
  const entries: ProductAttributeEntry[] = [];
  const conf =
    spec.reliability === 'exact' ? 1 : spec.reliability === 'partial' ? 0.5 : 0;

  if (spec.dimension === 'volume' && spec.sizeValue != null) {
    entries.push({
      dimension: 'volume',
      value: spec.sizeValue,
      unit: spec.sizeUnit,
      confidence: conf,
      source: spec.sourceText,
    });
  } else if (spec.dimension === 'weight' && spec.sizeValue != null) {
    entries.push({
      dimension: 'mass',
      value: spec.sizeValue,
      unit: spec.sizeUnit,
      confidence: conf,
      source: spec.sourceText,
    });
  } else if (spec.dimension === 'count' && spec.sizeValue != null) {
    entries.push({
      dimension: 'count',
      value: spec.sizeValue,
      unit: spec.sizeUnit ?? 'count',
      confidence: conf,
      source: spec.sourceText,
    });
  }

  if (spec.packCount != null && Number.isFinite(spec.packCount) && spec.packCount > 1) {
    entries.push({
      dimension: 'pack_count',
      value: spec.packCount,
      unit: 'count',
      confidence: conf,
      source: spec.sourceText,
    });
  }

  // Prefer normalized base units when present (still generic dimensions).
  if (spec.volumeBaseMl != null && Number.isFinite(spec.volumeBaseMl)) {
    if (!entries.some((e) => e.dimension === 'volume' && e.unit === 'ml')) {
      entries.push({
        dimension: 'volume',
        value: spec.volumeBaseMl,
        unit: 'ml',
        confidence: conf,
        source: spec.sourceText,
      });
    }
  }
  if (spec.weightBaseG != null && Number.isFinite(spec.weightBaseG)) {
    if (!entries.some((e) => e.dimension === 'mass' && e.unit === 'g')) {
      entries.push({
        dimension: 'mass',
        value: spec.weightBaseG,
        unit: 'g',
        confidence: conf,
        source: spec.sourceText,
      });
    }
  }
  if (spec.countBase != null && Number.isFinite(spec.countBase)) {
    if (!entries.some((e) => e.dimension === 'count')) {
      entries.push({
        dimension: 'count',
        value: spec.countBase,
        unit: 'count',
        confidence: conf,
        source: spec.sourceText,
      });
    }
  }

  return buildProductAttributes(entries);
}

export function unresolvedReceiptItemIdentityLink(
  overrides: Partial<ReceiptItemIdentityLink> = {}
): ReceiptItemIdentityLink {
  const base: ReceiptItemIdentityLink = {
    merchantProductId: null,
    canonicalProductId: null,
    skuId: null,
    identityLevel: 'unresolved',
    identityConfidence: 0,
    identitySource: 'unknown',
    resolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
  };
  const merged = { ...base, ...overrides };
  merged.identityConfidence = clampIdentityConfidence(merged.identityConfidence);
  return merged;
}

/**
 * Derive a *contract* identity level from today's live ProductIdentity result.
 * Pure / advisory — does not write to DB or mutate enrichment.
 */
export function deriveIdentityLevelFromLegacyProductIdentity(
  identity: Pick<
    ProductIdentity,
    'canonicalProductName' | 'productFamilyKey' | 'specification' | 'identityConfidence'
  >,
  options?: { skuKey?: string | null }
): ProductIdentityLevel {
  const sku = options?.skuKey?.trim();
  if (sku) return 'sku_exact';

  if (identity.canonicalProductName?.trim()) return 'product_exact';

  const family = identity.productFamilyKey;
  if (family) {
    const spec = identity.specification;
    const hasUsableSpec =
      spec &&
      spec.dimension !== 'unknown' &&
      spec.reliability === 'exact' &&
      (spec.volumeBaseMl != null ||
        spec.weightBaseG != null ||
        spec.countBase != null ||
        (spec.sizeValue != null && spec.sizeUnit != null));
    return hasUsableSpec ? 'family_spec' : 'family_only';
  }

  return 'unresolved';
}

export function buildReceiptItemIdentityLinkFromLegacy(
  identity: ProductIdentity,
  options?: { skuKey?: string | null }
): ReceiptItemIdentityLink {
  const level = deriveIdentityLevelFromLegacyProductIdentity(identity, options);
  return {
    merchantProductId: null,
    canonicalProductId: null,
    skuId: options?.skuKey?.trim() || null,
    identityLevel: level,
    identityConfidence: clampIdentityConfidence(identity.identityConfidence),
    identitySource: identity.identitySource,
    resolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
  };
}

export function assertValidReceiptItemIdentityLink(
  link: ReceiptItemIdentityLink
): void {
  if (!isProductIdentityLevel(link.identityLevel)) {
    throw new Error(`Invalid identityLevel: ${String(link.identityLevel)}`);
  }
  const c = link.identityConfidence;
  if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) {
    throw new Error(`identityConfidence out of range: ${String(c)}`);
  }
  if (!link.resolverVersion || typeof link.resolverVersion !== 'string') {
    throw new Error('resolverVersion is required');
  }
}
