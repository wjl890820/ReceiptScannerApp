// lib/receiptEnricher.ts
import type { ReceiptAnalysis, ReceiptItem } from './receiptAnalyzer';
import { learnCategoryMapping, getLearnedCategory } from './categoryLearner';
import { resolveProductCategory } from './productCategory';
import { normalizeReceiptItemName, normalizeMerchantName } from './productNormalizer';
import { ALL_CATEGORIES, type Category } from './categories';
import { isGroceryMerchant } from './groceryDetector';
import {
  classifyItem,
  resetClassificationStats,
  getClassificationStats,
  startReceiptClassification,
  noteAliasClassificationHit,
  type ClassifyInput,
} from './categoryClassifier';
import { getLastClassifyError, clearLastClassifyError } from './categoryAiClient';
import { runBatchAiFallback } from './categoryBatchAi';
import { buildAnalysisTags, mapLegacyCategoryToV1, mapV1ToLegacyCategory } from './categoryTaxonomyV1';
import { buildReceiptStructuredAnalysis } from './structuredAnalysisEngine';
import { buildReceiptAnalysisV1 } from './growthAnalysisEngineV1';
import { buildReceiptTemplateL1 } from './analysisTemplatesV1';
import { upsertProductDictionary } from './productDictionary';
import { lookupProductNameAlias } from './productAlias';

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
  analysis: ReceiptAnalysis,
  trace?: { id: string; t0: number }
): Promise<ReceiptAnalysis> {
  const tStart = Date.now();
  if (__DEV__ && trace) {
    console.log('[ScanTiming] classify_start', { id: trace.id });
  }
  const items = Array.isArray(analysis.items) ? analysis.items : [];
  const enrichedItems: ReceiptItem[] = [];

  // Detect if this is a grocery receipt
  const merchantRaw = analysis.merchant || '';
  const merchantNormalized = (analysis as any).merchant_normalized || null;
  const isGrocery = isGroceryMerchant(merchantRaw, merchantNormalized);

  resetClassificationStats();
  startReceiptClassification();

  if (__DEV__) {
    console.log('[Enricher] OCR items count:', items.length);
    if (items[0]) {
      const sample = items[0] as any;
      console.log('[Enricher] OCR sample item:', {
        name: sample?.name,
        lineTotal: sample?.lineTotal,
        quantity: sample?.quantity,
        unitPrice: sample?.unitPrice,
        category: sample?.category,
      });
    }
  }

  for (const it of items) {
    const name = typeof it?.name === 'string' ? it.name : '';
    const norm = normalizeReceiptItemName(name);

    let category: Category | null;
    let classificationStatus: 'ok' | 'pending' | 'failed' | 'fallback' = 'ok';
    let classificationConfidence = 0;
    let classificationOut: any = null;

    if (!isGrocery) {
      // 非 grocery 收据（如便利店/药妆店）：店铺级属性不应污染商品分类。
      // 之前统一打成 'non_grocery'（显示为"非超市"），会作为商品分类出现在审核页。
      // 改为 'uncategorized'：分析口径仍按收据级 is_grocery 排除（首页/统计均如此），
      // 同时让用户可在审核页手动归类并触发学习。
      category = 'uncategorized';
      classificationStatus = 'ok';
      classificationConfidence = 1;
    } else {
      // Grocery receipt: alias / canonical layer then unified classifier
      clearLastClassifyError();
      const merchantForPipeline = merchantRaw || merchantNormalized || undefined;
      const aliasHit = await lookupProductNameAlias(norm.normalized_name, merchantForPipeline ?? null);

      if (aliasHit) {
        noteAliasClassificationHit();
        const legacy = mapV1ToLegacyCategory({
          main: aliasHit.category_main as any,
          sub: (aliasHit.category_sub as any) ?? null,
        }) as Category;
        classificationOut = {
          categoryId: legacy,
          confidence: Math.min(1, Math.max(0, aliasHit.confidence)),
          source: 'alias',
          reason: 'product_name_alias match',
          category_main: aliasHit.category_main as any,
          category_sub: aliasHit.category_sub as any,
          analysis_tags: aliasHit.analysis_tags_parsed as any,
          canonical_name: aliasHit.canonical_name,
        };
        category = legacy;
        classificationConfidence = classificationOut.confidence;
        classificationStatus = 'ok';
      } else {
        const classifyInput: ClassifyInput = {
          rawName: name,
          normalizedName: norm.normalized_name,
          canonicalName: norm.normalized_name,
          merchantName: merchantForPipeline,
          price: typeof it?.lineTotal === 'number' ? it.lineTotal : undefined,
        };

        classificationOut = await classifyItem(classifyInput);
        category = (classificationOut?.categoryId || null) as Category | null;
        classificationConfidence = Number.isFinite(classificationOut?.confidence)
          ? Number(classificationOut.confidence)
          : 0;

        const lastError = getLastClassifyError();

        if (lastError) {
          classificationStatus = classificationOut?.source === 'fallback' ? 'fallback' : 'ok';
        } else if (classificationOut?.source === 'fallback') {
          classificationStatus = 'fallback';
        } else {
          classificationStatus = 'ok';
        }

        if (
          classificationOut?.source === 'fallback' &&
          typeof (it as any)?.category === 'string' &&
          (it as any).category.trim() &&
          ALL_CATEGORIES.includes((it as any).category.trim() as Category)
        ) {
          category = (it as any).category.trim() as Category;
        }
      }
    }

    // 解析最终展示/存储用的"新一级分类"（item.category）：
    //   优先级：本地学习记忆 → 既有分类器结果(legacy) → OCR categoryKey → 商品名关键词 → uncategorized
    // 本地学习对便利店(非 grocery)商品也生效（分类器分支可能被跳过）。
    const ocrCategoryKey = typeof (it as any)?.categoryKey === 'string' ? (it as any).categoryKey : null;
    let learnedRaw: string | null = null;
    try {
      learnedRaw = await getLearnedCategory(norm.normalized_name, merchantRaw || merchantNormalized || null);
    } catch {
      learnedRaw = null;
    }
    const productCategory = resolveProductCategory(name, [learnedRaw, category, ocrCategoryKey]);

    const enrichedItem: any = {
      ...it,
      // Keep existing fields (compat)
      name,
      // item.category 统一为新一级分类 enum（绝不写入店铺类型词）
      category: productCategory as any,
      // 新字段：分类状态与置信度（兼容旧数据，读取时需做默认值处理）
      classification_status: classificationStatus,
      classification_confidence: classificationConfidence,
      classification_source: classificationOut?.source ?? null,
      // Compatibility bridge for older modules that still read item.classification.*
      classification: {
        category: productCategory as any,
        status: classificationStatus,
        confidence: classificationConfidence,
      },
      // V1 extensible schema fields (snake_case for storage stability)
      raw_name: norm.raw_name,
      normalized_name: norm.normalized_name,
      canonical_name: (() => {
        const cn = classificationOut ? (classificationOut as any).canonical_name : null;
        if (typeof cn === 'string' && cn.trim()) return cn.trim();
        return norm.normalized_name;
      })(),
      brand: null,
      quantity: (it as any)?.quantity ?? 1,
      unit_price: (it as any)?.unitPrice ?? (it as any)?.unit_price ?? 0,
      line_total: (it as any)?.lineTotal ?? (it as any)?.line_total ?? 0,
      // Prefer rule/ai output main/sub/tags; legacy bridge only as fallback
      category_main:
        classificationOut?.category_main ||
        mapLegacyCategoryToV1(category || '').main,
      category_sub:
        classificationOut?.category_sub ??
        mapLegacyCategoryToV1(category || '').sub,
      analysis_tags:
        Array.isArray(classificationOut?.analysis_tags)
          ? classificationOut.analysis_tags
          : buildAnalysisTags(mapLegacyCategoryToV1(category || '')),
    };
    enrichedItems.push(enrichedItem as any);

    // Write back to product_dictionary (best-effort, never crash pipeline)
    try {
      const source = classificationOut?.source;
      const conf =
        Number.isFinite(classificationOut?.confidence) ? Number(classificationOut.confidence) : classificationConfidence;
      const shouldWrite =
        source === 'alias' ||
        source === 'dictionary' ||
        source === 'mapping' ||
        (source === 'rules' && conf >= 0.9) ||
        (source === 'ai' && conf >= 0.85);
      if (shouldWrite) {
        const sourceType =
          source === 'alias'
            ? 'alias'
            : source === 'rules'
              ? 'rules'
              : source === 'ai'
                ? 'ai'
                : source === 'mapping'
                  ? 'mapping'
                  : source === 'dictionary'
                    ? 'dictionary'
                    : 'unknown';
        await upsertProductDictionary({
          normalized_name: enrichedItem.normalized_name,
          canonical_name: enrichedItem.canonical_name ?? classificationOut?.canonical_name ?? null,
          brand: classificationOut?.brand ?? null,
          category_main: String(enrichedItem.category_main),
          category_sub: enrichedItem.category_sub ? String(enrichedItem.category_sub) : null,
          analysis_tags: Array.isArray(enrichedItem.analysis_tags) ? enrichedItem.analysis_tags : [],
          source_type: sourceType as any,
          confidence: conf,
          minConfidenceToWrite:
            source === 'dictionary' || source === 'mapping' || source === 'alias' ? 0 : undefined,
        });
      }
    } catch {
      // ignore
    }
  }

  // Log classification statistics (once per receipt)
  const stats = getClassificationStats();
  if (stats) {
    console.log(
      '[CategoryClassifier] Stats:',
      `alias=${stats.alias ?? 0}`,
      `dictionary=${(stats as any).dictionary ?? 0}`,
      `mapping=${stats.mapping}`,
      `rules=${stats.rules}`,
      `ai=${stats.ai}`,
      `fallback=${stats.fallback}`
    );
  }

  if (__DEV__) {
    const okCount = enrichedItems.filter((x: any) => x?.classification_status === 'ok' && x?.category).length;
    const fbCount = enrichedItems.filter((x: any) => x?.classification_status === 'fallback' && x?.category).length;
    const missingCount = enrichedItems.filter((x: any) => !x?.category).length;
    console.log('[Enricher] categorized counts:', { ok: okCount, fallback: fbCount, missing: missingCount });
    if (enrichedItems[0]) {
      const s = enrichedItems[0] as any;
      console.log('[Enricher] enriched sample item:', {
        name: s?.name,
        category: s?.category,
        classification_status: s?.classification_status,
        classification_confidence: s?.classification_confidence,
      });
    }
  }

  if (__DEV__ && trace) {
    console.log('[ScanTiming] classify_end_ms', { id: trace.id, ms: Date.now() - tStart, items: items.length });
  }

  // 批量 AI 兜底：仅对本地分类后仍为 'uncategorized' 的商品，发起“单张小票一次”的
  // classify-items 请求。失败/超时仅 warn，不影响保存；绝不覆盖本地学习/词典/规则结果。
  try {
    const tBatch = Date.now();
    const batch = await runBatchAiFallback(enrichedItems as any[], {
      merchantName: merchantRaw || merchantNormalized || undefined,
    });
    if (__DEV__) {
      console.log('[ScanTiming] batch_ai_ms', {
        id: trace?.id,
        ms: Date.now() - tBatch,
        called: batch.called,
        applied: batch.appliedCount,
        suggested: batch.suggestedCount,
      });
    }
  } catch (e: any) {
    if (__DEV__) console.warn('[CategoryBatchAI] enrich batch fallback failed:', e?.message);
  }

  const structured = buildReceiptStructuredAnalysis({
    merchant: analysis.merchant,
    items: enrichedItems as any,
    total: analysis.total,
    tax: analysis.tax,
    currency: analysis.currency,
  });

  const receiptLevel = buildReceiptAnalysisV1({ items: enrichedItems as any, total: analysis.total });
  const receiptTemplate = buildReceiptTemplateL1(receiptLevel);

  return {
    ...analysis,
    items: enrichedItems as any,
    is_grocery: isGrocery, // Add flag to analysis for later filtering
    analysis_engine_v1: structured,
    analysis_outputs_v1: {
      receipt_level: receiptLevel,
      templates_v1: {
        receipt_template: receiptTemplate,
      },
    },
  } as any;
}

/**
 * 学习用户编辑的分类。
 * 必须使用 normalizeReceiptItemName 与 classifyItem / getLearnedCategory 的键一致。
 * merchantHintRaw 可选：同时写入通用行（merchant_hint=''）与商户行，与 getLearnedCategory 查询顺序一致。
 */
export async function learnFromUserEdit(
  itemName: string,
  category: string,
  merchantHintRaw?: string | null
): Promise<void> {
  const key = normalizeReceiptItemName(itemName).normalized_name.trim().toLowerCase();
  if (!key) return;
  await learnCategoryMapping(key, '', category, 1.0);
  const mh = merchantHintRaw ? normalizeMerchantName(merchantHintRaw) : '';
  if (mh) {
    await learnCategoryMapping(key, mh, category, 1.0);
  }
}
