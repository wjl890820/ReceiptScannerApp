/**
 * Reviewed-item category semantic consistency.
 *
 * item.category is the authoritative V1 spending category.
 * categoryKey uses that same enum (OCR categoryKey accepts ProductCategory).
 * category_main / category_sub / analysis_tags use the separate V1 main/sub
 * taxonomy via mapLegacyCategoryToV1. They are rebuilt only when already
 * present, and only after the user-visible category changes.
 */

import { buildAnalysisTags, mapLegacyCategoryToV1 } from './categoryTaxonomyV1';
import { normalizePersistedProductCategory } from './productCategory';

function semanticFieldPresent(item: Record<string, unknown>, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(item, key)) return false;
  const value = item[key];
  if (value == null) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function alignUserCorrectedCategorySemantics<T extends Record<string, unknown>>(
  item: T,
  finalCategory: string
): T {
  const next: Record<string, unknown> = { ...item, category: finalCategory };

  if (semanticFieldPresent(item, 'categoryKey')) {
    next.categoryKey = finalCategory;
  }

  const v1 = mapLegacyCategoryToV1(finalCategory);
  if (semanticFieldPresent(item, 'category_main')) {
    next.category_main = v1.main;
  }
  if (semanticFieldPresent(item, 'category_sub')) {
    next.category_sub = v1.sub;
  }
  if (semanticFieldPresent(item, 'analysis_tags')) {
    next.analysis_tags = buildAnalysisTags(v1);
  }

  const classification = item.classification;
  if (
    classification &&
    typeof classification === 'object' &&
    !Array.isArray(classification)
  ) {
    const record = classification as Record<string, unknown>;
    if (typeof record.category === 'string' && record.category.trim()) {
      next.classification = { ...record, category: finalCategory };
    }
  }

  return next as T;
}

/**
 * Same baseline the history item editor shows:
 * normalizePersistedProductCategory(stored category, item name).
 */
export function historyEditorDisplayedCategory(
  storedCategory: unknown,
  itemName?: string
): string {
  return normalizePersistedProductCategory(storedCategory, itemName);
}

/**
 * True only when this history edit's category differs from the category
 * the editor showed for the persisted item. Legacy tokens that normalize
 * to that display are not a new category edit.
 */
export function historyItemCategoryChangedThisEdit(input: {
  storedCategory: unknown;
  itemName?: string;
  finalCategory: string;
}): boolean {
  return (
    input.finalCategory !==
    historyEditorDisplayedCategory(input.storedCategory, input.itemName)
  );
}

/**
 * History item save. Quantity/amount edits keep the displayed category, so
 * legacy raw values that normalize to that display must not rebuild semantics.
 */
export function materializeHistoryEditedItemCategorySemantics<
  T extends Record<string, unknown>,
>(
  editedItem: T,
  input: {
    storedCategory: unknown;
    itemName?: string;
    finalCategory: string;
  }
): T {
  const baselineDisplayedCategory = historyEditorDisplayedCategory(
    input.storedCategory,
    input.itemName
  );
  if (input.finalCategory === baselineDisplayedCategory) return editedItem;
  return alignUserCorrectedCategorySemantics(editedItem, input.finalCategory);
}

/**
 * Scan Review save. User-added lines start at uncategorized.
 * Recognition lines use the same normalized category the editor initialized.
 */
export function materializeScanReviewItemCategorySemantics<
  T extends Record<string, unknown>,
>(
  reviewedItem: T,
  input: {
    isUserAdded: boolean;
    recognitionCategory: unknown;
    recognitionItemName?: string;
    finalCategory: string;
  }
): T {
  const baselineCategory = input.isUserAdded
    ? 'uncategorized'
    : normalizePersistedProductCategory(
        input.recognitionCategory,
        input.recognitionItemName
      );
  if (input.finalCategory === baselineCategory) return reviewedItem;
  return alignUserCorrectedCategorySemantics(reviewedItem, input.finalCategory);
}
