// lib/categoryClassifier.ts
// Unified category classification service (rules-first + local mapping + AI fallback)
// Strategy: mapping (priority) -> rules -> ai -> fallback

import type { Category } from './categories';
import { ALL_CATEGORIES } from './categories';
import { getLearnedCategory, learnCategoryMapping } from './categoryLearner';
import { normalizeMerchantName } from './productNormalizer';
import { getCategoryAiItemCap } from './env';
import type { AnalysisTag, MainCategory, SubCategory } from './categoryTaxonomyV1';
import { mapLegacyCategoryToV1, mapV1ToLegacyCategory } from './categoryTaxonomyV1';
import { matchItemRule } from './itemRulesV1';
import { lookupProductDictionary } from './productDictionary';
import {
  classifyViaEdgeFunction,
  getLastClassifyError,
  type AiClassifyInput,
} from './categoryAiClient';

export type ClassifyInput = {
  rawName: string;
  normalizedName: string;
  /** Expanded / canonical string for rules + dictionary + AI input (same as normalized when no alias) */
  canonicalName: string;
  merchantName?: string;
  price?: number;
  locale?: string;
  /**
   * 是否允许在本次分类中调用 classify-item Edge Function（逐个商品 AI 慢路径）。
   * 默认 false：主扫描流程不再逐项调用 AI（旧 ID 污染 + 3.5s 超时导致审核页延迟）。
   * 仅当显式传 true（如离线批量重算）时才会走 AI fallback。
   */
  allowAi?: boolean;
};

export type ClassifyOutput = {
  // Legacy single-level category id (kept for compatibility with existing UI/analytics)
  categoryId: string;
  confidence: number;
  source: 'alias' | 'dictionary' | 'mapping' | 'rules' | 'ai' | 'fallback';
  reason?: string;
  // V1 main/sub/tags (preferred for new pipeline)
  category_main?: MainCategory;
  category_sub?: SubCategory | null;
  analysis_tags?: AnalysisTag[];
  canonical_name?: string | null;
  brand?: string | null;
};

// Classification statistics (per receipt)
let classificationStats: {
  alias: number;
  dictionary: number;
  mapping: number;
  rules: number;
  ai: number;
  fallback: number;
} | null = null;

/**
 * Reset classification statistics (call at start of each receipt)
 */
export function resetClassificationStats(): void {
  classificationStats = { alias: 0, dictionary: 0, mapping: 0, rules: 0, ai: 0, fallback: 0 };
}

/**
 * Get classification statistics (call after processing all items)
 */
export function getClassificationStats(): {
  alias: number;
  dictionary: number;
  mapping: number;
  rules: number;
  ai: number;
  fallback: number;
} | null {
  return classificationStats;
}

/** Call when product_name_alias hits (outside classifyItem) */
export function noteAliasClassificationHit(): void {
  if (classificationStats) classificationStats.alias++;
}

/** Per-receipt API failure count; skip API for rest of receipt when >= threshold */
const RECEIPT_API_FAILURE_THRESHOLD = 5;
let receiptConsecutiveApiFailures = 0;

/** Per-receipt AI call cap; rest use rules/cache/fallback to avoid burst concurrency */
const RECEIPT_AI_CALL_CAP = getCategoryAiItemCap();
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
function classifyByRulesV1(
  rawName: string,
  normalizedName: string,
  merchantName?: string
): { v1: { category_main: MainCategory; category_sub: SubCategory | null; analysis_tags: AnalysisTag[] }; legacy: Category; confidence: number; reason: string } | null {
  const m = matchItemRule({ raw_name: rawName, normalized_name: normalizedName, merchantName });
  if (!m) return null;
  const v1 = { category_main: m.main, category_sub: m.sub, analysis_tags: m.tags };
  const legacy = mapV1ToLegacyCategory({ main: m.main, sub: m.sub }) as Category;
  return { v1, legacy, confidence: m.confidence, reason: m.reason };
}

/**
 * Main classification function
 * Strategy: mapping (priority) -> rules -> fallback
 */
