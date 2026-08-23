/**
 * Universal product text normalizer (Product Identity Batch 2).
 *
 * Conservative display normalization + slightly more aggressive comparisonKey.
 * Does NOT strip brand / flavor / variant tokens (無糖, EX, レモン, …).
 * Does NOT remove structural specs from `normalized` (unlike classify-oriented
 * `normalizeProductName` in productNormalizer.ts).
 *
 * Pure / deterministic / offline. No Gemini / network.
 */

export const UNIVERSAL_PRODUCT_NORMALIZER_VERSION =
  'meruno-universal-product-normalizer-v1' as const;

export type NormalizedProductText = {
  raw: string;
  /** Conservative text for display / further parsing (specs retained). */
  normalized: string;
  /** Matching key: lowercased, punctuation-light, specs retained. */
  comparisonKey: string;
  tokens: string[];
};

const MULTIPLY_MARKERS = /[×✕ｘＸxX＊*]/g;

/** Full-width ASCII / digits → half-width (NFKC covers most; keep explicit). */
function toHalfWidthAscii(input: string): string {
  return input.replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

function collapseWhitespace(input: string): string {
  return input
    .replace(/[\t\n\r\f\v]+/g, ' ')
    .replace(/[\u00A0\u3000]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function normalizeMultiplyMarkers(input: string): string {
  // Only normalize multiply-like markers between numeric contexts later in parser;
  // here unify marker glyphs globally to `×` when adjacent to digits.
  return input.replace(
    /(\d(?:\.\d+)?)\s*[×✕ｘＸxX＊*]\s*(?=\d)/g,
    '$1×'
  );
}

function stripNoiseSeparators(input: string): string {
  // Decorative separators that rarely carry identity (keep ・ for Japanese compounds).
  return input
    .replace(/[|｜/／\\]+/g, ' ')
    .replace(/[~～〜]+/g, ' ')
    .replace(/[『』「」【】〔〕]/g, ' ')
    .replace(/[()（）\[\]{}]/g, ' ');
}

function collapsePunctuation(input: string): string {
  return input
    .replace(/([.,。、!！?？])\1+/g, '$1')
    .replace(/[-−–—_]{2,}/g, '-');
}

/**
 * Normalize product OCR text without destroying distinguishing tokens.
 */
export function normalizeProductText(raw: string): NormalizedProductText {
  const rawSafe = typeof raw === 'string' ? raw : '';
  if (!rawSafe.trim()) {
    return { raw: rawSafe, normalized: '', comparisonKey: '', tokens: [] };
  }

  let normalized = rawSafe.normalize('NFKC');
  normalized = toHalfWidthAscii(normalized);
  normalized = collapseWhitespace(normalized);
  normalized = stripNoiseSeparators(normalized);
  normalized = collapsePunctuation(normalized);
  normalized = normalizeMultiplyMarkers(normalized);
  normalized = collapseWhitespace(normalized);

  // Unit letter case only (do not lowercase Japanese / brand-significant Latin
  // beyond a dedicated comparison key).
  normalized = normalized.replace(
    /(\d+(?:\.\d+)?)\s*(ml|ｍｌ|l|ｌ|g|ｇ|kg|ｋｇ|cm|ｃｍ|m|ｍ|mm|ｍｍ)\b/gi,
    (_, num: string, unit: string) => `${num}${unit.toLowerCase()}`
  );

  const comparisonKey = normalized
    .toLowerCase()
    .replace(/[・･]/g, '')
    .replace(/[\s]+/g, '')
    .replace(/['"`´’“”]/g, '');

  const tokens = normalized
    .split(/[\s・、,，]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  return {
    raw: rawSafe,
    normalized,
    comparisonKey,
    tokens,
  };
}

/** Exported for parser: apply the same pre-clean before regex. */
export function prepareProductTextForParsing(raw: string): string {
  return normalizeProductText(raw).normalized;
}
