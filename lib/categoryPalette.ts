// lib/categoryPalette.ts
// Unified category color palette and label access
// Single source of truth for category colors and i18n labels

import { ALL_CATEGORIES, type Category } from './categories';
import { normalizeProductCategory, PRODUCT_CATEGORIES, type ProductCategory } from './productCategory';
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
 * 新分类的颜色（item.category 统一为新 enum 后使用；旧值经归一映射到这里）。
 */
const PRODUCT_CATEGORY_COLOR: Record<ProductCategory, string> = {
  food_ingredients: '#4CAF50', // Green
  ready_to_eat: '#00BCD4', // Cyan
  snacks_drinks: '#E91E63', // Pink
  household: '#607D8B', // BlueGrey
  personal_care: '#AB47BC', // Purple
  pet_care: '#FF9800', // Orange
  uncategorized: '#BDBDBD', // Grey
  other: '#78909C', // BlueGrey
};

/**
 * Get color for a category ID（兼容新旧 enum，统一归一到新分类调色板）。
 */
export function getCategoryColor(categoryId: string): string {
  const c = normalizeProductCategory(categoryId);
  return PRODUCT_CATEGORY_COLOR[c] || PRODUCT_CATEGORY_COLOR.other;
}

/**
 * Get i18n label for a category ID（兼容新旧 enum；统一归一到新分类后取 `category.<key>`）。
 */
export function getCategoryLabel(categoryId: string): string {
  const c = normalizeProductCategory(categoryId);
  const i18nKey = `category.${c}`;
  const label = t(i18nKey);
  if (label && label !== i18nKey) return label;
  return t('category.other');
}

/**
 * Item-level tag display for History/Detail: 待分类 vs localized category。
 * - 归一后为 uncategorized（或分类状态异常）→ "待分类"
 * - 否则 → 新分类 label
 */
export function getItemTagDisplay(item: {
  category?: string | null;
  classification_status?: string;
}): { visible: boolean; label: string } {
  const status = (item.classification_status as 'ok' | 'pending' | 'failed' | 'fallback') || 'ok';
  const c = normalizeProductCategory(item.category);

  if (status !== 'ok' && status !== 'fallback') {
    return { visible: true, label: t('common.uncategorizedTag') };
  }
  if (c === 'uncategorized') {
    return { visible: true, label: t('common.uncategorizedTag') };
  }
  return { visible: true, label: getCategoryLabel(c) };
}

/**
 * Short label for KPI/narrow space; falls back to full label if no short key.
 */
export function getCategoryShortLabel(categoryId: string): string {
  const c = normalizeProductCategory(categoryId);
  const shortKey = `categoriesShort.${c}`;
  const short = t(shortKey);
  if (short && short !== shortKey) return short;
  return getCategoryLabel(c);
}

/**
 * 可选分类列表（新 enum）。
 */
export function getProductCategoryOptions(): readonly ProductCategory[] {
  return PRODUCT_CATEGORIES;
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
