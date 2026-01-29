// lib/categoryClassifier.ts
// Unified category classification service (rules-first + local mapping + AI fallback)
// Strategy: mapping (priority) -> rules -> ai -> fallback

import type { Category } from './categories';
import { ALL_CATEGORIES } from './categories';
import { getLearnedCategory, learnCategoryMapping } from './categoryLearner';
import { normalizeMerchantName } from './productNormalizer';
import {
  classifyViaEdgeFunction,
  getLastClassifyError,
  type AiClassifyInput,
} from './categoryAiClient';

export type ClassifyInput = {
  rawName: string;
  normalizedName: string;
  merchantName?: string;
  price?: number;
  locale?: string;
};

export type ClassifyOutput = {
  categoryId: string;
  confidence: number;
  source: 'mapping' | 'rules' | 'ai' | 'fallback';
  reason?: string;
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

/** Per-receipt API failure count; skip API for rest of receipt when >= threshold */
const RECEIPT_API_FAILURE_THRESHOLD = 5;
let receiptConsecutiveApiFailures = 0;

/** Per-receipt AI call cap; rest use rules/cache/fallback to avoid burst concurrency */
const RECEIPT_AI_CALL_CAP = 10;
let receiptAiCallCount = 0;

/**
 * Call at start of each receipt (before processing items).
 * Resets per-receipt consecutive API failure count and AI call count.
 */
export function startReceiptClassification(): void {
  receiptConsecutiveApiFailures = 0;
  receiptAiCallCount = 0;
}

// Circuit breaker state (in-memory singleton)
type CircuitBreakerState = {
  consecutiveFailures: number;
  blockedUntil: number; // ms timestamp
  lastLogKey: string | null;
};

let circuitBreaker: CircuitBreakerState = {
  consecutiveFailures: 0,
  blockedUntil: 0,
  lastLogKey: null,
};

/**
 * Check if circuit breaker allows AI call
 */
function isCircuitBreakerOpen(): boolean {
  const now = Date.now();
  if (circuitBreaker.blockedUntil > now) {
    return true; // Circuit is open (blocked)
  }
  return false; // Circuit is closed (allowed)
}

/**
 * Record AI failure in circuit breaker
 */
function recordAiFailure(): void {
  circuitBreaker.consecutiveFailures++;
  
  // If 3 or more consecutive failures, block for 10 minutes
  if (circuitBreaker.consecutiveFailures >= 3) {
    circuitBreaker.blockedUntil = Date.now() + 10 * 60 * 1000; // 10 minutes
    const logKey = 'circuit-breaker-open';
    if (circuitBreaker.lastLogKey !== logKey) {
      circuitBreaker.lastLogKey = logKey;
      if (__DEV__) {
        console.warn('[CategoryClassifier] Circuit breaker opened: too many AI failures, blocking for 10 minutes');
      }
    }
  }
}

/**
 * Record AI success in circuit breaker
 */
function recordAiSuccess(): void {
  circuitBreaker.consecutiveFailures = 0;
  circuitBreaker.blockedUntil = 0;
  circuitBreaker.lastLogKey = null;
}

/**
 * Rule-based category inference with merchant hints
 * Returns category with confidence 0.8~0.95 and a short reason
 */
function classifyByRules(
  name: string,
  merchantName?: string
): { category: Category; confidence: number; reason: string } | null {
  const n = (name || '').toLowerCase();

  // Dairy & Eggs - confidence 0.9 (check before meat to avoid "牛乳" matching "牛")
  if (
    n.includes('牛乳') || n.includes('ミルク') || n.includes('チーズ') || n.includes('ヨーグルト') ||
    n.includes('バター') || n.includes('卵') || n.includes('たまご') || n.includes('タマゴ') ||
    n.includes('milk') || n.includes('cheese') || n.includes('yogurt') || n.includes('butter') ||
    n.includes('egg')
  ) {
    return { category: 'dairy_eggs', confidence: 0.9, reason: 'Dairy/eggs keywords' };
  }

  // Produce (vegetables/fruits) - confidence 0.9
  if (
    n.includes('野菜') || n.includes('白菜') || n.includes('ねぎ') || n.includes('えのき') ||
    n.includes('茸') || n.includes('椎茸') || n.includes('果物') || n.includes('りんご') ||
    n.includes('みかん') || n.includes('バナナ') || n.includes('にんにく') || n.includes('ニンニク') ||
    n.includes('vegetable') || n.includes('fruit')
  ) {
    return { category: 'produce', confidence: 0.9, reason: 'Produce keywords' };
  }

  // Meat & Seafood - confidence 0.9 (check after dairy to avoid "牛乳" matching "牛")
  if (
    n.includes('牛') || n.includes('豚') || n.includes('鶏') || n.includes('とり') ||
    n.includes('チキン') || n.includes('魚') || n.includes('刺身') || n.includes('meat') ||
    n.includes('fish') || n.includes('chicken') || n.includes('beef') || n.includes('pork') ||
    n.includes('seafood') || n.includes('ロティサリ') || n.includes('グリルド')
  ) {
    return { category: 'meat_seafood', confidence: 0.9, reason: 'Meat/seafood keywords' };
  }

  // Bakery - confidence 0.85
  if (
    n.includes('パン') || n.includes('ロール') || n.includes('クロワッサン') || n.includes('ケーキ') ||
    n.includes('ショコラパイ') || n.includes('今川焼') || n.includes('クレープ') ||
    n.includes('bread') || n.includes('pastry') || n.includes('croissant') || n.includes('cake')
  ) {
    return { category: 'bakery', confidence: 0.85, reason: 'Bakery keywords' };
  }

  // Staples - confidence 0.85
  if (
    n.includes('米') || n.includes('ご飯') || n.includes('うどん') || n.includes('そば') ||
    n.includes('ラーメン') || n.includes('パスタ') || n.includes('ヌードル') || n.includes('シンヌードル') ||
    n.includes('rice') || n.includes('noodle') || n.includes('bean') || n.includes('豆')
  ) {
    return { category: 'staples', confidence: 0.85, reason: 'Staples keywords' };
  }

  // Quick meals - confidence 0.8
  if (
    n.includes('弁当') || n.includes('おにぎり') || n.includes('惣菜') || n.includes('天') ||
    n.includes('揚げ') || n.includes('からあげ') || n.includes('唐揚') || n.includes('フライ') ||
    n.includes('コロッケ') || n.includes('とり天') || n.includes('鍋') || n.includes('きりたんぽ') ||
    n.includes('薄焼き餅') || n.includes('餅') || n.includes('生煎包') || n.includes('bento') ||
    n.includes('ready') || n.includes('instant')
  ) {
    return { category: 'quick_meals', confidence: 0.8, reason: 'Quick meals keywords' };
  }

  // Frozen foods - confidence 0.9
  if (n.includes('冷凍') || n.includes('冷凍食品') || n.includes('frozen') || n.includes('freezer')) {
    return { category: 'frozen_foods', confidence: 0.9, reason: 'Frozen keywords' };
  }

  // Canned and preserved - confidence 0.85
  if (
    n.includes('缶詰') || n.includes('瓶詰') || n.includes('保存食') || n.includes('canned') ||
    n.includes('preserved') || n.includes('jar')
  ) {
    return { category: 'canned_preserved', confidence: 0.85, reason: 'Canned/preserved keywords' };
  }

  // Other beverages - confidence 0.8
  if (
    n.includes('スポーツ') || n.includes('エナジー') || n.includes('栄養') || n.includes('sports') ||
    n.includes('energy') || n.includes('isotonic')
  ) {
    return { category: 'beverages_other', confidence: 0.8, reason: 'Other beverages keywords' };
  }

  // Health supplements - confidence 0.85
  if (
    n.includes('サプリ') || n.includes('ビタミン') || n.includes('栄養補助') || n.includes('supplement') ||
    n.includes('vitamin') || n.includes('health')
  ) {
    return { category: 'health_supplements', confidence: 0.85, reason: 'Health supplements keywords' };
  }

  // Snacks & Sweets - confidence 0.85
  if (
    n.includes('チョコ') || n.includes('ビス') || n.includes('ビスケット') || n.includes('クッキー') ||
    n.includes('スナック') || n.includes('ナッツ') || n.includes('落花生') || n.includes('アイス') ||
    n.includes('デザート') || n.includes('菓子') || n.includes('オレオ') || n.includes('プレッツェル') ||
    n.includes('ドーナツ') || n.includes('エクレア') || n.includes('あずきバー') || n.includes('シリアルバー') ||
    n.includes('pretzel') || n.includes('chocolate') || n.includes('snack') || n.includes('cookie') ||
    n.includes('sweet') || n.includes('candy')
  ) {
    return { category: 'snacks_sweets', confidence: 0.85, reason: 'Snacks/sweets keywords' };
  }

  // Non-alcoholic drinks - confidence 0.85
  if (
    n.includes('お茶') || n.includes('茶') || n.includes('コーヒー') || n.includes('coffee') ||
    n.includes('コーラ') || n.includes('ファンタ') || n.includes('ジュース') || n.includes('ネクター') ||
    n.includes('マンゴー') || n.includes('drink') || n.includes('水') || n.includes('tea') ||
    n.includes('juice')
  ) {
    return { category: 'non_alcoholic_drinks', confidence: 0.85, reason: 'Non-alcoholic drinks keywords' };
  }

  // Alcohol - confidence 0.9
  if (
    n.includes('ビール') || n.includes('酒') || n.includes('ワイン') || n.includes('日本酒') ||
    n.includes('焼酎') || n.includes('beer') || n.includes('wine') || n.includes('sake') ||
    n.includes('alcohol')
  ) {
    return { category: 'alcohol', confidence: 0.9, reason: 'Alcohol keywords' };
  }

  // Condiments - confidence 0.85
  if (
    n.includes('醤油') || n.includes('味噌') || n.includes('塩') || n.includes('砂糖') ||
    n.includes('油') || n.includes('オイル') || n.includes('ソース') || n.includes('酢') ||
    n.includes('陈酢') || n.includes('ごま') || n.includes('ゴマ') || n.includes('ターメリック') ||
    n.includes('sauce') || n.includes('soy') || n.includes('salt') || n.includes('sugar')
  ) {
    return { category: 'condiments', confidence: 0.85, reason: 'Condiments keywords' };
  }

  // Household - confidence 0.85
  if (
    n.includes('紙') || n.includes('ティッシュ') || n.includes('洗剤') || n.includes('シャンプー') ||
    n.includes('歯磨き') || n.includes('タオル') || n.includes('household') || n.includes('tissue') ||
    n.includes('shampoo')
  ) {
    return { category: 'household', confidence: 0.85, reason: 'Household keywords' };
  }

  // Merchant-based weak hints (lower confidence, only if no direct match)
  if (merchantName) {
    const merchantLower = merchantName.toLowerCase();
    
    // ドラッグストア (drugstore) -> more likely household/health
    if (merchantLower.includes('ドラッグ') || merchantLower.includes('drugstore') || 
        merchantLower.includes('薬局') || merchantLower.includes('pharmacy')) {
      // If name has no strong category signal, suggest household
      return { category: 'household', confidence: 0.75, reason: 'Drugstore merchant hint' };
    }
    
    // コンビニ (convenience store) -> more likely snacks/drinks/quick meals
    if (merchantLower.includes('コンビニ') || merchantLower.includes('convenience') ||
        merchantLower.includes('セブン') || merchantLower.includes('ファミマ') ||
        merchantLower.includes('ローソン') || merchantLower.includes('7-11') ||
        merchantLower.includes('family mart') || merchantLower.includes('lawson')) {
      // If name has no strong category signal, suggest snacks or drinks
      if (n.includes('飲') || n.includes('drink') || n.includes('コーヒー') || n.includes('tea')) {
        return { category: 'non_alcoholic_drinks', confidence: 0.75, reason: 'Convenience store + drink hint' };
      }
      return { category: 'snacks_sweets', confidence: 0.75, reason: 'Convenience store merchant hint' };
    }

    // Costco / コストコ -> bulk retail, often snacks / household; use snacks as weak hint
    if (merchantLower.includes('costco') || merchantLower.includes('コストコ')) {
      return { category: 'snacks_sweets', confidence: 0.75, reason: 'Costco merchant hint' };
    }

    // ヨークベニマル / ベニマル, 業務スーパー -> supermarket with many baked/snacks; weak hint
    if (merchantLower.includes('ベニマル') || merchantLower.includes('benimaru') ||
        merchantLower.includes('業務スーパー') || merchantLower.includes('gyomu')) {
      return { category: 'snacks_sweets', confidence: 0.75, reason: 'Supermarket merchant hint' };
    }
    
    // スーパー (supermarket) -> more likely produce/meat/dairy
    if (merchantLower.includes('スーパー') || merchantLower.includes('supermarket') ||
        merchantLower.includes('マルエツ') || merchantLower.includes('イオン') ||
        merchantLower.includes('aeon') || merchantLower.includes('maruetsu')) {
      // Weak hint, only if no other match
      return null; // Let other rules take precedence
    }
  }

  return null;
}

/**
 * Main classification function
 * Strategy: mapping (priority) -> rules -> fallback
 */
export async function classifyItem(input: ClassifyInput): Promise<ClassifyOutput> {
  const { rawName, normalizedName, merchantName } = input;

  if (!normalizedName || !rawName) {
    if (classificationStats) classificationStats.fallback++;
    return {
      categoryId: 'other_grocery',
      confidence: 0.0,
      source: 'fallback',
      reason: 'Empty name',
    };
  }

  const normalized = normalizedName.toLowerCase();
  const merchantHint = merchantName ? normalizeMerchantName(merchantName) : null;

  // 1. Local mapping (highest priority)
  const learnedCategory = await getLearnedCategory(normalized, merchantHint);
  if (learnedCategory && ALL_CATEGORIES.includes(learnedCategory as Category)) {
    if (classificationStats) classificationStats.mapping++;
    return {
      categoryId: learnedCategory,
      confidence: 1.0,
      source: 'mapping',
      reason: 'Local mapping match',
    };
  }

  // 2. Rule-based matching (rules-first). Only call API when rules miss.
  const ruleResult = classifyByRules(rawName, merchantName);
  const cachedRule = ruleResult && ruleResult.confidence >= 0.7 ? ruleResult : null;

  if (ruleResult && ruleResult.confidence >= 0.8) {
    if (classificationStats) classificationStats.rules++;
    if (ruleResult.confidence >= 0.85) {
      const mh = merchantName ? normalizeMerchantName(merchantName) : '';
      await learnCategoryMapping(normalized, mh || null, ruleResult.category, ruleResult.confidence);
    }
    return { categoryId: ruleResult.category, confidence: ruleResult.confidence, source: 'rules', reason: ruleResult.reason };
  }

  const useRuleFallback = (r: typeof ruleResult) => {
    if (!r || r.confidence < 0.75) return null;
    if (classificationStats) classificationStats.rules++;
    return { categoryId: r.category, confidence: r.confidence, source: 'rules' as const, reason: `Fallback: ${r.reason}` };
  };

  const doFallback = () => {
    const fr = classifyByRules(rawName, merchantName);
    const out = useRuleFallback(fr);
    if (out) return out;
    if (classificationStats) classificationStats.fallback++;
    return { categoryId: 'other_grocery' as Category, confidence: 0.0, source: 'fallback' as const, reason: 'No match found' };
  };

  const skipApi =
    receiptConsecutiveApiFailures >= RECEIPT_API_FAILURE_THRESHOLD ||
    isCircuitBreakerOpen() ||
    receiptAiCallCount >= RECEIPT_AI_CALL_CAP;
  if (skipApi) {
    if (cachedRule) {
      if (classificationStats) classificationStats.rules++;
      return { categoryId: cachedRule.category, confidence: cachedRule.confidence, source: 'rules', reason: `Skip API (avalanche/cap): ${cachedRule.reason}` };
    }
    return doFallback();
  }

  receiptAiCallCount++;
  try {
    const aiInput: AiClassifyInput = { rawName, normalizedName: normalized, merchantName: merchantName || undefined, price: input.price, locale: input.locale };
    const aiResult = await classifyViaEdgeFunction(aiInput);

    if (aiResult) {
      const valid =
        aiResult.categoryId && typeof aiResult.categoryId === 'string' && aiResult.categoryId.trim() !== '' &&
        ALL_CATEGORIES.includes(aiResult.categoryId as Category) &&
        typeof aiResult.confidence === 'number' && Number.isFinite(aiResult.confidence) &&
        aiResult.confidence >= 0.6 && aiResult.confidence <= 1.0;
      if (valid) {
        recordAiSuccess();
        receiptConsecutiveApiFailures = 0;
        if (classificationStats) classificationStats.ai++;
        const mh = merchantName ? normalizeMerchantName(merchantName) : '';
        await learnCategoryMapping(normalized, mh || null, aiResult.categoryId, aiResult.confidence);
        return { categoryId: aiResult.categoryId, confidence: aiResult.confidence, source: 'ai', reason: aiResult.reason || 'AI classification' };
      }
      recordAiFailure();
      receiptConsecutiveApiFailures++;
    } else {
      recordAiFailure();
      receiptConsecutiveApiFailures++;
      const err = getLastClassifyError();
      if (__DEV__ && err) console.warn('[CategoryClassifier] API failed, using rule fallback:', { rawName, code: err.code, message: err.message });
    }
  } catch (e: any) {
    recordAiFailure();
    receiptConsecutiveApiFailures++;
    if (__DEV__) console.warn('[CategoryClassifier] API error:', e?.message);
  }

  if (cachedRule) {
    if (classificationStats) classificationStats.rules++;
    return { categoryId: cachedRule.category, confidence: cachedRule.confidence, source: 'rules', reason: `API fail, kept rule: ${cachedRule.reason}` };
  }
  return doFallback();
}
