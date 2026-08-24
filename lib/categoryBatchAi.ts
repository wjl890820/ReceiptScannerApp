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
import {
  emptySemanticBatchCostMetrics,
  invalidateStaleSemanticCacheOnItem,
  selectBatchSemanticItems,
  type SemanticBatchCostMetrics,
} from './productIdentitySemanticBatch';
import {
  applySemanticEnrichmentEvidence,
  buildSemanticCacheRecord,
  buildSemanticInputFingerprint,
  type MerchantProductSemanticCache,
  type SemanticEnrichmentAiItem,
} from './productIdentitySemanticContract';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import type { ProductAttributes } from './productIdentityContract';

export const BATCH_AI_APPLY_THRESHOLD = 0.75;
export const BATCH_AI_SUGGEST_THRESHOLD = 0.5;

export type BatchAiInputItem = {
  index: number;
  rawName: string;
  normalizedName?: string;
  merchantName?: string | null;
  knownCategory?: string | null;
  knownFamily?: string | null;
  knownAttributes?: ProductAttributes | null;
  selectReasons?: Array<'uncategorized' | 'needs_enrichment'>;
};

export type BatchAiResultItem = {
  index: number;
  category: string;
  confidence: number;
  reason?: string;
  brand?: string | null;
  brandConfidence?: number | null;
  canonicalName?: string | null;
  canonicalNameConfidence?: number | null;
  productType?: string | null;
  semanticTags?: string[] | null;
  attributes?: SemanticEnrichmentAiItem['attributes'];
  janCode?: unknown;
  skuId?: unknown;
  barcode?: unknown;
};

