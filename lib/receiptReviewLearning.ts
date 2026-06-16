/**
 * 审核保存：把名称/分类修正沉淀到 product_name_alias、product_dictionary、item_category_mapping（经 learnFromUserEdit）。
 */

import { ALL_CATEGORIES, type Category } from './categories';
import { learnFromUserEdit } from './receiptEnricher';
import { normalizeReceiptItemName } from './productNormalizer';
import { upsertProductDictionary } from './productDictionary';
import { upsertProductNameAlias } from './productAlias';
import { mapLegacyCategoryToV1, buildAnalysisTags } from './categoryTaxonomyV1';
import { logger } from './logger';

function isValidCategory(c: string): c is Category {
  return ALL_CATEGORIES.includes(c as Category);
}

export async function applyReviewCorrectionsToLearning(params: {
  snapshotItems: any[];
  finalItems: any[];
  merchantRaw: string | null;
}): Promise<void> {
  const { snapshotItems, finalItems, merchantRaw } = params;
  const n = Math.min(snapshotItems.length, finalItems.length);
  for (let i = 0; i < n; i++) {
    const snap = snapshotItems[i];
    const fin = finalItems[i];
    const origName = typeof snap?.name === 'string' ? snap.name.trim() : '';
    const finalName = typeof fin?.name === 'string' ? fin.name.trim() : '';
    const catRaw = typeof fin?.category === 'string' ? fin.category.trim() : '';
    if (!finalName || !catRaw || !isValidCategory(catRaw)) continue;

    const snapCatRaw = typeof snap?.category === 'string' ? snap.category.trim() : '';
    const nameChanged = origName.length > 0 && finalName.length > 0 && origName !== finalName;
    // 快照分类为空时用户只改分类也必须视为变更（旧逻辑会永远不触发学习）
    const categoryChanged = catRaw !== snapCatRaw;

    const v1 = mapLegacyCategoryToV1(catRaw);
    const tags = buildAnalysisTags(v1);
    const finalNorm = normalizeReceiptItemName(finalName).normalized_name;
    if (!finalNorm) continue;

    try {
      if (nameChanged) {
        const aliasKey = normalizeReceiptItemName(origName).normalized_name;
        if (aliasKey) {
          await upsertProductNameAlias({
            alias_normalized: aliasKey,
            merchant_hint: merchantRaw,
            canonical_name: finalName,
            category_main: v1.main,
            category_sub: v1.sub,
            analysis_tags: tags,
            confidence: 1.0,
            source: 'manual',
          });
        }
        await upsertProductDictionary({
          normalized_name: finalNorm,
          canonical_name: finalName,
          category_main: v1.main,
          category_sub: v1.sub,
          analysis_tags: tags,
          source_type: 'manual',
          confidence: 1.0,
          minConfidenceToWrite: 0,
        });
        await learnFromUserEdit(finalName, catRaw, merchantRaw);
      } else if (categoryChanged) {
        await learnFromUserEdit(finalName, catRaw, merchantRaw);
        await upsertProductDictionary({
          normalized_name: finalNorm,
          canonical_name: finalName,
          category_main: v1.main,
          category_sub: v1.sub,
          analysis_tags: tags,
          source_type: 'manual',
          confidence: 1.0,
          minConfidenceToWrite: 0,
        });
        await upsertProductNameAlias({
          alias_normalized: finalNorm,
          merchant_hint: merchantRaw,
          canonical_name: finalName,
          category_main: v1.main,
          category_sub: v1.sub,
          analysis_tags: tags,
          confidence: 1.0,
          source: 'manual',
        });
      }
    } catch (e) {
      logger.warn('ReviewLearning', 'applyReviewCorrectionsToLearning row failed', {
        index: i,
        error: e,
      });
    }
  }
}
