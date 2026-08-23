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
