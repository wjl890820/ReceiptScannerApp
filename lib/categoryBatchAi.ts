// lib/categoryBatchAi.ts
// Batch AI fallback for product categorization.
//
// Design contract (see task spec):
//  - Only items that are STILL 'uncategorized' after local resolution are sent to AI.
//  - At most ONE classify-items request per receipt.
//  - AI may ONLY produce one of the new 8 ProductCategory values; legacy names
//    (meat_seafood / snacks_sweets / prepared_food / beverages / snacks / ingredients ...)
//    are rejected -> treated as 'uncategorized' (never mapped into a final category).
//  - confidence >= 0.75  -> apply as final category.
//  - 0.5 <= confidence < 0.75 -> keep 'uncategorized' but remember suggestedCategory.
//  - confidence < 0.5    -> keep 'uncategorized'.
//  - AI never overrides a non-uncategorized item (local learning / dictionary / rules win).
//  - Failures/timeouts only console.warn (no redbox), never block saving.

import { getSupabaseUrl, getSupabaseAnonKey, isJwtLike } from './env';
import { getCategoryBatchAiTimeoutMs, getCategoryBatchAiMaxItems } from './env';
import { getDeviceId } from './deviceId';
import { getCurrentLocale } from './i18n';
import { V1_ACTIVE_PRODUCT_CATEGORIES, type ProductCategory } from './productCategory';
import { stampMachineClassificationProvenance } from './productTaxonomy';
import { mapLegacyCategoryToV1, buildAnalysisTags } from './categoryTaxonomyV1';

export const BATCH_AI_APPLY_THRESHOLD = 0.75;
export const BATCH_AI_SUGGEST_THRESHOLD = 0.5;

export type BatchAiInputItem = {
  index: number;
  rawName: string;
  normalizedName?: string;
};

export type BatchAiResultItem = {
  index: number;
  category: string;
  confidence: number;
  reason?: string;
};

export type RunBatchAiOptions = {
  merchantName?: string;
  locale?: string;
};

export type BatchAiDeps = {
  /** Injectable network call (for tests). Defaults to classifyItemsBatch. */
  classify?: (
    items: BatchAiInputItem[],
    opts: RunBatchAiOptions
  ) => Promise<BatchAiResultItem[] | null>;
  /** Injectable clock (for deterministic suggestedAt in tests). */
  now?: () => number;
};

export type RunBatchAiResult = {
  /** Whether a classify-items request was attempted (i.e. there were uncategorized items). */
  called: boolean;
  /** Number of items whose final category was changed by AI. */
  appliedCount: number;
  /** Number of items that received a suggestedCategory (0.5–0.75 band). */
  suggestedCount: number;
};

const V1_ACTIVE_WRITE_SET = new Set<string>(
  (V1_ACTIVE_PRODUCT_CATEGORIES as readonly string[]).filter((c) => c !== 'uncategorized')
);

/**
 * 严格校验 AI 返回的分类：必须是 V1 spending 类之一（含 personal_care/pet_care，不含 uncategorized）。
 * 旧分类名 → 返回 null（即拒绝），由调用方按 uncategorized 处理。
 */
export function sanitizeAiCategory(raw: unknown): ProductCategory | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!V1_ACTIVE_WRITE_SET.has(v)) return null;
  return v as ProductCategory;
}

export type AiDecision =
  | { action: 'apply'; category: ProductCategory; confidence: number }
  | { action: 'suggest'; category: ProductCategory; confidence: number }
  | { action: 'keep' };

/**
 * 根据 AI 分类 + 置信度决定动作。
 * 'other' 是合法新 8 类，可被应用/建议；旧分类与 uncategorized 一律 keep。
 */
export function decideFromAi(category: unknown, confidence: unknown): AiDecision {
  const cat = sanitizeAiCategory(category);
  const conf = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0;
  if (!cat) return { action: 'keep' };
  if (conf >= BATCH_AI_APPLY_THRESHOLD) return { action: 'apply', category: cat, confidence: conf };
  if (conf >= BATCH_AI_SUGGEST_THRESHOLD) return { action: 'suggest', category: cat, confidence: conf };
  return { action: 'keep' };
}

