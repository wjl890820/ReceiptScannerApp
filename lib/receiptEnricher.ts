// lib/receiptEnricher.ts
import type { ReceiptAnalysis, ReceiptItem } from './receiptAnalyzer';
import { getLearnedCategory, learnCategoryFromEdit } from './categoryLearner';
import { normalizeProductName } from './productNormalizer';
import { GROCERY_CATEGORIES, ALL_CATEGORIES, type Category } from './categories';
import { isGroceryMerchant } from './groceryDetector';

/**
 * Infer grocery category based on product name (rule-based fallback)
 * Returns one of the 12 grocery categories or 'uncategorized'
 */
function inferGroceryCategory(name: string): Category {
  const n = (name || '').toLowerCase();

  // Produce (vegetables/fruits)
  if (
    n.includes('野菜') ||
    n.includes('白菜') ||
    n.includes('ねぎ') ||
    n.includes('えのき') ||
    n.includes('茸') ||
    n.includes('椎茸') ||
    n.includes('果物') ||
    n.includes('りんご') ||
    n.includes('みかん') ||
    n.includes('バナナ') ||
    n.includes('vegetable') ||
    n.includes('fruit')
  ) {
    return 'produce';
  }

  // Meat & Seafood (separate category)
  if (
    n.includes('牛') ||
    n.includes('豚') ||
    n.includes('鶏') ||
    n.includes('とり') ||
    n.includes('魚') ||
    n.includes('刺身') ||
    n.includes('meat') ||
    n.includes('fish') ||
    n.includes('chicken') ||
    n.includes('beef') ||
    n.includes('pork') ||
    n.includes('seafood')
  ) {
    return 'meat_seafood';
  }

  // Dairy & Eggs (separate category)
  if (
    n.includes('牛乳') ||
    n.includes('ミルク') ||
    n.includes('チーズ') ||
    n.includes('ヨーグルト') ||
    n.includes('バター') ||
    n.includes('卵') ||
    n.includes('たまご') ||
    n.includes('milk') ||
    n.includes('cheese') ||
    n.includes('yogurt') ||
    n.includes('butter') ||
    n.includes('egg')
  ) {
    return 'dairy_eggs';
  }

  // Bakery (bread, pastries - separate from staples)
  if (
    n.includes('パン') ||
    n.includes('ロール') ||
    n.includes('クロワッサン') ||
    n.includes('ケーキ') ||
    n.includes('bread') ||
    n.includes('pastry') ||
    n.includes('croissant') ||
    n.includes('cake')
  ) {
    return 'bakery';
  }

  // Staples (rice/noodles/bread base/beans)
  if (
    n.includes('米') ||
    n.includes('ご飯') ||
    n.includes('うどん') ||
    n.includes('そば') ||
    n.includes('ラーメン') ||
    n.includes('パスタ') ||
    n.includes('rice') ||
    n.includes('noodle') ||
    n.includes('bean') ||
    n.includes('豆')
  ) {
    return 'staples';
  }

  // Quick meals (bento, frozen meals, instant foods)
  if (
    n.includes('弁当') ||
    n.includes('おにぎり') ||
    n.includes('惣菜') ||
    n.includes('天') ||
    n.includes('揚げ') ||
    n.includes('からあげ') ||
    n.includes('唐揚') ||
    n.includes('フライ') ||
    n.includes('コロッケ') ||
    n.includes('とり天') ||
    n.includes('冷凍') ||
    n.includes('bento') ||
    n.includes('ready') ||
    n.includes('frozen') ||
    n.includes('instant')
  ) {
    return 'quick_meals';
  }

  // Snacks & Sweets
  if (
    n.includes('チョコ') ||
    n.includes('ビス') ||
    n.includes('ビスケット') ||
    n.includes('クッキー') ||
    n.includes('スナック') ||
    n.includes('ナッツ') ||
    n.includes('アイス') ||
    n.includes('デザート') ||
    n.includes('菓子') ||
    n.includes('chocolate') ||
    n.includes('snack') ||
    n.includes('cookie') ||
    n.includes('sweet') ||
    n.includes('candy')
  ) {
    return 'snacks_sweets';
  }

  // Non-alcoholic drinks (非酒精饮料)
  if (
    n.includes('お茶') ||
    n.includes('茶') ||
    n.includes('コーヒー') ||
    n.includes('coffee') ||
    n.includes('コーラ') ||
    n.includes('ファンタ') ||
    n.includes('ジュース') ||
    n.includes('drink') ||
    n.includes('水') ||
    n.includes('tea') ||
    n.includes('juice')
  ) {
    return 'non_alcoholic_drinks';
  }

  // Alcohol (酒类)
  if (
    n.includes('ビール') ||
    n.includes('酒') ||
    n.includes('ワイン') ||
    n.includes('日本酒') ||
    n.includes('焼酎') ||
    n.includes('beer') ||
    n.includes('wine') ||
    n.includes('sake') ||
    n.includes('alcohol')
  ) {
    return 'alcohol';
  }

  // Condiments (调味料)
  if (
    n.includes('醤油') ||
    n.includes('味噌') ||
    n.includes('塩') ||
    n.includes('砂糖') ||
    n.includes('油') ||
    n.includes('ソース') ||
    n.includes('sauce') ||
    n.includes('soy') ||
    n.includes('salt') ||
    n.includes('sugar')
  ) {
    return 'condiments';
  }

  // Household (日用品)
  if (
    n.includes('紙') ||
    n.includes('ティッシュ') ||
    n.includes('洗剤') ||
    n.includes('シャンプー') ||
    n.includes('歯磨き') ||
    n.includes('タオル') ||
    n.includes('household') ||
    n.includes('tissue') ||
    n.includes('shampoo')
  ) {
    return 'household';
  }

  // Default to uncategorized for grocery items we can't classify
  return 'uncategorized';
}

