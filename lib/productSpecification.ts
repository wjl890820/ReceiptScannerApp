/**
 * MERUNO product specification contract (M1-B).
 *
 * Distinguishes:
 * - purchase_quantity (sale-line units purchased; owned by receipt/index layer)
 * - per-pack content (sizeValue + sizeUnit)
 * - packCount (internal units inside one sale unit)
 * - total packaged content for one sale unit (volumeBaseMl / weightBaseG / countBase)
 *
 * Raw evidence is preserved. Unknown beats fabricated precision.
 */

export const SPEC_PARSER_VERSION = 'meruno-spec-parser-v1' as const;

/** Historical derived rows with no stamped parser version. */
export const LEGACY_SPEC_PARSER_VERSION = 'legacy_unknown' as const;

export type ProductSpecDimension = 'volume' | 'weight' | 'count' | 'unknown';

export type ProductSpecUnit = 'ml' | 'l' | 'g' | 'kg' | 'count';

/** Deterministic comparison safety (not a confidence score). */
export type ProductSpecReliability = 'exact' | 'partial' | 'unknown';

/**
 * Spec result for one sale unit (one purchase-unit of the product).
 *
 * purchase_quantity is intentionally NOT part of this object — it lives on the
 * receipt line and must never be conflated with packCount.
 */
export type ProductSpecification = {
  /** Full raw input retained for re-parse / audit. */
  rawText: string | null;
  /** Matched evidence fragment when a pattern hit; otherwise null. */
  sourceText: string | null;
  dimension: ProductSpecDimension;
  /** Per-pack content value (e.g. 500 in 500ml×6). */
  sizeValue: number | null;
  sizeUnit: ProductSpecUnit | null;
  /** Internal pack multiplicity inside one sale unit (e.g. 6 in 500ml×6). */
  packCount: number | null;
  /** Total volume for one sale unit (ml). */
  volumeBaseMl: number | null;
  /** Total weight for one sale unit (g). */
  weightBaseG: number | null;
  /** Total count for one sale unit. */
  countBase: number | null;
  reliability: ProductSpecReliability;
  parserVersion: string;
  /**
   * Legacy numeric confidence kept for existing callers.
   * Prefer `reliability` for comparison gates.
   */
  confidence: number;
};

const UNKNOWN_SPECIFICATION: ProductSpecification = {
  rawText: null,
  sourceText: null,
  dimension: 'unknown',
  sizeValue: null,
  sizeUnit: null,
  packCount: null,
  volumeBaseMl: null,
  weightBaseG: null,
  countBase: null,
  reliability: 'unknown',
  parserVersion: SPEC_PARSER_VERSION,
  confidence: 0,
};

const MAX_SINGLE_VOLUME_ML = 20_000;
const MAX_SINGLE_WEIGHT_G = 100_000;
const MAX_PACK_COUNT = 1_000;

/**
 * Identity-only text normalization.
 *
 * Unlike normalizeProductName(), this deliberately preserves specifications
 * and model numbers. Existing classification/learning keys must not use it.
 */
export function normalizeIdentityText(rawText: string): string {
  if (typeof rawText !== 'string' || !rawText.trim()) return '';

  let normalized = rawText.normalize('NFKC').trim();
  normalized = normalized.replace(/\s+/g, ' ');
  // Normalize multiplication markers only in numeric/multipack contexts.
  normalized = normalized.replace(
    /(\d+(?:\.\d+)?\s*(?:ml|l|g|kg))\s*[×xX*]\s*(?=\d)/gi,
    '$1×'
  );
  normalized = normalized.replace(/(\d)\s*[×xX*]\s*(?=\d)/g, '$1×');
  // Units and Latin brand text are case-insensitive in identity matching.
  return normalized.toLowerCase();
}

function unknownSpecification(rawText: string | null = null, sourceText: string | null = null): ProductSpecification {
  return {
    ...UNKNOWN_SPECIFICATION,
    rawText,
    sourceText,
  };
}

function dimensionForUnit(unit: ProductSpecUnit): Exclude<ProductSpecDimension, 'unknown'> {
  if (unit === 'ml' || unit === 'l') return 'volume';
  if (unit === 'g' || unit === 'kg') return 'weight';
  return 'count';
}

function isValidPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function confidenceForReliability(reliability: ProductSpecReliability): number {
  if (reliability === 'exact') return 0.99;
  if (reliability === 'partial') return 0.7;
  return 0;
}

function buildMeasuredSpecification(
  rawText: string,
  sizeValue: number,
  sizeUnit: Exclude<ProductSpecUnit, 'count'>,
  packCount: number,
  sourceText: string,
  reliability: ProductSpecReliability = 'exact'
): ProductSpecification {
  if (
    !isValidPositive(sizeValue) ||
    !Number.isInteger(packCount) ||
    packCount < 1 ||
    packCount > MAX_PACK_COUNT
  ) {
    return unknownSpecification(rawText, sourceText);
  }

  const dimension = dimensionForUnit(sizeUnit);
  const singleBase =
    sizeUnit === 'l'
      ? sizeValue * 1_000
      : sizeUnit === 'kg'
        ? sizeValue * 1_000
        : sizeValue;

  if (
    (dimension === 'volume' && singleBase > MAX_SINGLE_VOLUME_ML) ||
    (dimension === 'weight' && singleBase > MAX_SINGLE_WEIGHT_G)
  ) {
    return unknownSpecification(rawText, sourceText);
  }

  return {
    rawText,
    sourceText,
    dimension,
    sizeValue,
    sizeUnit,
    packCount,
    volumeBaseMl: dimension === 'volume' ? singleBase * packCount : null,
    weightBaseG: dimension === 'weight' ? singleBase * packCount : null,
    countBase: null,
    reliability,
    parserVersion: SPEC_PARSER_VERSION,
    confidence: confidenceForReliability(reliability),
  };
}

