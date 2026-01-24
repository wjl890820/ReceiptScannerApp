// lib/categoryLabels.ts
// Category labels in three languages (zh/ja/en)
// Maps category_id to localized labels

import type { Category } from './categories';
import type { Locale } from './i18n';

export const categoryLabels: Record<Category, Record<Locale, string>> = {
  // Grocery categories
  produce: {
    zh: '生鲜蔬果',
    ja: '生鮮・野菜・果物',
    en: 'Produce',
  },
  meat_seafood: {
    zh: '肉鱼海鲜',
    ja: '肉・魚・海鮮',
    en: 'Meat & Seafood',
  },
  dairy_eggs: {
    zh: '乳制品/蛋',
    ja: '乳製品・卵',
    en: 'Dairy & Eggs',
  },
  bakery: {
    zh: '烘焙',
    ja: 'パン・焼き菓子',
    en: 'Bakery',
  },
  staples: {
    zh: '主食',
    ja: '主食',
    en: 'Staples',
  },
  snacks_sweets: {
    zh: '零食甜品',
    ja: 'お菓子・スイーツ',
    en: 'Snacks & Sweets',
  },
  quick_meals: {
    zh: '便当速食',
    ja: '弁当・冷凍食品',
    en: 'Quick Meals',
  },
  condiments: {
    zh: '调味料',
    ja: '調味料',
    en: 'Condiments',
  },
  non_alcoholic_drinks: {
    zh: '非酒精饮料',
    ja: 'ノンアルコール飲料',
    en: 'Non-Alcoholic Drinks',
  },
  alcohol: {
    zh: '酒类',
    ja: 'アルコール',
    en: 'Alcohol',
  },
  household: {
    zh: '日用品',
    ja: '日用品',
    en: 'Household',
  },
  frozen_foods: {
    zh: '冷冻食品',
    ja: '冷凍食品',
    en: 'Frozen Foods',
  },
  canned_preserved: {
    zh: '罐头腌制品',
    ja: '缶詰・保存食品',
    en: 'Canned & Preserved',
  },
  beverages_other: {
    zh: '其他饮料',
    ja: 'その他飲料',
    en: 'Other Beverages',
  },
  health_supplements: {
    zh: '健康补品',
    ja: '健康補助食品',
    en: 'Health Supplements',
  },
  other_grocery: {
    zh: '其他杂货',
    ja: 'その他雑貨',
    en: 'Other Grocery',
  },
  // Special categories
  uncategorized: {
    zh: '未分类',
    ja: '未分類',
    en: 'Uncategorized',
  },
  non_grocery: {
    zh: '非杂货',
    ja: '非雑貨',
    en: 'Non-Grocery',
  },
};

/**
 * Get localized label for a category
 * @param categoryId - The category ID (e.g., 'meat_seafood', 'other_grocery')
 * @param locale - The locale ('zh' | 'ja' | 'en')
 * @returns The localized label, or the categoryId if not found
 */
export function getCategoryLabel(categoryId: string, locale: Locale): string {
  const labels = categoryLabels[categoryId as Category];
  if (labels && labels[locale]) {
    return labels[locale];
  }
  // Fallback to English if locale not found
  if (labels && labels.en) {
    return labels.en;
  }
  // Last resort: return the categoryId
  return categoryId;
}