/**
 * 选出仍为 'uncategorized' 的商品（本地学习/词典/规则/关键词都没命中）。
 * index 为其在 items 数组中的下标，最多返回 maxItems 条。
 */
export function selectUncategorizedItems(
  items: any[],
  maxItems: number = getCategoryBatchAiMaxItems()
): BatchAiInputItem[] {
  const out: BatchAiInputItem[] = [];
  if (!Array.isArray(items)) return out;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    if (it.category !== 'uncategorized') continue;
    const rawName =
      (typeof it.name === 'string' && it.name) ||
      (typeof it.raw_name === 'string' && it.raw_name) ||
      (typeof it.normalized_name === 'string' && it.normalized_name) ||
      '';
    if (!rawName.trim()) continue;
    out.push({
      index: i,
      rawName,
      normalizedName: typeof it.normalized_name === 'string' ? it.normalized_name : undefined,
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * 将 AI 批量结果应用到 items（就地修改）。
 * 关键保护：仅当 items[index].category === 'uncategorized' 时才考虑应用 ——
 * 绝不覆盖用户学习 / 本地词典 / 本地规则得到的非 uncategorized 分类。
 */
export function applyBatchAiResults(
  items: any[],
  results: BatchAiResultItem[] | null | undefined,
  deps?: Pick<BatchAiDeps, 'now'>
): { appliedCount: number; suggestedCount: number } {
  let appliedCount = 0;
  let suggestedCount = 0;
  if (!Array.isArray(items) || !Array.isArray(results)) {
    return { appliedCount, suggestedCount };
  }
  const now = deps?.now ?? Date.now;

  for (const r of results) {
    const idx = Number(r?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) continue;
    const item = items[idx];
    if (!item || item.category !== 'uncategorized') continue; // 本地结果优先，绝不覆盖

    const decision = decideFromAi(r?.category, r?.confidence);
    if (decision.action === 'apply') {
      const v1 = mapLegacyCategoryToV1(decision.category);
      item.category = decision.category;
      item.classification_status = 'ok';
      item.classification_confidence = decision.confidence;
      Object.assign(item, stampMachineClassificationProvenance('ai_batch'));
      item.classification = {
        category: decision.category,
        status: 'ok',
        confidence: decision.confidence,
      };
      item.category_main = v1.main;
      item.category_sub = v1.sub;
      item.analysis_tags = buildAnalysisTags(v1);
      // 应用后清除任何残留建议
      if ('suggestedCategory' in item) item.suggestedCategory = null;
      if ('suggestedConfidence' in item) item.suggestedConfidence = null;
      appliedCount++;
    } else if (decision.action === 'suggest') {
      // 保持 uncategorized，仅记录建议，供审核页展示/一键采纳
      item.suggestedCategory = decision.category;
      item.suggestedConfidence = decision.confidence;
      item.suggestedSource = 'ai_batch';
      item.suggestedAt = now();
      suggestedCount++;
    }
    // keep: 不做任何修改
  }
  return { appliedCount, suggestedCount };
}

/**
 * 网络层：对 classify-items Edge Function 发起“单次”批量请求。
 * 失败/超时/无配置一律返回 null，并 console.warn（绝不抛错 / 红屏）。
 */
export async function classifyItemsBatch(
  items: BatchAiInputItem[],
  opts: RunBatchAiOptions
): Promise<BatchAiResultItem[] | null> {
  if (!Array.isArray(items) || items.length === 0) return null;

  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();
  if (!supabaseUrl || !supabaseAnonKey || !isJwtLike(supabaseAnonKey)) {
    if (__DEV__) console.warn('[CategoryBatchAI] missing/invalid Supabase config, skip batch AI');
    return null;
  }

  const url = `${supabaseUrl}/functions/v1/classify-items`;
  const timeoutMs = getCategoryBatchAiTimeoutMs();
  const requestId = `app-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startMs = Date.now();

  try {
    const deviceId = await getDeviceId();
    const locale = opts.locale || getCurrentLocale();
    const body = {
      items: items.map((it) => ({
        index: it.index,
        rawName: it.rawName,
        normalizedName: it.normalizedName || null,
      })),
      merchantName: opts.merchantName || null,
      locale,
    };

    if (__DEV__) {
      console.log('[CategoryBatchAI] classify-items request', {
        url,
        requestId,
        itemCount: items.length,
        timeoutMs,
      });
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        'x-device-id': deviceId,
        'x-client': 'app',
        'x-request-id': requestId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      // 失败响应仍是 JSON（success:false）；HTTP 非 2xx 一律 no-op，保持 uncategorized。
      if (__DEV__) {
        let snippet = '';
        try {
          snippet = (await response.text()).slice(0, 160);
        } catch {
          /* ignore */
        }
        console.warn('[CategoryBatchAI] classify-items non-2xx', {
          status: response.status,
          body: snippet,
        });
      }
      return null;
    }

    let data: any;
    try {
      data = await response.json();
    } catch (parseError: any) {
      if (__DEV__) {
        console.warn(`[CategoryBatchAI] classify-items JSON parse error: ${parseError?.message || ''}`);
      }
      return null;
    }

    // 即便 HTTP 2xx，若 success===false 也视为失败 → no-op。
    if (!data || data.success === false) {
      if (__DEV__) {
        console.warn('[CategoryBatchAI] classify-items returned success:false', {
          code: data?.error?.code,
          message: data?.error?.message,
        });
      }
      return null;
    }

    const rawResults = Array.isArray(data?.results) ? data.results : [];
    const results: BatchAiResultItem[] = rawResults
      .map((r: any) => ({
        index: Number(r?.index),
        category: typeof r?.categoryId === 'string' ? r.categoryId : '',
        confidence: typeof r?.confidence === 'number' ? r.confidence : Number(r?.confidence),
        reason: typeof r?.reason === 'string' ? r.reason : undefined,
      }))
      .filter((r: BatchAiResultItem) => Number.isInteger(r.index));

    if (__DEV__) {
      console.log('[CategoryBatchAI] classify-items response', {
        requestId,
        elapsedMs: Date.now() - startMs,
        resultCount: results.length,
      });
    }
    return results;
  } catch (error: any) {
    clearTimeout(timeoutId);
    const isTimeout = error?.name === 'AbortError';
    if (__DEV__) {
      console.warn(
        `[CategoryBatchAI] classify-items ${isTimeout ? 'timeout' : 'failed'}: ${error?.message || ''}`
      );
    }
    return null;
  }
}

/**
 * 编排：选出 uncategorized → 单次批量请求 → 应用结果。
 * - 没有 uncategorized 商品时不发请求（called:false）。
 * - 任何失败都不影响 items（保持 uncategorized），不抛错。
 */
export async function runBatchAiFallback(
  items: any[],
  opts: RunBatchAiOptions = {},
  deps?: BatchAiDeps
): Promise<RunBatchAiResult> {
  const selected = selectUncategorizedItems(items);
  if (selected.length === 0) {
    return { called: false, appliedCount: 0, suggestedCount: 0 };
  }
  const classify = deps?.classify ?? classifyItemsBatch;
  let results: BatchAiResultItem[] | null = null;
  try {
    results = await classify(selected, opts);
  } catch (error: any) {
    // 双保险：网络层已吞错，这里再兜底一次，绝不冒泡。
    if (__DEV__) console.warn(`[CategoryBatchAI] runBatchAiFallback error: ${error?.message || ''}`);
    results = null;
  }
  if (!results) {
    return { called: true, appliedCount: 0, suggestedCount: 0 };
  }
  const { appliedCount, suggestedCount } = applyBatchAiResults(items, results, { now: deps?.now });
  return { called: true, appliedCount, suggestedCount };
}
