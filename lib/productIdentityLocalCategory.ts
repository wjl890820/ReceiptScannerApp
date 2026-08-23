/**
 * Sync local category for semantic gate / dry-run (no AI, no learning DB).
 */

import { classifyItemByName } from './productCategory';
import { matchItemRule } from './itemRulesV1';
import { mapV1ToLegacyCategory } from './categoryTaxonomyV1';

export type LocalCategoryForGate = {
  category: string;
  confidence: number;
  source: 'name_rule' | 'item_rules' | 'none';
};

export function resolveLocalCategoryForSemanticGate(
  rawName: string,
  normalizedName?: string | null,
  merchantName?: string | null
): LocalCategoryForGate {
  const raw = (rawName || '').trim();
  const normalized = (normalizedName || raw).trim();
  if (!raw && !normalized) {
    return { category: 'uncategorized', confidence: 0, source: 'none' };
  }

  const nameCat = classifyItemByName(raw || normalized);
  if (nameCat !== 'uncategorized') {
    return { category: nameCat, confidence: 0.9, source: 'name_rule' };
  }

  const rule = matchItemRule({
    raw_name: raw || normalized,
    normalized_name: normalized || raw,
    merchantName: merchantName ?? undefined,
  });
  if (rule && rule.confidence >= 0.75) {
    return {
      category: mapV1ToLegacyCategory({ main: rule.main, sub: rule.sub }),
      confidence: rule.confidence,
      source: 'item_rules',
    };
  }

  return { category: 'uncategorized', confidence: 0, source: 'none' };
}
