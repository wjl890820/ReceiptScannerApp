import { normalizeIdentityText } from './productSpecification';

export const PRODUCT_FAMILY_KEYS = [
  'milk',
  'eggs',
  'tofu',
  'yogurt',
  'rice',
  'bread',
  'coffee',
  'tea',
  'water',
  'cola',
  'onigiri',
  'bento',
] as const;

export type ProductFamilyKey = (typeof PRODUCT_FAMILY_KEYS)[number];

export type ProductFamilyResult = {
  family: ProductFamilyKey | null;
  confidence: number;
  reason: string;
};

export type ResolveProductFamilyInput = {
  rawName: string;
  normalizedFullName?: string | null;
  canonicalProductName?: string | null;
  category?: string | null;
  brand?: string | null;
  /** Accepted for future alias disambiguation; never used as direct family evidence. */
  merchantName?: string | null;
};

type FamilyRule = {
  family: ProductFamilyKey;
  confidence: number;
  reason: string;
  matches: (text: string) => boolean;
};

const RULES: readonly FamilyRule[] = [
  {
    family: 'milk',
    confidence: 0.98,
    reason: 'explicit milk product name',
    matches: (text) =>
      /牛乳|牛奶|おいしい牛乳|オイシイ牛乳|メグミルク/.test(text) ||
      (/(?:明治|雪印|森永|乳飲料|成分無調整)/.test(text) && /ミルク/.test(text)),
  },
  {
    family: 'eggs',
    confidence: 0.98,
    reason: 'explicit egg product name',
    matches: (text) => /卵|たまご|玉子/.test(text),
  },
  {
    family: 'tofu',
    confidence: 0.99,
    reason: 'explicit tofu product name',
    matches: (text) => /豆腐|とうふ/.test(text),
  },
  {
    family: 'yogurt',
    confidence: 0.99,
    reason: 'explicit yogurt product name',
    matches: (text) => /ヨーグルト/.test(text),
  },
  {
    family: 'rice',
    confidence: 0.95,
    reason: 'explicit rice product name',
    matches: (text) =>
      /精米|白米|玄米|お米/.test(text) || /(?:^|[\s・])米(?=$|[\s・\d])/.test(text),
  },
  {
    family: 'bread',
    confidence: 0.94,
    reason: 'explicit bread product name',
    matches: (text) =>
      !/パン粉|パンツ/.test(text) &&
      (/食パン|ロールパン|フランスパン|コッペパン|クロワッサン/.test(text) ||
        /(?:^|[\s・])パン(?:$|[\s・])/.test(text)),
  },
  {
    family: 'coffee',
    confidence: 0.97,
    reason: 'explicit coffee product name or high-confidence BOSS brand',
    matches: (text) => /コーヒー|珈琲|(?:^|[\s・])boss(?=$|[\s・\d])/.test(text),
  },
  {
    family: 'tea',
    confidence: 0.97,
    reason: 'explicit tea product name',
    matches: (text) => /緑茶|烏龍茶|ウーロン茶|麦茶|紅茶|ほうじ茶|煎茶/.test(text),
  },
  {
    family: 'water',
    confidence: 0.98,
    reason: 'explicit drinking water product name',
    matches: (text) =>
      /天然水|ミネラルウォーター|おいしい水/.test(text) ||
      /(?:^|[\s・])水(?=$|[\s・\d])/.test(text),
  },
  {
    family: 'cola',
    confidence: 0.99,
    reason: 'explicit cola product name',
    matches: (text) => /コカ[・\-\s]?コーラ|コーラ|coca[\s-]?cola|(?:^|[\s・])cola(?:$|[\s・\d])/.test(text),
  },
  {
    family: 'onigiri',
    confidence: 0.99,
    reason: 'explicit onigiri product name',
    matches: (text) => /おにぎり|おむすび|お握り/.test(text),
  },
  {
    family: 'bento',
    confidence: 0.99,
    reason: 'explicit bento product name',
    matches: (text) => /弁当|べんとう/.test(text),
  },
];

const INCOMPATIBLE_CATEGORY_KEYS = new Set(['household', 'personal_care', 'pet_care']);

/**
 * Resolve only the small Phase 3A high-confidence family set.
 * Merchant name/type is intentionally not considered family evidence.
 */
export function resolveProductFamily(input: ResolveProductFamilyInput): ProductFamilyResult {
  const evidenceByPriority = [
    { source: 'canonical product', value: input.canonicalProductName },
    { source: 'normalized full name', value: input.normalizedFullName },
    { source: 'raw product name', value: input.rawName },
  ]
    .filter(
      (entry): entry is { source: string; value: string } =>
        typeof entry.value === 'string' && entry.value.trim().length > 0
    )
    .map((entry) => ({
      source: entry.source,
      text: normalizeIdentityText(entry.value),
    }));

  if (evidenceByPriority.length === 0) {
    return { family: null, confidence: 0, reason: 'no product-name evidence' };
  }

  if (input.category && INCOMPATIBLE_CATEGORY_KEYS.has(input.category)) {
    return {
      family: null,
      confidence: 0,
      reason: `category ${input.category} is incompatible with food/drink family rules`,
    };
  }

  for (const evidence of evidenceByPriority) {
    for (const rule of RULES) {
      if (rule.matches(evidence.text)) {
        return {
          family: rule.family,
          confidence: rule.confidence,
          reason: `${rule.reason} (${evidence.source})`,
        };
      }
    }
  }

  return { family: null, confidence: 0, reason: 'no high-confidence family rule matched' };
}
