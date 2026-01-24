// lib/categoryPalette.ts
// Unified category color palette and label access
// Single source of truth for category colors and i18n labels

import { ALL_CATEGORIES, GROCERY_CATEGORIES, SPECIAL_CATEGORIES, type Category } from './categories';
import { t } from './i18n';

/**
 * Category color palette
 * Colors are chosen to be:
 * - Distinct from each other
 * - Visible on white background (not too light)
 * - Suitable for text overlay (not too dark)
 * - At least 16 colors for all grocery categories
 */
const CATEGORY_COLOR_MAP: Record<Category, string> = {
  // Grocery categories
  produce: '#4CAF50',              // Green - fresh produce
  meat_seafood: '#F44336',         // Red - meat/seafood
  dairy_eggs: '#FFC107',           // Amber - dairy products
  bakery: '#FF9800',               // Orange - bakery
  staples: '#9C27B0',              // Purple - staples
  snacks_sweets: '#E91E63',        // Pink - snacks/sweets
  quick_meals: '#00BCD4',          // Cyan - quick meals
  condiments: '#795548',           // Brown - condiments
  non_alcoholic_drinks: '#2196F3', // Blue - non-alcoholic drinks
  alcohol: '#8B4513',              // SaddleBrown - alcohol
  household: '#607D8B',            // BlueGrey - household
  frozen_foods: '#00ACC1',         // Teal - frozen foods
  canned_preserved: '#5C6BC0',     // Indigo - canned/preserved
  beverages_other: '#26A69A',      // Teal - other beverages
  health_supplements: '#AB47BC',   // Purple - health supplements
  other_grocery: '#78909C',        // BlueGrey - other grocery
  
  // Special categories
  uncategorized: '#BDBDBD',        // Grey - uncategorized
  non_grocery: '#9E9E9E',          // Grey - non-grocery
};

/**
 * Get color for a category ID
 * Returns a consistent color for the same categoryId
 */
export function getCategoryColor(categoryId: string): string {
  // Validate categoryId is in our list
  if (ALL_CATEGORIES.includes(categoryId as Category)) {
    return CATEGORY_COLOR_MAP[categoryId as Category];
  }
  
  // Fallback for unknown categories
  return CATEGORY_COLOR_MAP.other_grocery;
}

/**
 * Get i18n label for a category ID
 * Uses t(`category.${categoryId}`) with fallback to categoryId
 * Note: Uses 'category' key (not 'categories') to match existing locale files
 */
export function getCategoryLabel(categoryId: string): string {
  const i18nKey = `category.${categoryId}`;
  const label = t(i18nKey);
  
  // If translation exists and is different from the key, return it
  if (label && label !== i18nKey) {
    return label;
  }
  
  // Fallback to categoryId (should not happen if i18n keys are complete)
  return categoryId;
}

/**
 * Get all category IDs (for iteration)
 */
export function getCategoryIds(): readonly string[] {
  return ALL_CATEGORIES;
}

/**
 * Get color map (for debugging/export)
 */
export function getCategoryColorMap(): Record<string, string> {
  return { ...CATEGORY_COLOR_MAP };
}
