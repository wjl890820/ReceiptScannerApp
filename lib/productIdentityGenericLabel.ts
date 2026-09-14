/**
 * Shared generic family-label detection for ProductIdentity + PPH.
 * Single word-list / morphology — do not duplicate elsewhere.
 */

import type { ProductAttributes } from './productIdentityContract';
import { resolveProductIdentity } from './productIdentity';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';

/**
 * Conservative receipt-decoration strip before generic-family evaluation.
 * Shared by resolver classification and PPH identity-trust (read-time).
 *
 * Strips only proven receipt metadata / markers — not brands, sizes, or
 * product-identifying parentheticals.
 */
export function canonicalizeReceiptDecorationForIdentity(name: string): string {
  let s = String(name || '')
    .normalize('NFKC')
    .replace(/[\u00A0\u3000]/g, ' ')
    .trim();
  if (!s) return '';

  // Tax / settlement markers commonly glued to commodity lines.
  s = s.replace(/[（(]\s*税(?:込|抜)?\s*[）)]/gi, '');
  // Residual lone 税 token after paren→space normalization (not 消費税 etc.).
  s = s.replace(/(^|[\s])税(?:込|抜)?(?=$|[\s])/g, '$1');
  // Reference / attention marks.
  s = s.replace(/※/g, '');
  // Trailing receipt asterisks (not mid-string multiply × between digits).
  s = s.replace(/[*＊]+\s*$/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Pure commodity / opaque family labels (with or without familyKey).
 * Keep this list evidence-driven; do not expand speculatively.
 */
export function isGenericFamilyLabel(
  normalizedName: string,
  familyKey: string | null
): boolean {
  const decorated = canonicalizeReceiptDecorationForIdentity(normalizedName);
  const stripped = decorated
    .replace(
      /\d+(?:\.\d+)?\s*(?:ml|l|g|kg|個|本|枚|袋|箱|缶|ロール|m|cm|mm)/gi,
      ''
    )
    .replace(/\s+/g, '')
    .trim();
  if (!stripped) return false;
  // Pure commodity labels (with or without familyKey from legacy resolver).
  if (/^(牛乳|ミルク|低脂肪乳|成分無調整牛乳|卵|たまご|米|水|お茶|パン|豆腐)$/.test(stripped)) {
    return true;
  }
  if (!familyKey) return false;
  if (stripped.length > 10) return false;
  return /(牛乳|ミルク|卵|たまご|米|水|お茶|パン|豆腐)/.test(stripped);
}

export function hasIdentitySpecAttributes(
  attributes: ProductAttributes | null | undefined
): boolean {
  if (!attributes?.entries?.length) return false;
  return attributes.entries.some((e) =>
    ['volume', 'mass', 'count', 'length', 'roll_count'].includes(String(e.dimension))
  );
}

export type GenericWeakIdentityClassification = {
  level: 'family_spec' | 'family_only';
  source: 'family_spec' | 'family_only';
  confidence: number;
  reason: 'family_spec_generic' | 'family_only_generic';
};

/**
 * When the comparison key remains a generic family label without stronger
 * distinguishing evidence, identity must stay weak — including exact rematch.
 */
export function classifyGenericWeakIdentity(
  normalizedName: string,
  familyKey: string | null,
  attributes: ProductAttributes | null | undefined
): GenericWeakIdentityClassification | null {
  if (!isGenericFamilyLabel(normalizedName, familyKey)) return null;
  const hasSpec = hasIdentitySpecAttributes(attributes);
  if (hasSpec) {
    return {
      level: 'family_spec',
      source: 'family_spec',
      confidence: 0.55,
      reason: 'family_spec_generic',
    };
  }
  return {
    level: 'family_only',
    source: 'family_only',
    confidence: 0.35,
    reason: 'family_only_generic',
  };
}

/**
 * Merchant-product bucket membership ≠ price comparability.
 *
 * `nameForIdentityTrust` is the text used for morphology (often PPH display /
 * normalized full name projected from the receipt row — not necessarily OCR raw).
 *
 * family_only and family_spec never qualify for same_merchant_product history.
 * Morphological re-check catches historically laundered strong metadata.
 */
export function isMerchantProductIdentityPriceComparable(input: {
  /** @deprecated alias — prefer nameForIdentityTrust */
  rawName?: string | null;
  nameForIdentityTrust?: string | null;
  identityLevel?: string | null;
  identitySource?: string | null;
}): boolean {
  const level = input.identityLevel ?? null;
  const source = input.identitySource ?? null;

  if (
    level === 'unresolved' ||
    level === 'family_only' ||
    level === 'family_spec'
  ) {
    return false;
  }
  if (
    source === 'unresolved' ||
    source === 'family_only' ||
    source === 'family_spec'
  ) {
    return false;
  }

  const name = String(
    input.nameForIdentityTrust ?? input.rawName ?? ''
  ).trim();
  if (name) {
    const norm = normalizeProductForIdentity(name);
    const legacy = resolveProductIdentity({ rawName: name });
    const weak = classifyGenericWeakIdentity(
      norm.normalizedName,
      legacy.productFamilyKey,
      norm.attributes
    );
    // Any family-level morphology (with or without spec) is not MP-comparable.
    if (weak) return false;
  }

  return true;
}
