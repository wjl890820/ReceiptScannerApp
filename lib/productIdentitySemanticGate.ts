/**
 * Product Identity Batch 4.1 — semantic sufficiency gate (cost calibration).
 *
 * Core rule: new MerchantProduct ≠ needs AI.
 * Missing brand / canonicalName / productType / attributes alone never trigger AI.
 *
 * V1 semantic sufficient =
 *   stable identity (normalized/comparison) + trustworthy category/semantics.
 * Gemini only for opaque / abbreviated / uncategorized-ambiguous long-tail names.
 */

import type { ProductAttributes } from './productIdentityContract';
import { buildIdentityNameStem } from './productIdentityNameStem';

export const PRODUCT_IDENTITY_SEMANTIC_VERSION =
  'meruno-product-identity-semantic-v1.1' as const;

export type SemanticStatus =
  | 'sufficient'
  | 'partial'
  | 'needs_enrichment'
  | 'enriched'
  | 'failed';

export type NameInformativeness = 'informative' | 'ambiguous' | 'opaque';

export type SemanticGateInput = {
  rawName: string;
  normalizedName?: string | null;
  comparisonKey?: string | null;
  merchantKey?: string | null;
  existingMerchantProductMatch?: boolean;
  createdMerchantProduct?: boolean;
  brand?: string | null;
  category?: string | null;
  categoryConfidence?: number | null;
  /** Optional local classifier source for diagnostics. */
  categorySource?: string | null;
  attributes?: ProductAttributes | null;
  cachedSemanticStatus?: SemanticStatus | null;
  identityLevel?: string | null;
  identityConfidence?: number | null;
};

export type SemanticGateResult = {
  status: SemanticStatus;
  needsEnrichment: boolean;
  reasons: string[];
  nameInformativeness: NameInformativeness;
  categoryStrong: boolean;
};

/** High-trust local / dictionary / rule category. */
export const SEMANTIC_CATEGORY_STRONG_THRESHOLD = 0.75;
/** Below this, treat category as weak even if non-uncategorized. */
export const SEMANTIC_CATEGORY_WEAK_THRESHOLD = 0.5;

const ABBREV_OR_CODE_RE =
  /(?:^[A-Z0-9]{1,4}\s)|(?:\bTV\b)|(?:\bBP\b)|(?:\bPB\b)|(?:トップバリュ)|(?:TOPVALU)|(?:不明)|(?:\bMLK\b)|(?:午後T)|(?:午後の?T\b)/i;

function hasKanjiOrKana(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

function isWeakCategory(
  category: string | null | undefined,
  confidence: number | null | undefined
): boolean {
  const c = (category || '').trim().toLowerCase();
  if (!c || c === 'uncategorized' || c === 'unknown') return true;
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    if (confidence < SEMANTIC_CATEGORY_WEAK_THRESHOLD) return true;
  }
  return false;
}

function isStrongCategory(
  category: string | null | undefined,
  confidence: number | null | undefined
): boolean {
  const c = (category || '').trim().toLowerCase();
  if (!c || c === 'uncategorized' || c === 'unknown' || c === 'other') return false;
  const conf =
    typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0;
  return conf >= SEMANTIC_CATEGORY_STRONG_THRESHOLD;
}

/**
 * Lexical quality of a receipt name — generic, not product-type-specific.
 * Short Japanese commodities (卵/米/茶/水) are informative when category is strong
 * (caller combines this with categoryStrong).
 */
