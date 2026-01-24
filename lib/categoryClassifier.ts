// lib/categoryClassifier.ts
// Unified category classification service with hybrid strategy:
// 1. Local mapping (highest priority)
// 2. Rule-based matching (high confidence)
// 3. AI fallback (for uncertain items)
// 4. Fallback to other_grocery

import type { Category } from './categories';
import { ALL_CATEGORIES, GROCERY_CATEGORIES } from './categories';
import { normalizeProductName, normalizeMerchantName } from './productNormalizer';
import { getLearnedCategory, learnCategoryMapping } from './categoryLearner';
import { getSupabaseUrl, getSupabaseAnonKey } from './env';
import { getDeviceId } from './deviceId';
import { getCurrentLocale } from './i18n';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export type ClassificationSource = 'mapping' | 'rules' | 'ai' | 'fallback';

export type ClassificationResult = {
  categoryId: Category;
  confidence: number;
  source: ClassificationSource;
  reason?: string;
};

export type ClassifyInput = {
  rawName: string;
  normalizedName?: string;
  merchantName?: string;
  price?: number;
  locale?: string;
};

// Classification statistics (per receipt)
let classificationStats: {
  mapping: number;
  rules: number;
  ai: number;
  fallback: number;
} | null = null;

/**
 * Reset classification statistics (call at start of each receipt)
 */
export function resetClassificationStats(): void {
  classificationStats = { mapping: 0, rules: 0, ai: 0, fallback: 0 };
}

/**
 * Get classification statistics (call after processing all items)
 */
export function getClassificationStats(): {
  mapping: number;
  rules: number;
  ai: number;
  fallback: number;
} | null {
  return classificationStats;
}

/**
 * Rule-based category inference (enhanced from receiptEnricher)
 */
