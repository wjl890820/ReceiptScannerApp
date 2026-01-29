// lib/receiptEnricher.ts
import type { ReceiptAnalysis, ReceiptItem } from './receiptAnalyzer';
import { learnCategoryFromEdit } from './categoryLearner';
import { normalizeProductName, normalizeMerchantName } from './productNormalizer';
import { ALL_CATEGORIES, type Category } from './categories';
import { isGroceryMerchant } from './groceryDetector';
import {
  classifyItem,
  resetClassificationStats,
  getClassificationStats,
  startReceiptClassification,
  type ClassifyInput,
} from './categoryClassifier';
import { getLastClassifyError, clearLastClassifyError } from './categoryAiClient';

/**
 * Infer grocery category based on product name (rule-based fallback)
 * @deprecated Use classifyItem from categoryClassifier instead
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

  // Quick meals (bento, ready-to-eat meals, instant foods - but NOT frozen)
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
    n.includes('bento') ||
    n.includes('ready') ||
    n.includes('instant')
  ) {
    return 'quick_meals';
  }

  // Frozen foods (separate from quick_meals)
  if (
    n.includes('冷凍') ||
    n.includes('冷凍食品') ||
    n.includes('frozen') ||
    n.includes('freezer')
  ) {
    return 'frozen_foods';
  }

  // Canned and preserved foods
  if (
    n.includes('缶詰') ||
    n.includes('瓶詰') ||
    n.includes('保存食') ||
    n.includes('canned') ||
    n.includes('preserved') ||
    n.includes('jar')
  ) {
    return 'canned_preserved';
  }

  // Other beverages (sports drinks, energy drinks, etc.)
  if (
    n.includes('スポーツ') ||
    n.includes('エナジー') ||
    n.includes('栄養') ||
    n.includes('sports') ||
    n.includes('energy') ||
    n.includes('isotonic')
  ) {
    return 'beverages_other';
  }

  // Health supplements
  if (
    n.includes('サプリ') ||
    n.includes('ビタミン') ||
    n.includes('栄養補助') ||
    n.includes('supplement') ||
    n.includes('vitamin') ||
    n.includes('health')
  ) {
    return 'health_supplements';
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
 * Uses unified categoryClassifier service
 */
export async function applyCategoriesWithLearning(
  analysis: ReceiptAnalysis
): Promise<ReceiptAnalysis> {
  const items = Array.isArray(analysis.items) ? analysis.items : [];
  const enrichedItems: ReceiptItem[] = [];

  // Detect if this is a grocery receipt
  const merchantRaw = analysis.merchant || '';
  const merchantNormalized = (analysis as any).merchant_normalized || null;
  const isGrocery = isGroceryMerchant(merchantRaw, merchantNormalized);

  resetClassificationStats();
  startReceiptClassification();

  for (const it of items) {
    const name = typeof it?.name === 'string' ? it.name : '';
    const normalized = normalizeProductName(name);

    let category: Category | null;
    let classificationStatus: 'ok' | 'pending' | 'failed' | 'fallback' = 'ok';
    let classificationConfidence = 0;

    if (!isGrocery) {
      // Non-grocery receipt: mark all items as non_grocery
      category = 'non_grocery';
      classificationStatus = 'ok';
      classificationConfidence = 1;
    } else {
      // Grocery receipt: use unified classifier
      clearLastClassifyError();
      const classifyInput: ClassifyInput = {
        rawName: name,
        normalizedName: normalized.normalizedName,
        merchantName: merchantRaw || merchantNormalized || undefined,
        price: typeof it?.lineTotal === 'number' ? it.lineTotal : undefined,
      };

      const classification = await classifyItem(classifyInput);
      category = (classification.categoryId || null) as Category | null;
      classificationConfidence = Number.isFinite(classification.confidence)
        ? Number(classification.confidence)
        : 0;

      const lastError = getLastClassifyError();

      if (
        lastError &&
        (classification.source === 'ai' || classification.source === 'fallback')
      ) {
        // classify-item 超时 / 失败：标记为 failed，不给具体类别
        classificationStatus = 'failed';
        category = null;
        classificationConfidence = 0;
      } else if (classification.source === 'fallback') {
        // 本地规则兜底（无 API 错误）
        classificationStatus = 'fallback';
      } else {
        classificationStatus = 'ok';
      }

      // If item already has a valid category from OCR/AI, use it if classifier returned fallback
      if (
        classificationStatus !== 'failed' &&
        classification.source === 'fallback' &&
        typeof (it as any)?.category === 'string' &&
        (it as any).category.trim() &&
        ALL_CATEGORIES.includes((it as any).category.trim() as Category)
      ) {
        category = (it as any).category.trim() as Category;
      }
    }

    enrichedItems.push({
      ...it,
      name,
      category: category as any,
      // 新字段：分类状态与置信度（兼容旧数据，读取时需做默认值处理）
      classification_status: classificationStatus,
      classification_confidence: classificationConfidence,
    } as any);
  }

  // Log classification statistics (once per receipt)
  const stats = getClassificationStats();
  if (stats) {
    console.log(
      '[CategoryClassifier] Stats:',
      `mapping=${stats.mapping}`,
      `rules=${stats.rules}`,
      `ai=${stats.ai}`,
      `fallback=${stats.fallback}`
    );
  }

  return {
    ...analysis,
    items: enrichedItems as any,
    is_grocery: isGrocery, // Add flag to analysis for later filtering
  } as any;
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