/**
 * Apply categories with learning (grocery-only categorization)
 * Only categorizes items if the receipt is from a grocery store
 */
export async function applyCategoriesWithLearning(
  analysis: ReceiptAnalysis
): Promise<ReceiptAnalysis> {
  const items = Array.isArray(analysis.items) ? analysis.items : [];
  const enrichedItems: ReceiptItem[] = [];

  // Detect if this is a grocery receipt
  const merchantRaw = analysis.merchant || '';
  const merchantNormalized = analysis.merchant_normalized || null;
  const isGrocery = isGroceryMerchant(merchantRaw, merchantNormalized);

  for (const it of items) {
    const name = typeof it?.name === 'string' ? it.name : '';
    const normalized = normalizeProductName(name);

    let category: Category;

    if (!isGrocery) {
      // Non-grocery receipt: mark all items as non_grocery
      category = 'non_grocery';
    } else {
      // Grocery receipt: categorize items

      // 1. Priority: use learned category from user edits
      let learnedCategory = await getLearnedCategory(normalized.normalizedName);
      if (learnedCategory && ALL_CATEGORIES.includes(learnedCategory as Category)) {
        category = learnedCategory as Category;
      }
      // 2. If item already has a valid category (from AI or previous processing)
      else if (typeof it?.category === 'string' && it.category.trim()) {
        const existingCategory = it.category.trim();
        if (ALL_CATEGORIES.includes(existingCategory as Category)) {
          category = existingCategory as Category;
        } else {
          // Invalid category, infer new one
          category = inferGroceryCategory(name);
        }
      }
    // 3. Otherwise use rule-based inference
    else {
      category = inferGroceryCategory(name);
    }

    // Fallback to other_grocery if still uncategorized but in grocery receipt
    if (category === 'uncategorized' && isGrocery) {
      category = 'other_grocery';
    }
    }

    enrichedItems.push({
      ...it,
      name,
      category: category as any,
    } as any);
  }

  return {
    ...analysis,
    items: enrichedItems as any,
    is_grocery: isGrocery, // Add flag to analysis for later filtering
  };
}

/**
 * 学习用户编辑的分类
 */
export async function learnFromUserEdit(
  itemName: string,
  category: string
): Promise<void> {
  const normalized = normalizeProductName(itemName);
  await learnCategoryFromEdit(normalized.normalizedName, category);
}