export async function classifyItem(input: ClassifyInput): Promise<ClassifyOutput> {
  const { rawName, normalizedName, merchantName, canonicalName } = input;

  if (!normalizedName || !rawName) {
    if (classificationStats) classificationStats.fallback++;
    return {
      categoryId: 'uncategorized',
      confidence: 0.0,
      source: 'fallback',
      reason: 'Empty name',
    };
  }

  const normalized = normalizedName.toLowerCase();
  const canonical =
    (canonicalName && canonicalName.trim() ? canonicalName : normalizedName).trim().toLowerCase();
  const merchantHint = merchantName ? normalizeMerchantName(merchantName) : null;

  // 0. Product dictionary (highest priority)
  try {
    const hit = await lookupProductDictionary(canonical);
    if (hit?.category_main) {
      if (classificationStats) classificationStats.dictionary++;
      const legacy = mapV1ToLegacyCategory({ main: hit.category_main as any, sub: hit.category_sub as any }) as Category;
      return {
        categoryId: legacy,
        confidence: 1.0,
        source: 'dictionary',
        reason: 'Product dictionary match',
        category_main: hit.category_main as any,
        category_sub: hit.category_sub as any,
        analysis_tags: hit.analysis_tags as any,
        canonical_name: hit.canonical_name ?? null,
        brand: hit.brand ?? null,
      };
    }
  } catch {
    // degrade gracefully
  }

  // 1. Local mapping (highest priority)
  const learnedCategory = await getLearnedCategory(normalized, merchantHint);
  if (learnedCategory && ALL_CATEGORIES.includes(learnedCategory as Category)) {
    if (classificationStats) classificationStats.mapping++;
    const v1 = mapLegacyCategoryToV1(learnedCategory);
    return {
      categoryId: learnedCategory,
      confidence: 1.0,
      source: 'mapping',
      reason: 'Local mapping match',
      category_main: v1.main,
      category_sub: v1.sub,
      analysis_tags: undefined,
    };
  }

  // 2. Rule-based matching (rules-first). Only call API when rules miss.
  const ruleResult = classifyByRulesV1(rawName, canonical, merchantName);
  const cachedRule = ruleResult && ruleResult.confidence >= 0.7 ? ruleResult : null;

  if (ruleResult && ruleResult.confidence >= 0.8) {
    if (classificationStats) classificationStats.rules++;
    if (ruleResult.confidence >= 0.85) {
      const mh = merchantName ? normalizeMerchantName(merchantName) : '';
      await learnCategoryMapping(normalized, mh || null, ruleResult.legacy, ruleResult.confidence);
    }
    return {
      categoryId: ruleResult.legacy,
      confidence: ruleResult.confidence,
      source: 'rules',
      reason: ruleResult.reason,
      category_main: ruleResult.v1.category_main,
      category_sub: ruleResult.v1.category_sub,
      analysis_tags: ruleResult.v1.analysis_tags,
    };
  }

  const useRuleFallback = (r: typeof ruleResult) => {
    if (!r || r.confidence < 0.75) return null;
    if (classificationStats) classificationStats.rules++;
    return {
      categoryId: r.legacy,
      confidence: r.confidence,
      source: 'rules' as const,
      reason: `Fallback: ${r.reason}`,
      category_main: r.v1.category_main,
      category_sub: r.v1.category_sub,
      analysis_tags: r.v1.analysis_tags,
    };
  };

  const doFallback = () => {
    const fr = classifyByRulesV1(rawName, canonical, merchantName);
    const out = useRuleFallback(fr);
    if (out) return out;
    if (classificationStats) classificationStats.fallback++;
    // 本地学习/词典/规则/OCR 都未命中时返回 uncategorized（不再返回 other_grocery → other），
    // 让 resolveProductCategory 走商品名关键词或落到 uncategorized，避免 other 滥用。
    return { categoryId: 'uncategorized' as Category, confidence: 0.0, source: 'fallback' as const, reason: 'No match found' };
  };

  // 主扫描默认不调用逐项 AI 慢路径（input.allowAi 未显式置 true 即跳过）。
  const skipApi =
    !input.allowAi ||
    receiptConsecutiveApiFailures >= RECEIPT_API_FAILURE_THRESHOLD ||
    isCircuitBreakerOpen() ||
    receiptAiCallCount >= RECEIPT_AI_CALL_CAP;
  if (skipApi) {
    if (cachedRule) {
      if (classificationStats) classificationStats.rules++;
      return {
        categoryId: cachedRule.legacy,
        confidence: cachedRule.confidence,
        source: 'rules',
        reason: `Skip API (avalanche/cap): ${cachedRule.reason}`,
        category_main: cachedRule.v1.category_main,
        category_sub: cachedRule.v1.category_sub,
        analysis_tags: cachedRule.v1.analysis_tags,
      };
    }
    return doFallback();
  }

  receiptAiCallCount++;
  try {
    const aiInput: AiClassifyInput = {
      rawName,
      normalizedName: canonical,
      merchantName: merchantName || undefined,
      price: input.price,
      locale: input.locale,
    };
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
        const v1 = mapLegacyCategoryToV1(aiResult.categoryId);
        return {
          categoryId: aiResult.categoryId,
          confidence: aiResult.confidence,
          source: 'ai',
          reason: aiResult.reason || 'AI classification',
          category_main: v1.main,
          category_sub: v1.sub,
          analysis_tags: undefined,
        };
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
    return {
      categoryId: cachedRule.legacy,
      confidence: cachedRule.confidence,
      source: 'rules',
      reason: `API fail, kept rule: ${cachedRule.reason}`,
      category_main: cachedRule.v1.category_main,
      category_sub: cachedRule.v1.category_sub,
      analysis_tags: cachedRule.v1.analysis_tags,
    };
  }
  return doFallback();
}
