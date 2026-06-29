/**
 * 审核保存：把名称/分类修正沉淀到 product_name_alias、product_dictionary、item_category_mapping（经 learnFromUserEdit）。
 */

import { PRODUCT_CATEGORIES, type ProductCategory } from './productCategory';
import { learnFromUserEdit } from './receiptEnricher';
import { normalizeReceiptItemName } from './productNormalizer';
import { upsertProductDictionary } from './productDictionary';
import { upsertProductNameAlias } from './productAlias';
import { mapLegacyCategoryToV1, buildAnalysisTags } from './categoryTaxonomyV1';
import { logger } from './logger';

// 仅学习有意义的新一级分类（uncategorized 不写学习记忆）。
function isValidCategory(c: string): c is ProductCategory {
  return (PRODUCT_CATEGORIES as readonly string[]).includes(c) && c !== 'uncategorized';
}

export async function applyReviewCorrectionsToLearning(params: {
  snapshotItems: any[];
  finalItems: any[];
  merchantRaw: string | null;
}): Promise<void> {
  const { snapshotItems, finalItems, merchantRaw } = params;
  // 不再依赖 snapshotItems / finalItems 的数组下标一致：删除/新增行后会错位。
  // 改为遍历 finalItems，并按 final item 自带的来源索引回查 snapshot 原始行。
  for (let i = 0; i < finalItems.length; i++) {
    const fin = finalItems[i];
    const rawSourceIndex = fin?.review_source_index ?? fin?.ocr_source_index;
    const sourceIndex =
      typeof rawSourceIndex === 'number' && Number.isInteger(rawSourceIndex) ? rawSourceIndex : null;
    // 人工新增行：无来源索引或显式标记 user_added。没有 OCR 原名，不写 product_name_alias，
    // 但仍参与分类学习与 product_dictionary 写入。
    const isUserAdded = sourceIndex === null || fin?.user_added === true;
    const snap = !isUserAdded ? snapshotItems[sourceIndex as number] ?? {} : {};
    const origName = typeof snap?.name === 'string' ? snap.name.trim() : '';
    const finalName = typeof fin?.name === 'string' ? fin.name.trim() : '';
    const catRaw = typeof fin?.category === 'string' ? fin.category.trim() : '';
    if (!finalName || !catRaw || !isValidCategory(catRaw)) continue;

    const snapCatRaw = typeof snap?.category === 'string' ? snap.category.trim() : '';
    const nameChanged = origName.length > 0 && finalName.length > 0 && origName !== finalName;
    // 快照分类为空时用户只改分类也必须视为变更（旧逻辑会永远不触发学习）。
    // 人工新增行 snapCatRaw 为空，categoryChanged 为 true，因此也能进入分类学习。
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
        // 人工新增行没有 OCR 原名，不写自指 alias，仅做分类学习与 dictionary 写入。
        if (!isUserAdded) {
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
      }
    } catch (e) {
      logger.warn('ReviewLearning', 'applyReviewCorrectionsToLearning row failed', {
        index: i,
        error: e,
      });
    }
  }
}