function classifyByRules(name: string): { category: Category; confidence: number } | null {
  const n = (name || '').toLowerCase();

  // Produce (vegetables/fruits) - confidence 0.9
  if (
    n.includes('野菜') || n.includes('白菜') || n.includes('ねぎ') || n.includes('えのき') ||
    n.includes('茸') || n.includes('椎茸') || n.includes('果物') || n.includes('りんご') ||
    n.includes('みかん') || n.includes('バナナ') || n.includes('vegetable') || n.includes('fruit')
  ) {
    return { category: 'produce', confidence: 0.9 };
  }

  // Meat & Seafood - confidence 0.9
  if (
    n.includes('牛') || n.includes('豚') || n.includes('鶏') || n.includes('とり') ||
    n.includes('魚') || n.includes('刺身') || n.includes('meat') || n.includes('fish') ||
    n.includes('chicken') || n.includes('beef') || n.includes('pork') || n.includes('seafood')
  ) {
    return { category: 'meat_seafood', confidence: 0.9 };
  }

  // Dairy & Eggs - confidence 0.9
  if (
    n.includes('牛乳') || n.includes('ミルク') || n.includes('チーズ') || n.includes('ヨーグルト') ||
    n.includes('バター') || n.includes('卵') || n.includes('たまご') || n.includes('milk') ||
    n.includes('cheese') || n.includes('yogurt') || n.includes('butter') || n.includes('egg')
  ) {
    return { category: 'dairy_eggs', confidence: 0.9 };
  }

  // Bakery - confidence 0.85
  if (
    n.includes('パン') || n.includes('ロール') || n.includes('クロワッサン') || n.includes('ケーキ') ||
    n.includes('bread') || n.includes('pastry') || n.includes('croissant') || n.includes('cake')
  ) {
    return { category: 'bakery', confidence: 0.85 };
  }

  // Staples - confidence 0.85
  if (
    n.includes('米') || n.includes('ご飯') || n.includes('うどん') || n.includes('そば') ||
    n.includes('ラーメン') || n.includes('パスタ') || n.includes('rice') || n.includes('noodle') ||
    n.includes('bean') || n.includes('豆')
  ) {
    return { category: 'staples', confidence: 0.85 };
  }

  // Quick meals - confidence 0.8
  if (
    n.includes('弁当') || n.includes('おにぎり') || n.includes('惣菜') || n.includes('天') ||
    n.includes('揚げ') || n.includes('からあげ') || n.includes('唐揚') || n.includes('フライ') ||
    n.includes('コロッケ') || n.includes('とり天') || n.includes('bento') || n.includes('ready') ||
    n.includes('instant')
  ) {
    return { category: 'quick_meals', confidence: 0.8 };
  }

  // Frozen foods - confidence 0.9
  if (n.includes('冷凍') || n.includes('冷凍食品') || n.includes('frozen') || n.includes('freezer')) {
    return { category: 'frozen_foods', confidence: 0.9 };
  }

  // Canned and preserved - confidence 0.85
  if (
    n.includes('缶詰') || n.includes('瓶詰') || n.includes('保存食') || n.includes('canned') ||
    n.includes('preserved') || n.includes('jar')
  ) {
    return { category: 'canned_preserved', confidence: 0.85 };
  }

  // Other beverages - confidence 0.8
  if (
    n.includes('スポーツ') || n.includes('エナジー') || n.includes('栄養') || n.includes('sports') ||
    n.includes('energy') || n.includes('isotonic')
  ) {
    return { category: 'beverages_other', confidence: 0.8 };
  }

  // Health supplements - confidence 0.85
  if (
    n.includes('サプリ') || n.includes('ビタミン') || n.includes('栄養補助') || n.includes('supplement') ||
    n.includes('vitamin') || n.includes('health')
  ) {
    return { category: 'health_supplements', confidence: 0.85 };
  }

  // Snacks & Sweets - confidence 0.85
  if (
    n.includes('チョコ') || n.includes('ビス') || n.includes('ビスケット') || n.includes('クッキー') ||
    n.includes('スナック') || n.includes('ナッツ') || n.includes('アイス') || n.includes('デザート') ||
    n.includes('菓子') || n.includes('chocolate') || n.includes('snack') || n.includes('cookie') ||
    n.includes('sweet') || n.includes('candy')
  ) {
    return { category: 'snacks_sweets', confidence: 0.85 };
  }

  // Non-alcoholic drinks - confidence 0.85
  if (
    n.includes('お茶') || n.includes('茶') || n.includes('コーヒー') || n.includes('coffee') ||
    n.includes('コーラ') || n.includes('ファンタ') || n.includes('ジュース') || n.includes('drink') ||
    n.includes('水') || n.includes('tea') || n.includes('juice')
  ) {
    return { category: 'non_alcoholic_drinks', confidence: 0.85 };
  }

  // Alcohol - confidence 0.9
  if (
    n.includes('ビール') || n.includes('酒') || n.includes('ワイン') || n.includes('日本酒') ||
    n.includes('焼酎') || n.includes('beer') || n.includes('wine') || n.includes('sake') ||
    n.includes('alcohol')
  ) {
    return { category: 'alcohol', confidence: 0.9 };
  }

  // Condiments - confidence 0.85
  if (
    n.includes('醤油') || n.includes('味噌') || n.includes('塩') || n.includes('砂糖') ||
    n.includes('油') || n.includes('ソース') || n.includes('sauce') || n.includes('soy') ||
    n.includes('salt') || n.includes('sugar')
  ) {
    return { category: 'condiments', confidence: 0.85 };
  }

  // Household - confidence 0.85
  if (
    n.includes('紙') || n.includes('ティッシュ') || n.includes('洗剤') || n.includes('シャンプー') ||
    n.includes('歯磨き') || n.includes('タオル') || n.includes('household') || n.includes('tissue') ||
    n.includes('shampoo')
  ) {
    return { category: 'household', confidence: 0.85 };
  }

  return null;
}

/**
 * AI classification via Supabase Edge Function
 */