function buildCountSpecification(
  rawText: string,
  perPackCount: number,
  packCount: number,
  sourceText: string,
  reliability: ProductSpecReliability = 'exact'
): ProductSpecification {
  if (
    !Number.isInteger(perPackCount) ||
    !Number.isInteger(packCount) ||
    perPackCount < 1 ||
    packCount < 1 ||
    perPackCount > MAX_PACK_COUNT ||
    packCount > MAX_PACK_COUNT
  ) {
    return unknownSpecification(rawText, sourceText);
  }

  return {
    rawText,
    sourceText,
    dimension: 'count',
    sizeValue: perPackCount,
    sizeUnit: 'count',
    packCount,
    volumeBaseMl: null,
    weightBaseG: null,
    countBase: perPackCount * packCount,
    reliability,
    parserVersion: SPEC_PARSER_VERSION,
    confidence: confidenceForReliability(reliability),
  };
}

/** True when the spec is safe for family-level unit-price normalization. */
export function isReliableComparableSpec(spec: ProductSpecification): boolean {
  if (spec.reliability !== 'exact' || spec.dimension === 'unknown') return false;
  if (spec.dimension === 'volume') return isValidPositive(spec.volumeBaseMl ?? NaN);
  if (spec.dimension === 'weight') return isValidPositive(spec.weightBaseG ?? NaN);
  if (spec.dimension === 'count') return isValidPositive(spec.countBase ?? NaN);
  return false;
}

/**
 * Parse a specification from the raw product name.
 *
 * Only explicit physical units (or safe countable markers 個/枚/pc) are accepted.
 * Packaging vocabulary alone (本/袋/パック/箱/ケース/入) remains unknown.
 */
export function parseProductSpecification(rawName: string): ProductSpecification {
  const rawText = typeof rawName === 'string' ? rawName : '';
  const text = normalizeIdentityText(rawText);
  if (!text) return unknownSpecification(rawText || null);

  // 1) content × pack  (500ml×6 / 500ml x 6 / 500ml*6)
  const contentPack = text.match(
    /(\d+(?:\.\d+)?)\s*(ml|l|g|kg)\s*×\s*(\d+)\s*(?:本|個|枚|袋|パック)?(?:入)?/i
  );
  if (contentPack) {
    return buildMeasuredSpecification(
      rawText,
      Number(contentPack[1]),
      contentPack[2].toLowerCase() as Exclude<ProductSpecUnit, 'count'>,
      Number(contentPack[3]),
      contentPack[0]
    );
  }

  // 2) pack × content  (6×500ml / 6 x 500ml)
  const packContent = text.match(
    /(\d+)\s*×\s*(\d+(?:\.\d+)?)\s*(ml|l|g|kg)(?:\s*(?:本|個|枚|袋|パック)?(?:入)?)?/i
  );
  if (packContent) {
    return buildMeasuredSpecification(
      rawText,
      Number(packContent[2]),
      packContent[3].toLowerCase() as Exclude<ProductSpecUnit, 'count'>,
      Number(packContent[1]),
      packContent[0]
    );
  }

  // 3) count × pack  (10個×2)
  const countPack = text.match(/(\d+)\s*(個|枚|pc|pcs)\s*×\s*(\d+)/i);
  if (countPack) {
    return buildCountSpecification(
      rawText,
      Number(countPack[1]),
      Number(countPack[3]),
      countPack[0]
    );
  }

  // 4) pack × count  (2×10個)
  const packCountOnly = text.match(/(\d+)\s*×\s*(\d+)\s*(個|枚|pc|pcs)/i);
  if (packCountOnly) {
    return buildCountSpecification(
      rawText,
      Number(packCountOnly[2]),
      Number(packCountOnly[1]),
      packCountOnly[0]
    );
  }

  // 5) Ambiguous packaging multipacks — keep evidence, do not invent dimension.
  const ambiguousMultipack = text.match(
    /(\d+)\s*(?:本|袋|パック|箱|ケース|p)\s*×\s*(\d+)|(\d+)\s*×\s*(\d+)\s*(?:本|袋|パック|箱|ケース)|ケース\s*(\d+)|(\d+)\s*p\b|(\d+)\s*入/i
  );
  if (ambiguousMultipack) {
    return unknownSpecification(rawText, ambiguousMultipack[0]);
  }

  // 6) Simple measured content
  const measured = text.match(/(\d+(?:\.\d+)?)\s*(ml|l|g|kg)/i);
  if (measured) {
    return buildMeasuredSpecification(
      rawText,
      Number(measured[1]),
      measured[2].toLowerCase() as Exclude<ProductSpecUnit, 'count'>,
      1,
      measured[0]
    );
  }

  // 7) Safe countable markers only (個/枚/pc). Packaging words alone are unknown.
  const count = text.match(/(\d+)\s*(個|枚|pc|pcs|pk|pack)\s*(?:入)?/i);
  if (count) {
    return buildCountSpecification(rawText, Number(count[1]), 1, count[0]);
  }

  // 8) Packaging vocabulary without physical content → unknown
  const packagingOnly = text.match(/(\d+)\s*(?:本|袋|パック|箱|ケース)\s*(?:入)?/i);
  if (packagingOnly) {
    return unknownSpecification(rawText, packagingOnly[0]);
  }

  return unknownSpecification(rawText);
}
