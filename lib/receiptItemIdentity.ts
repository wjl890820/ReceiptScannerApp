import {
  resolveProductIdentity,
  type ProductIdentitySource,
} from './productIdentity';
import type { ProductFamilyKey } from './productFamily';
import type { ProductSpecUnit } from './productSpecification';

export type PersistedReceiptItemIdentity = {
  normalized_name?: string;
  normalized_full_name: string;
  canonical_product_name: string | null;
  brand: string | null;
  product_family_key: ProductFamilyKey | null;
  identity_source: ProductIdentitySource;
  identity_confidence: number;
  identity_version: 1;
  spec_size_value: number | null;
  spec_size_unit: ProductSpecUnit | null;
  spec_pack_count: number | null;
  volume_base_ml: number | null;
  weight_base_g: number | null;
  count_base: number | null;
  spec_source_text: string | null;
  spec_confidence: number;
  /** Full raw name evidence used for the parse (additive). */
  spec_raw_text: string | null;
  spec_reliability: 'exact' | 'partial' | 'unknown' | null;
  spec_parser_version: string | null;
};

export type ApplyProductIdentityOptions = {
  finalName?: string | null;
  finalCategory?: string | null;
  merchantName?: string | null;
  /**
   * A brand already returned by a trusted classification output. Callers must
   * omit this after a user rename so stale brand evidence is not retained.
   */
  classificationBrand?: unknown;
  /**
   * Reuse alias/dictionary canonical evidence already present on the item.
   * Safe only when the final item name still represents the classified name.
   */
  useExistingClassificationEvidence?: boolean;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function conservativeIdentityFields(
  classificationBrand: string | null
): PersistedReceiptItemIdentity {
  return {
    normalized_full_name: '',
    canonical_product_name: null,
    brand: classificationBrand,
    product_family_key: null,
    identity_source: 'unknown',
    identity_confidence: 0,
    identity_version: 1,
    spec_size_value: null,
    spec_size_unit: null,
    spec_pack_count: null,
    volume_base_ml: null,
    weight_base_g: null,
    count_base: null,
    spec_source_text: null,
    spec_confidence: 0,
    spec_raw_text: null,
    spec_reliability: null,
    spec_parser_version: null,
  };
}

/**
 * Add deterministic Product Identity annotations to a receipt item.
 *
 * This adapter is intentionally pure: no DB/network calls and no mutation of
 * the input item. Category is evidence only and is never overwritten.
 */
export function applyProductIdentityToItem<T extends Record<string, unknown>>(
  item: T,
  options: ApplyProductIdentityOptions = {}
): T & PersistedReceiptItemIdentity {
  const classificationBrand = nonEmptyString(options.classificationBrand);

  try {
    const finalName =
      nonEmptyString(options.finalName) ?? nonEmptyString(item.name) ?? '';
    const finalCategory =
      nonEmptyString(options.finalCategory) ?? nonEmptyString(item.category);

    const classificationSource = nonEmptyString(item.classification_source);
    const mayReuseClassificationEvidence =
      options.useExistingClassificationEvidence === true &&
      (classificationSource === 'alias' || classificationSource === 'dictionary');
    const canonicalEvidence = mayReuseClassificationEvidence
      ? nonEmptyString(item.canonical_name)
      : null;
    const evidenceSource =
      canonicalEvidence && classificationSource === 'alias'
        ? 'merchant_alias'
        : canonicalEvidence && classificationSource === 'dictionary'
          ? 'dictionary'
          : undefined;

    const identity = resolveProductIdentity({
      rawName: finalName,
      category: finalCategory,
      merchantName: options.merchantName,
      canonicalProductNameEvidence: canonicalEvidence,
      evidenceSource,
    });
    const spec = identity.specification;

    return {
      ...item,
      // Legacy key: recomputed only through the unchanged legacy normalizer.
      normalized_name: identity.normalizedName,
      normalized_full_name: identity.normalizedFullName,
      canonical_product_name: identity.canonicalProductName,
      brand: classificationBrand ?? identity.brand,
      product_family_key: identity.productFamilyKey,
      identity_source: identity.identitySource,
      identity_confidence: identity.identityConfidence,
      identity_version: identity.identityVersion,
      spec_size_value: spec.sizeValue,
      spec_size_unit: spec.sizeUnit,
      spec_pack_count: spec.packCount,
      volume_base_ml: spec.volumeBaseMl,
      weight_base_g: spec.weightBaseG,
      count_base: spec.countBase,
      spec_source_text: spec.sourceText,
      spec_confidence: spec.confidence,
      spec_raw_text: spec.rawText,
      spec_reliability: spec.reliability,
      spec_parser_version: spec.parserVersion,
    };
  } catch {
    return {
      ...item,
      ...conservativeIdentityFields(classificationBrand),
    };
  }
}
