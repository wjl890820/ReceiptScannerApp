/**
 * MERUNO taxonomy & classification provenance contract (M1-A).
 *
 * Lightweight single source of truth for:
 * - taxonomy / classification version ids
 * - V1 spending categories vs system review states
 * - future subcategory / product_type slots (unset today)
 *
 * Not a generic registry or ontology platform.
 */

/** Stable taxonomy id. Changes only when category semantics/schema meaning changes. */
export const TAXONOMY_VERSION = 'meruno-taxonomy-v1' as const;

/**
 * Current deterministic classifier / rule-set id (name rules + local pipeline).
 * Not the app build number.
 */
export const CLASSIFICATION_VERSION = 'meruno-classify-rules-v1' as const;

/** Historical rows with no stored classifier version. */
export const LEGACY_CLASSIFICATION_VERSION = 'legacy_unknown' as const;

/**
 * User-visible V1 spending buckets (consumer spend categories).
 * uncategorized is intentionally excluded — it is a system/review state.
 */
export const V1_SPENDING_CATEGORIES = [
  'food_ingredients',
  'ready_to_eat',
  'snacks_drinks',
  'household',
  'personal_care',
  'pet_care',
  'other',
] as const;

/** System / review states — not normal spending categories. */
export const SYSTEM_CATEGORY_STATES = ['uncategorized'] as const;

export type V1SpendingCategory = (typeof V1_SPENDING_CATEGORIES)[number];
export type SystemCategoryState = (typeof SYSTEM_CATEGORY_STATES)[number];

/**
 * Writable V1 category values: seven spending buckets + uncategorized review state.
 * Used by sanitize / active-write boundaries.
 */
export const V1_WRITABLE_CATEGORIES = [
  ...V1_SPENDING_CATEGORIES,
  ...SYSTEM_CATEGORY_STATES,
] as const;

export type V1WritableCategory = (typeof V1_WRITABLE_CATEGORIES)[number];

/**
 * Future-compatible semantic slots (optional; unset/null today).
 * category = spending bucket; subcategory / productType are finer product semantics.
 */
export type ProductSemanticSlots = {
  subcategory?: string | null;
  productType?: string | null;
};

/** Known classification_source values in the current architecture. */
export type ClassificationSource =
  | 'alias'
  | 'dictionary'
  | 'mapping'
  | 'rules'
  | 'name_rule'
  | 'ai'
  | 'ai_batch'
  | 'fallback'
  | 'user'
  | 'backfill'
  | 'migration'
  | 'unknown';

export type ClassificationProvenance = {
  classification_source: string;
  classification_version: string | null;
  taxonomy_version: string;
};

const SPENDING_SET = new Set<string>(V1_SPENDING_CATEGORIES);
const SYSTEM_SET = new Set<string>(SYSTEM_CATEGORY_STATES);
const WRITABLE_SET = new Set<string>(V1_WRITABLE_CATEGORIES);

export function isV1SpendingCategory(value: unknown): value is V1SpendingCategory {
  return typeof value === 'string' && SPENDING_SET.has(value);
}

export function isSystemCategoryState(value: unknown): value is SystemCategoryState {
  return typeof value === 'string' && SYSTEM_SET.has(value);
}

export function isV1WritableCategory(value: unknown): value is V1WritableCategory {
  return typeof value === 'string' && WRITABLE_SET.has(value);
}

/** Explicit user category correction — must never be silently overwritten. */
export function isExplicitUserCategoryOverride(item: {
  classification_source?: unknown;
} | null | undefined): boolean {
  const src = item?.classification_source;
  return src === 'user' || src === 'manual';
}

export function stampMachineClassificationProvenance(
  source: string | null | undefined
): ClassificationProvenance {
  return {
    classification_source: source && String(source).trim() ? String(source).trim() : 'unknown',
    classification_version: CLASSIFICATION_VERSION,
    taxonomy_version: TAXONOMY_VERSION,
  };
}

export function stampUserClassificationProvenance(): ClassificationProvenance {
  return {
    classification_source: 'user',
    // User override is not produced by a classifier ruleset.
    classification_version: null,
    taxonomy_version: TAXONOMY_VERSION,
  };
}

/**
 * Read-time provenance resolution for historical rows that lack explicit versions.
 * Does not invent a classifier version; taxonomy falls back to current id only because
 * V1 ProductCategory keys are the same meruno-taxonomy-v1 space.
 */
export function resolveClassificationProvenance(item: {
  classification_source?: unknown;
  classification_version?: unknown;
  taxonomy_version?: unknown;
  category?: unknown;
} | null | undefined): ClassificationProvenance {
  const rawSource =
    typeof item?.classification_source === 'string' ? item.classification_source.trim() : '';
  const rawTaxonomy =
    typeof item?.taxonomy_version === 'string' ? item.taxonomy_version.trim() : '';
  const rawClassVersion =
    typeof item?.classification_version === 'string'
      ? item.classification_version.trim()
      : '';

  return {
    classification_source: rawSource || 'unknown',
    taxonomy_version: rawTaxonomy || TAXONOMY_VERSION,
    classification_version: rawClassVersion || LEGACY_CLASSIFICATION_VERSION,
  };
}
