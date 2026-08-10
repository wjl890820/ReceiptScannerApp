export type ProductSpecDimension = 'volume' | 'weight' | 'count' | 'unknown';

export type ProductSpecUnit = 'ml' | 'l' | 'g' | 'kg' | 'count';

export type ProductSpecification = {
  dimension: ProductSpecDimension;
  sizeValue: number | null;
  sizeUnit: ProductSpecUnit | null;
  /** Number of internal units in one purchase unit. */
  packCount: number | null;
  /** Total volume represented by one purchase unit. */
  volumeBaseMl: number | null;
  /** Total weight represented by one purchase unit. */
  weightBaseG: number | null;
  /** Total count represented by one purchase unit. */
  countBase: number | null;
  sourceText: string | null;
  confidence: number;
};

const UNKNOWN_SPECIFICATION: ProductSpecification = {
  dimension: 'unknown',
  sizeValue: null,
  sizeUnit: null,
  packCount: null,
  volumeBaseMl: null,
  weightBaseG: null,
  countBase: null,
  sourceText: null,
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
    /(\d+(?:\.\d+)?\s*(?:ml|l|g|kg))\s*[×xX]\s*(?=\d)/gi,
    '$1×'
  );
  normalized = normalized.replace(/(\d)\s*[×xX]\s*(?=\d)/g, '$1×');
  // Units and Latin brand text are case-insensitive in identity matching.
  return normalized.toLowerCase();
}

function unknownSpecification(): ProductSpecification {
  return { ...UNKNOWN_SPECIFICATION };
}

function dimensionForUnit(unit: ProductSpecUnit): Exclude<ProductSpecDimension, 'unknown'> {
  if (unit === 'ml' || unit === 'l') return 'volume';
  if (unit === 'g' || unit === 'kg') return 'weight';
  return 'count';
}

function isValidPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function buildMeasuredSpecification(
  sizeValue: number,
  sizeUnit: Exclude<ProductSpecUnit, 'count'>,
  packCount: number,
  sourceText: string,
  confidence: number
): ProductSpecification {
  if (
    !isValidPositive(sizeValue) ||
    !Number.isInteger(packCount) ||
    packCount < 1 ||
    packCount > MAX_PACK_COUNT
  ) {
    return unknownSpecification();
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
    return unknownSpecification();
  }

  return {
    dimension,
    sizeValue,
    sizeUnit,
    packCount,
    volumeBaseMl: dimension === 'volume' ? singleBase * packCount : null,
    weightBaseG: dimension === 'weight' ? singleBase * packCount : null,
    countBase: null,
    sourceText,
    confidence,
  };
}

/**
 * Parse a specification from the raw product name.
 *
 * Only explicit units are accepted. Unitless numbers, product model numbers,
 * years, JAN/EAN values, and store item numbers remain unknown.
 */
export function parseProductSpecification(rawName: string): ProductSpecification {
  const text = normalizeIdentityText(rawName);
  if (!text) return unknownSpecification();

  // Multipack must be resolved before count-only patterns: in 500ml×6本,
  // "6本" describes the number of internal bottles, not a count dimension.
  const multipack = text.match(
    /(\d+(?:\.\d+)?)\s*(ml|l|g|kg)\s*×\s*(\d+)\s*(?:本|個|枚|袋|パック)?(?:入)?/i
  );
  if (multipack) {
    return buildMeasuredSpecification(
      Number(multipack[1]),
      multipack[2].toLowerCase() as Exclude<ProductSpecUnit, 'count'>,
      Number(multipack[3]),
      multipack[0],
      0.99
    );
  }

  const measured = text.match(/(\d+(?:\.\d+)?)\s*(ml|l|g|kg)/i);
  if (measured) {
    return buildMeasuredSpecification(
      Number(measured[1]),
      measured[2].toLowerCase() as Exclude<ProductSpecUnit, 'count'>,
      1,
      measured[0],
      0.98
    );
  }

  const count = text.match(/(\d+)\s*(個|本|枚|袋|パック)\s*(?:入)?/);
  if (count) {
    const countValue = Number(count[1]);
    if (!Number.isInteger(countValue) || countValue < 1 || countValue > MAX_PACK_COUNT) {
      return unknownSpecification();
    }
    return {
      dimension: 'count',
      sizeValue: countValue,
      sizeUnit: 'count',
      packCount: 1,
      volumeBaseMl: null,
      weightBaseG: null,
      countBase: countValue,
      sourceText: count[0],
      confidence: 0.94,
    };
  }

  return unknownSpecification();
}
