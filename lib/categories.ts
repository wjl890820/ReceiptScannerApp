// lib/categories.ts
// Supermarket-only categorization taxonomy (16 categories for better granularity)

/**
 * Stable category keys for supermarket items only
 * These are stored in the database and used for analytics
 * Keys are English snake_case, display names come from i18n
 * 
 * Expanded to 16 categories:
 * - Split condiments from quick_meals (seasonings vs ready meals)
 * - Split alcohol from non_alcoholic_drinks (already separate)
 * - Added more granular categories
 */
export const GROCERY_CATEGORIES = [
  'produce',              // Vegetables/fruits
  'meat_seafood',         // Meat & Seafood
  'dairy_eggs',           // Dairy & Eggs
  'bakery',               // Bakery items (bread, pastries)
  'staples',              // Rice/noodles/bread base/beans
  'snacks_sweets',        // Snacks & Sweets
  'quick_meals',          // Bento, frozen meals, instant foods (ready-to-eat)
  'condiments',           // Seasonings/sauces/spices (separate from quick_meals)
  'non_alcoholic_drinks', // Non-alcoholic drinks (separate from alcohol)
  'alcohol',              // Alcohol (separate from non_alcoholic_drinks)
  'household',            // Paper, detergent, hygiene
  'frozen_foods',         // Frozen foods (separate category)
  'canned_preserved',     // Canned and preserved foods
  'beverages_other',      // Other beverages (sports drinks, energy drinks, etc.)
  'health_supplements',   // Health supplements, vitamins
  'other_grocery',        // Other grocery items (fallback)
] as const;

/**
 * Special categories
 */
export const SPECIAL_CATEGORIES = [
  'uncategorized',     // 未分类（在grocery收据内但无法分类）
  'non_grocery',       // 非grocery（收据不属于grocery store，排除在分类统计外）
] as const;

/**
 * All valid category keys
 */
export const ALL_CATEGORIES = [...GROCERY_CATEGORIES, ...SPECIAL_CATEGORIES] as const;

export type GroceryCategory = typeof GROCERY_CATEGORIES[number];
export type SpecialCategory = typeof SPECIAL_CATEGORIES[number];
export type Category = GroceryCategory | SpecialCategory;

/**
 * Check if a category is a grocery category (used for analytics)
 */
export function isGroceryCategory(category: string): boolean {
  return GROCERY_CATEGORIES.includes(category as GroceryCategory);
}

/**
 * Check if a category should be excluded from analytics
 */
export function isExcludedFromAnalytics(category: string): boolean {
  return category === 'non_grocery' || category === 'uncategorized';
}