export function assessNameInformativeness(
  rawName: string,
  normalizedName?: string | null
): NameInformativeness {
  const raw = (rawName || '').trim();
  const normalized = (normalizedName || raw).trim();
  const compact = normalized.replace(/\s+/g, '');
  if (!compact) return 'opaque';

  if (ABBREV_OR_CODE_RE.test(raw) || ABBREV_OR_CODE_RE.test(normalized)) {
    return 'opaque';
  }

  const ascii = (compact.match(/[A-Za-z0-9]/g) || []).length;
  const symbols = (compact.match(/[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const asciiRatio = ascii / Math.max(compact.length, 1);
  const symbolRatio = symbols / Math.max(compact.length, 1);

  // Mostly code-like ASCII / digit soup.
  if (compact.length <= 12 && asciiRatio >= 0.6 && ascii >= 3) return 'opaque';
  if (asciiRatio >= 0.75 && ascii >= 4) return 'opaque';
  if (symbolRatio >= 0.35 && compact.length <= 10) return 'opaque';

  // Truncation / stub: very short ASCII-only.
  if (compact.length <= 3 && !hasKanjiOrKana(compact) && ascii >= 1) return 'opaque';

  // Short Japanese tokens are still informative names (卵/米/茶/水/キャベツ…).
  if (hasKanjiOrKana(compact)) {
    if (compact.length <= 2 && asciiRatio > 0.4) return 'ambiguous';
    return 'informative';
  }

  // Latin brand-ish readable words without heavy digits.
  if (/[A-Za-z]{3,}/.test(compact) && asciiRatio < 0.85) return 'ambiguous';

  if (compact.length <= 4) return 'ambiguous';
  return 'ambiguous';
}

function hasComparisonIdentity(input: SemanticGateInput): boolean {
  return !!(input.comparisonKey && String(input.comparisonKey).trim());
}

/**
 * Decide whether this product form needs Gemini semantic enrichment.
 * Precision-first: prefer "sufficient" when local category + readable name exist.
 */
export function evaluateSemanticSufficiency(
  input: SemanticGateInput
): SemanticGateResult {
  const reasons: string[] = [];
  const raw = (input.rawName || '').trim();
  const normalized = (input.normalizedName || raw).trim();
  const nameInfo = assessNameInformativeness(raw, normalized);
  const categoryStrong = isStrongCategory(input.category, input.categoryConfidence);
  const categoryWeak = isWeakCategory(input.category, input.categoryConfidence);

  if (!raw) {
    return {
      status: 'needs_enrichment',
      needsEnrichment: true,
      reasons: ['empty_name'],
      nameInformativeness: 'opaque',
      categoryStrong: false,
    };
  }

  const cached = input.cachedSemanticStatus;
  if (cached === 'enriched' || cached === 'sufficient') {
    return {
      status: cached,
      needsEnrichment: false,
      reasons: ['semantic_cache_hit'],
      nameInformativeness: nameInfo,
      categoryStrong,
    };
  }
  if (cached === 'failed') {
    return {
      status: 'failed',
      needsEnrichment: false,
      reasons: ['semantic_failed_cached'],
      nameInformativeness: nameInfo,
      categoryStrong,
    };
  }

  // Existing MP reuse with usable category → V1 tracking already possible.
  if (input.existingMerchantProductMatch && categoryStrong) {
    return {
      status: 'sufficient',
      needsEnrichment: false,
      reasons: ['existing_mp_with_strong_category'],
      nameInformativeness: nameInfo,
      categoryStrong,
    };
  }
  if (input.existingMerchantProductMatch && !categoryWeak && nameInfo !== 'opaque') {
    return {
      status: 'sufficient',
      needsEnrichment: false,
      reasons: ['existing_mp_readable_name'],
      nameInformativeness: nameInfo,
      categoryStrong,
    };
  }

  // V1 sufficient: readable name + strong local category.
  // Brand / canonicalName / structural attrs are optional — never required for AI.
  if (nameInfo === 'informative' && categoryStrong) {
    reasons.push('informative_name_with_strong_category');
    if (hasComparisonIdentity(input)) reasons.push('stable_comparison_identity');
    return {
      status: 'sufficient',
      needsEnrichment: false,
      reasons,
      nameInformativeness: nameInfo,
      categoryStrong,
    };
  }

  // Opaque / abbrev / code-like → AI (category alone does not decode PB/TV/MLK stubs).
  if (nameInfo === 'opaque') {
    return {
      status: 'needs_enrichment',
      needsEnrichment: true,
      reasons: [
        categoryStrong
          ? 'opaque_name_needs_semantic_decode'
          : 'opaque_name_with_weak_category',
      ],
      nameInformativeness: nameInfo,
      categoryStrong,
    };
  }

  // Ambiguous + uncategorized/weak → AI.
  if (nameInfo === 'ambiguous' && categoryWeak) {
    return {
      status: 'needs_enrichment',
      needsEnrichment: true,
      reasons: ['ambiguous_name_with_weak_category'],
      nameInformativeness: nameInfo,
      categoryStrong,
    };
  }

  // Ambiguous but categorized → partial / sufficient for V1.
  if (nameInfo === 'ambiguous' && categoryStrong) {
    return {
      status: 'partial',
      needsEnrichment: false,
      reasons: ['ambiguous_name_with_strong_category'],
      nameInformativeness: nameInfo,
      categoryStrong,
    };
  }

  // Informative name but weak category → AI (category gap is the real need).
  if (nameInfo === 'informative' && categoryWeak) {
    return {
      status: 'needs_enrichment',
      needsEnrichment: true,
      reasons: ['informative_name_but_weak_category'],
      nameInformativeness: nameInfo,
      categoryStrong,
    };
  }

  // Default: do not spend AI just because fields are empty.
  return {
    status: 'partial',
    needsEnrichment: false,
    reasons: ['default_partial_skip_ai'],
    nameInformativeness: nameInfo,
    categoryStrong,
  };
}

export function needsSemanticEnrichment(input: SemanticGateInput): boolean {
  return evaluateSemanticSufficiency(input).needsEnrichment;
}

/** Stem helper kept for tests / diagnostics (not product-type branching). */
export function semanticNameStem(text: string): string {
  return buildIdentityNameStem(text);
}