async function classifyByAI(
  rawName: string,
  normalizedName: string,
  merchantName?: string
): Promise<{ category: Category; confidence: number } | null> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();

  if (!supabaseUrl || !supabaseAnonKey) {
    return null; // Cannot use AI without Supabase config
  }

  try {
    const deviceId = await getDeviceId();
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
    const locale = getCurrentLocale();

    const edgeFunctionUrl = `${supabaseUrl}/functions/v1/classify-item`;

    const requestBody = {
      itemName: rawName,
      normalizedName,
      merchantName: merchantName || null,
      availableCategories: GROCERY_CATEGORIES,
      locale,
      deviceId,
      appVersion,
      platform,
    };

    const response = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${supabaseAnonKey}`,
        apikey: supabaseAnonKey,
        'x-device-id': deviceId,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      // If function doesn't exist (404), return null to fallback
      if (response.status === 404) {
        return null;
      }
      // Other errors: log but don't throw
      console.warn('[CategoryClassifier] AI classification failed:', response.status);
      return null;
    }

    const responseData = await response.json();
    
    if (responseData.success && responseData.category && responseData.confidence) {
      const category = responseData.category as string;
      const confidence = Number(responseData.confidence);
      
      // Validate category is in our list
      if (ALL_CATEGORIES.includes(category as Category) && confidence >= 0.6) {
        return { category: category as Category, confidence };
      }
    }

    return null;
  } catch (error: any) {
    // Network errors: silently fallback
    if (__DEV__) {
      console.warn('[CategoryClassifier] AI classification error:', error.message);
    }
    return null;
  }
}

/**
 * Main classification function
 */
export async function classifyItem(input: ClassifyInput): Promise<ClassificationResult> {
  const { rawName, normalizedName: providedNormalizedName, merchantName, price, locale } = input;

  // Normalize product name if not provided
  const normalized = providedNormalizedName
    ? { normalizedName: providedNormalizedName.toLowerCase() }
    : normalizeProductName(rawName);
  
  const normalizedName = normalized.normalizedName;
  const merchantHint = merchantName ? normalizeMerchantName(merchantName) : null;

  if (!normalizedName) {
    return {
      categoryId: 'other_grocery',
      confidence: 0.0,
      source: 'fallback',
      reason: 'Empty normalized name',
    };
  }

  // 1. Local mapping (highest priority)
  const learnedCategory = await getLearnedCategory(normalizedName, merchantHint);
  if (learnedCategory && ALL_CATEGORIES.includes(learnedCategory as Category)) {
    if (classificationStats) classificationStats.mapping++;
    return {
      categoryId: learnedCategory as Category,
      confidence: 1.0,
      source: 'mapping',
      reason: 'Local mapping match',
    };
  }

  // 2. Rule-based matching
  const ruleResult = classifyByRules(rawName);
  if (ruleResult && ruleResult.confidence >= 0.8) {
    if (classificationStats) classificationStats.rules++;
    
    // Auto-learn high-confidence rule matches (>= 0.85)
    if (ruleResult.confidence >= 0.85) {
      await learnCategoryMapping(normalizedName, merchantHint, ruleResult.category, ruleResult.confidence);
    }
    
    return {
      categoryId: ruleResult.category,
      confidence: ruleResult.confidence,
      source: 'rules',
      reason: 'Rule-based match',
    };
  }

  // 3. AI fallback (only for uncertain items)
  const aiResult = await classifyByAI(rawName, normalizedName, merchantName);
  if (aiResult && aiResult.confidence >= 0.6) {
    if (classificationStats) classificationStats.ai++;
    
    // Auto-learn high-confidence AI matches (>= 0.85)
    if (aiResult.confidence >= 0.85) {
      await learnCategoryMapping(normalizedName, merchantHint, aiResult.category, aiResult.confidence);
    }
    
    return {
      categoryId: aiResult.category,
      confidence: aiResult.confidence,
      source: 'ai',
      reason: 'AI classification',
    };
  }

  // 4. Fallback
  if (classificationStats) classificationStats.fallback++;
  return {
    categoryId: 'other_grocery',
    confidence: 0.0,
    source: 'fallback',
    reason: 'No match found',
  };
}
