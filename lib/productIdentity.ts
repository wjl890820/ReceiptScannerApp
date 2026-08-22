import { normalizeReceiptItemName } from './productNormalizer';
import {
  resolveProductFamily,
  type ProductFamilyKey,
  type ProductFamilyResult,
} from './productFamily';
import {
  normalizeIdentityText,
  parseProductSpecification,
  type ProductSpecification,
} from './productSpecification';

export type ProductIdentitySource =
  | 'user_confirmed'
  | 'merchant_alias'
  | 'dictionary'
  | 'high_confidence_rule'
  | 'legacy_fallback'
  | 'unknown';

export type ProductIdentity = {
  rawName: string;
  /** Existing classification/learning key; its legacy semantics are unchanged. */
  normalizedName: string;
  /** Identity-only normalized text that retains specification tokens. */
  normalizedFullName: string;
  canonicalProductName: string | null;
  brand: string | null;
  productFamilyKey: ProductFamilyKey | null;
  specification: ProductSpecification;
  identitySource: ProductIdentitySource;
  identityConfidence: number;
  identityVersion: 1;
};

export type ResolveProductIdentityInput = {
  rawName: string;
  category?: string | null;
  merchantName?: string | null;
  canonicalProductNameEvidence?: string | null;
  brandEvidence?: string | null;
  evidenceSource?: Extract<
    ProductIdentitySource,
    'user_confirmed' | 'merchant_alias' | 'dictionary'
  >;
};

type CanonicalRuleResult = {
  canonicalProductName: string;
  brand: string | null;
  confidence: number;
};

function resolveCanonicalRule(normalizedFullName: string): CanonicalRuleResult | null {
  if (
    normalizedFullName.includes('明治') &&
    /(?:おいしい|オイシイ)牛乳/.test(normalizedFullName)
  ) {
    return {
      canonicalProductName: '明治 おいしい牛乳',
      brand: '明治',
      confidence: 0.99,
    };
  }

  if (
    normalizedFullName.includes('メグミルク') &&
    normalizedFullName.includes('雪印')
  ) {
    return {
      canonicalProductName: '雪印 メグミルク',
      brand: '雪印メグミルク',
      confidence: 0.99,
    };
  }

  if (
    /(?:topvalu|トップバリュ)/.test(normalizedFullName) &&
    normalizedFullName.includes('牛乳')
  ) {
    return {
      canonicalProductName: 'TOPVALU 牛乳',
      brand: 'TOPVALU',
      confidence: 0.99,
    };
  }

  return null;
}

function resolveHighConfidenceBrand(normalizedFullName: string): string | null {
  if (normalizedFullName.includes('明治')) return '明治';
  if (normalizedFullName.includes('雪印メグミルク')) return '雪印メグミルク';
  if (normalizedFullName.includes('雪印')) return '雪印';
  if (/(?:topvalu|トップバリュ)/.test(normalizedFullName)) return 'TOPVALU';
  if (/(?:^|[\s・])boss(?=$|[\s・\d])/.test(normalizedFullName)) return 'BOSS';
  return null;
}

/**
 * Whether a parsed package specification is safe for family-level unit-price
 * normalization. A false result does not erase the syntactic spec candidate.
 */
export function isSpecificationCompatibleWithFamily(
  specification: ProductSpecification,
  family: ProductFamilyKey | null
): boolean {
  if (!family || specification.dimension === 'unknown') return false;
  if (specification.reliability !== 'exact') return false;

  if (
    family === 'milk' ||
    family === 'water' ||
    family === 'cola' ||
    family === 'tea' ||
    family === 'coffee'
  ) {
    return specification.dimension === 'volume';
  }

  if (family === 'eggs') {
    return specification.dimension === 'count';
  }

  // Tofu/yogurt and remaining families need more product-specific evidence
  // before Phase 3 can safely compare normalized prices.
  return false;
}