export type RunBatchAiOptions = {
  merchantName?: string;
  locale?: string;
  modelVersion?: string | null;
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
  /** Whether a classify-items request was attempted. */
  called: boolean;
  /** Number of items whose final category was changed by AI. */
  appliedCount: number;
  /** Number of items that received a suggestedCategory (0.5–0.75 band). */
  suggestedCount: number;
  /** Batch 4 semantic enrichment metrics. */
  semantic: SemanticBatchCostMetrics;
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

/**
 * Batch 4 selection: uncategorized ∪ needsSemanticEnrichment, one cap, one request.
 */
export function selectBatchAiItems(
  items: any[],
  maxItems: number = getCategoryBatchAiMaxItems()
): BatchAiInputItem[] {
  return selectBatchSemanticItems(items, maxItems).map((it) => ({
    index: it.index,
    rawName: it.rawName,
    normalizedName: it.normalizedName,
    merchantName: it.merchantName,
    knownCategory: it.knownCategory,
    knownFamily: it.knownFamily,
    knownAttributes: it.knownAttributes,
    selectReasons: it.selectReasons,
  }));
}

/**
 * Apply semantic evidence as metadata only (never identity authority).
 */
export function applySemanticFieldsToItem(
  item: any,
  result: BatchAiResultItem,
  opts?: { modelVersion?: string | null }
): {
  appliedSemantic: boolean;
  suggestedSemantic: boolean;
  ignoredSemantic: boolean;
  cache: MerchantProductSemanticCache;
} {
  // Deterministic structural attrs must come from name parse / stored deterministic
  // snapshot — never from AI-merged product_attributes (that would poison fingerprints).
  const codeAttrs =
    (item?.deterministic_product_attributes as ProductAttributes | null | undefined) ??
    (typeof item?.name === 'string' && item.name.trim()
      ? normalizeProductForIdentity(item.name).attributes
      : (item?.product_attributes as ProductAttributes | null | undefined) ?? null);
  const aiItem: SemanticEnrichmentAiItem = {
    index: result.index,
    categoryId: result.category,
    categoryConfidence: result.confidence,
    brand: result.brand,
    brandConfidence: result.brandConfidence,
    canonicalName: result.canonicalName,
    canonicalNameConfidence: result.canonicalNameConfidence,
    productType: result.productType,
    semanticTags: result.semanticTags,
    attributes: result.attributes,
    confidence: result.confidence,
    reason: result.reason,
    janCode: result.janCode,
    skuId: result.skuId,
    barcode: result.barcode,
  };
  const applied = applySemanticEnrichmentEvidence(aiItem, codeAttrs);
  // Persist deterministic attrs separately so cache fingerprints never include AI merges.
  item.deterministic_product_attributes = codeAttrs;
  if (typeof item.merchant_key !== 'string' || !item.merchant_key.trim()) {
    if (typeof item.merchant_name === 'string' && item.merchant_name.trim()) {
      item.merchant_key = item.merchant_name.trim();
    } else if (typeof item.merchantName === 'string' && item.merchantName.trim()) {
      item.merchant_key = item.merchantName.trim();
    }
  }
  const inputFingerprint = buildSemanticInputFingerprint({
    rawName: String(item?.name ?? item?.raw_name ?? ''),
    merchantKey: typeof item?.merchant_key === 'string' ? item.merchant_key : null,
    attributes: codeAttrs,
    semanticResolverVersion: applied.semanticResolverVersion,
  });
  const cache = buildSemanticCacheRecord(applied, opts?.modelVersion ?? null, inputFingerprint);

  item.semantic_status = applied.status;
  item.semantic_confidence = applied.overallConfidence;
  item.semantic_resolver_version = applied.semanticResolverVersion;
  item.semantic_json = cache;
  item.semantic_conflicts = applied.conflicts;

  if (applied.appliedBrand && applied.brand) {
    if (!item.brand) item.brand = applied.brand;
  } else if (applied.suggestedBrand) {
    item.suggestedBrand = applied.suggestedBrand;
  }

  if (applied.appliedCanonicalName && applied.canonicalName) {
    item.suggested_canonical_name = applied.canonicalName;
    item.semantic_canonical_name = applied.canonicalName;
  } else if (applied.suggestedCanonicalName) {
    item.suggested_canonical_name = applied.suggestedCanonicalName;
  }

  if (applied.productType) item.semantic_product_type = applied.productType;
  if (applied.semanticTags.length) item.semantic_tags = applied.semanticTags;
  item.product_attributes = applied.attributes;

  if (item.identity_level === 'product_exact' && item.identity_source === 'semantic_enrichment') {
    item.identity_level = 'merchant_product';
  }
  if (result.janCode != null || result.skuId != null || result.barcode != null) {
    item.sku_id = null;
    item.jan_code = null;
  }

  const appliedSemantic =
    applied.appliedBrand ||
    applied.appliedCanonicalName ||
    applied.appliedAttributeCount > 0;
  const suggestedSemantic =
    !appliedSemantic &&
    (!!applied.suggestedBrand ||
      !!applied.suggestedCanonicalName ||
      applied.status === 'partial');
  const ignoredSemantic = !appliedSemantic && !suggestedSemantic;
  return { appliedSemantic, suggestedSemantic, ignoredSemantic, cache };
}

export function applyBatchAiResults(
  items: any[],
  results: BatchAiResultItem[] | null | undefined,
  deps?: Pick<BatchAiDeps, 'now'> & { modelVersion?: string | null }
): {
  appliedCount: number;
  suggestedCount: number;
  semantic: Pick<
    SemanticBatchCostMetrics,
    'semanticItemsApplied' | 'semanticItemsSuggested' | 'semanticItemsIgnored'
  >;
} {
  let appliedCount = 0;
  let suggestedCount = 0;
  let semanticItemsApplied = 0;
  let semanticItemsSuggested = 0;
  let semanticItemsIgnored = 0;
  if (!Array.isArray(items) || !Array.isArray(results)) {
    return {
      appliedCount,
      suggestedCount,
      semantic: { semanticItemsApplied, semanticItemsSuggested, semanticItemsIgnored },
    };
  }
  const now = deps?.now ?? Date.now;

  for (const r of results) {
    const idx = Number(r?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) continue;
    const item = items[idx];
    if (!item) continue;

    // Category mutation stays protected: only uncategorized items may receive
    // AI category apply/suggest. Semantic metadata may still apply when local
    // category already exists.
    if (item.category === 'uncategorized') {
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

    try {
      const hasSemanticPayload =
        r.brand != null ||
        r.canonicalName != null ||
        r.productType != null ||
        (Array.isArray(r.semanticTags) && r.semanticTags.length > 0) ||
        (Array.isArray(r.attributes) && r.attributes.length > 0) ||
        r.janCode != null ||
        r.skuId != null ||
        r.barcode != null;

      if (hasSemanticPayload || item.semantic_status === 'needs_enrichment') {
        const { appliedSemantic, suggestedSemantic, ignoredSemantic } =
          applySemanticFieldsToItem(item, r, { modelVersion: deps?.modelVersion });
        if (appliedSemantic) semanticItemsApplied++;
        else if (suggestedSemantic) semanticItemsSuggested++;
        else if (ignoredSemantic) semanticItemsIgnored++;
      }
    } catch (error: any) {
      if (__DEV__) {
        console.warn(
          `[CategoryBatchAI] semantic apply failed: ${error?.message || ''}`
        );
      }
      item.semantic_status = 'failed';
      semanticItemsIgnored++;
    }
  }
  return {
    appliedCount,
    suggestedCount,
    semantic: { semanticItemsApplied, semanticItemsSuggested, semanticItemsIgnored },
  };
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
        knownCategory: it.knownCategory || null,
        knownFamily: it.knownFamily || null,
        knownAttributes: it.knownAttributes || null,
      })),
      merchantName: opts.merchantName || null,
      locale,
      mode: 'semantic_enrich',
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
        category:
          typeof r?.categoryId === 'string'
            ? r.categoryId
            : typeof r?.category === 'string'
              ? r.category
              : '',
        confidence: typeof r?.confidence === 'number' ? r.confidence : Number(r?.confidence),
        reason: typeof r?.reason === 'string' ? r.reason : undefined,
        brand: typeof r?.brand === 'string' ? r.brand : r?.brand === null ? null : undefined,
        brandConfidence:
          typeof r?.brandConfidence === 'number' ? r.brandConfidence : undefined,
        canonicalName:
          typeof r?.canonicalName === 'string'
            ? r.canonicalName
            : r?.canonicalName === null
              ? null
              : undefined,
        canonicalNameConfidence:
          typeof r?.canonicalNameConfidence === 'number'
            ? r.canonicalNameConfidence
            : undefined,
        productType: typeof r?.productType === 'string' ? r.productType : undefined,
        semanticTags: Array.isArray(r?.semanticTags) ? r.semanticTags : undefined,
        attributes: Array.isArray(r?.attributes) ? r.attributes : undefined,
        janCode: r?.janCode,
        skuId: r?.skuId,
        barcode: r?.barcode,
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
  const semantic = emptySemanticBatchCostMetrics();
  for (const it of items ?? []) {
    invalidateStaleSemanticCacheOnItem(it);
    if (it?.semantic_status === 'enriched' || it?.semantic_status === 'sufficient') {
      semantic.semanticCacheHits += 1;
    }
  }

  const selected = selectBatchAiItems(items);
  if (selected.length === 0) {
    return { called: false, appliedCount: 0, suggestedCount: 0, semantic };
  }

  semantic.semanticItemsSent = selected.filter((s) =>
    s.selectReasons?.includes('needs_enrichment')
  ).length;

  const classify = deps?.classify ?? classifyItemsBatch;
  let results: BatchAiResultItem[] | null = null;
  try {
    results = await classify(selected, opts);
  } catch (error: any) {
    // 双保险：网络层已吞错，这里再兜底一次，绝不冒泡。
    if (__DEV__) console.warn(`[CategoryBatchAI] runBatchAiFallback error: ${error?.message || ''}`);
    results = null;
  }

  semantic.semanticBatchCalled = true;
  if (!results) {
    return { called: true, appliedCount: 0, suggestedCount: 0, semantic };
  }

  const applied = applyBatchAiResults(items, results, {
    now: deps?.now,
    modelVersion: opts.modelVersion ?? null,
  });
  semantic.semanticItemsApplied = applied.semantic.semanticItemsApplied;
  semantic.semanticItemsSuggested = applied.semantic.semanticItemsSuggested;
  semantic.semanticItemsIgnored = applied.semantic.semanticItemsIgnored;

  return {
    called: true,
    appliedCount: applied.appliedCount,
    suggestedCount: applied.suggestedCount,
    semantic,
  };
}