export function resolveProductIdentity(input: ResolveProductIdentityInput): ProductIdentity {
  const rawName = typeof input.rawName === 'string' ? input.rawName : '';
  const normalizedName = normalizeReceiptItemName(rawName).normalized_name;
  const normalizedFullName = normalizeIdentityText(rawName);
  const specification = parseProductSpecification(rawName);

  const trustedCanonical =
    input.evidenceSource && input.canonicalProductNameEvidence?.trim()
      ? input.canonicalProductNameEvidence.trim()
      : null;
  const canonicalRule = trustedCanonical ? null : resolveCanonicalRule(normalizedFullName);
  const canonicalProductName =
    trustedCanonical ?? canonicalRule?.canonicalProductName ?? null;
  const brand =
    (input.evidenceSource && input.brandEvidence?.trim()
      ? input.brandEvidence.trim()
      : null) ??
    canonicalRule?.brand ??
    resolveHighConfidenceBrand(normalizedFullName);

  const familyResult: ProductFamilyResult = resolveProductFamily({
    rawName,
    normalizedFullName,
    canonicalProductName,
    category: input.category,
    brand,
    merchantName: input.merchantName,
  });

  let identitySource: ProductIdentitySource;
  let identityConfidence: number;
  if (trustedCanonical && input.evidenceSource) {
    identitySource = input.evidenceSource;
    identityConfidence = 1;
  } else if (canonicalRule) {
    identitySource = 'high_confidence_rule';
    identityConfidence = canonicalRule.confidence;
  } else if (normalizedName) {
    identitySource = 'legacy_fallback';
    identityConfidence = Math.min(
      0.65,
      Math.max(familyResult.confidence * 0.6, specification.confidence * 0.5, 0.35)
    );
  } else {
    identitySource = 'unknown';
    identityConfidence = 0;
  }

  return {
    rawName,
    normalizedName,
    normalizedFullName,
    canonicalProductName,
    brand,
    productFamilyKey: familyResult.family,
    specification,
    identitySource,
    identityConfidence,
    identityVersion: 1,
  };
}

/**
 * Build a stable SKU key only from a trusted canonical product and a validated
 * family-compatible specification. Legacy normalized names never become SKUs.
 *
 * This is the single authoritative exact-product identity for V1:
 * receipt_items.sku_key persistence, Product Detail `type: 'sku'`,
 * SKU purchase-unit price history, frequent-product SKU fallback, and
 * Analysis D identityCoverage.withSku all reuse this function (or its
 * persisted output). Do not invent a parallel key.
 */
export function buildSkuKey(identity: ProductIdentity): string | null {
  const canonical = identity.canonicalProductName?.trim();
  const spec = identity.specification;
  if (
    !canonical ||
    !isSpecificationCompatibleWithFamily(spec, identity.productFamilyKey) ||
    spec.packCount == null
  ) {
    return null;
  }

  const canonicalKey = normalizeIdentityText(canonical);
  if (!canonicalKey) return null;

  if (spec.dimension === 'volume' && spec.volumeBaseMl != null) {
    const singleMl = spec.volumeBaseMl / spec.packCount;
    return `v1|${canonicalKey}|volume:${singleMl}ml|pack:${spec.packCount}`;
  }
  if (spec.dimension === 'weight' && spec.weightBaseG != null) {
    const singleG = spec.weightBaseG / spec.packCount;
    return `v1|${canonicalKey}|weight:${singleG}g|pack:${spec.packCount}`;
  }
  if (spec.dimension === 'count' && spec.countBase != null) {
    return `v1|${canonicalKey}|count:${spec.countBase}|pack:${spec.packCount}`;
  }
  return null;
}

/** Alias for call sites that need the exact-product identity contract by name. */
export const resolveExactProductSkuKey = buildSkuKey;

export type SkuPurchaseUnitPriceRow = {
  skuKey?: string | null;
  lineTotal?: number | null;
  purchaseQuantity?: number | null;
};

/** Persisted / derived sku_key present (output of buildSkuKey). */
export function hasPersistedSkuIdentity(
  row: Pick<SkuPurchaseUnitPriceRow, 'skuKey'>
): boolean {
  return Boolean(row.skuKey?.trim());
}

/** Purchase-unit price can be computed (lineTotal / purchaseQuantity). */
export function isPurchaseUnitPriceUsable(
  row: Pick<SkuPurchaseUnitPriceRow, 'lineTotal' | 'purchaseQuantity'>
): boolean {
  return (
    typeof row.lineTotal === 'number' &&
    row.lineTotal > 0 &&
    typeof row.purchaseQuantity === 'number' &&
    row.purchaseQuantity > 0
  );
}

/**
 * Row can participate in SKU-typed purchase-unit price history:
 * requires exact-product sku identity AND usable purchase-unit amounts.
 * Purchase-unit alone is NOT SKU identity.
 */
export function isSkuPurchaseUnitPriceHistoryUsable(
  row: SkuPurchaseUnitPriceRow
): boolean {
  return hasPersistedSkuIdentity(row) && isPurchaseUnitPriceUsable(row);
}
