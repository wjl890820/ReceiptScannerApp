/**
 * Product Identity Batch 4 — representative semantic eval (fixture / mock).
 * Does NOT call live Gemini against the full 932 history set.
 */

export type SemanticEvalSample = {
  id: string;
  rawName: string;
  merchantName?: string;
  knownAttributes?: Record<string, unknown>;
  /** Expected human/fixture interpretation. */
  expected: {
    categoryId?: string | null;
    brand?: string | null;
    canonicalNameUseful?: boolean;
    allowBrandGuess?: boolean;
    notes?: string;
  };
};

/** ≥20 representative samples covering opaque / PB / known / variant / household / non-food. */
export const SEMANTIC_EVAL_SAMPLES: SemanticEvalSample[] = [
  { id: 'opaque-tv-bp', rawName: 'TV BPさつま揚げ', merchantName: 'AEON', expected: { categoryId: 'ready_to_eat', brand: 'TOPVALU', canonicalNameUseful: true } },
  { id: 'opaque-gogo', rawName: '午後T MLK 500', expected: { categoryId: 'snacks_drinks', brand: null, canonicalNameUseful: true, notes: '午後の紅茶ミルクティー候補' } },
  { id: 'milk-1l', rawName: '東北恵牛乳 1L', expected: { categoryId: 'food_ingredients', brand: null, canonicalNameUseful: false, notes: 'code sufficient' } },
  { id: 'cabbage', rawName: 'キャベツ', expected: { categoryId: 'food_ingredients', brand: null, canonicalNameUseful: false } },
  { id: 'banana', rawName: 'バナナ', expected: { categoryId: 'food_ingredients', brand: null, canonicalNameUseful: false } },
  { id: 'egg-10', rawName: '卵10個', expected: { categoryId: 'food_ingredients', brand: null, canonicalNameUseful: false } },
  { id: 'pb-topvalu', rawName: 'トップバリュ 醤油 500ml', expected: { categoryId: 'food_ingredients', brand: 'TOPVALU', canonicalNameUseful: true } },
  { id: 'variant-zero', rawName: 'コーラ ZERO 500ml', expected: { categoryId: 'snacks_drinks', brand: null, canonicalNameUseful: true, notes: 'ZERO variant' } },
  { id: 'variant-lemon', rawName: '強炭酸水レモン 500', expected: { categoryId: 'snacks_drinks', brand: null, canonicalNameUseful: true } },
  { id: 'household-tissue', rawName: 'ティッシュ 5箱', expected: { categoryId: 'household', brand: null, canonicalNameUseful: false } },
  { id: 'battery-aa', rawName: 'アルカリ単3 8本', expected: { categoryId: 'household', brand: null, canonicalNameUseful: true } },
  { id: 'toothpaste', rawName: 'ハミガキ 120g', expected: { categoryId: 'personal_care', brand: null, canonicalNameUseful: false } },
  { id: 'pet-food', rawName: 'ドッグフード 成犬用', expected: { categoryId: 'pet_care', brand: null, canonicalNameUseful: true } },
  { id: 'unknown-abbrev', rawName: 'PB 茶 500', expected: { categoryId: 'snacks_drinks', brand: null, canonicalNameUseful: true, allowBrandGuess: false } },
  { id: 'ramen', rawName: '袋麺 塩', expected: { categoryId: 'ready_to_eat', brand: null, canonicalNameUseful: true } },
  { id: 'lowfat-milk', rawName: '低脂肪乳 1L', expected: { categoryId: 'food_ingredients', brand: null, canonicalNameUseful: false } },
  { id: 'natto', rawName: '納豆 3P', expected: { categoryId: 'food_ingredients', brand: null, canonicalNameUseful: false } },
  { id: 'usb-cable', rawName: 'USB-C ケーブル 1m', expected: { categoryId: 'other', brand: null, canonicalNameUseful: true } },
  { id: 'choc-abbrev', rawName: 'ABCチョコ', expected: { brand: null, allowBrandGuess: false, notes: 'must not invent brand' } },
  { id: 'laundry', rawName: '洗濯用洗剤 詰替', expected: { categoryId: 'household', brand: null, canonicalNameUseful: true } },
  { id: 'yogurt-drink', rawName: 'のむヨーグルト 900', expected: { categoryId: 'snacks_drinks', brand: null, canonicalNameUseful: true } },
  { id: 'tofu', rawName: '絹豆腐', expected: { categoryId: 'food_ingredients', brand: null, canonicalNameUseful: false } },
];

export type SemanticEvalMockAi = {
  index: number;
  categoryId?: string | null;
  confidence?: number;
  brand?: string | null;
  brandConfidence?: number | null;
  canonicalName?: string | null;
  canonicalNameConfidence?: number | null;
  productType?: string | null;
  semanticTags?: string[];
  attributes?: Array<{ dimension: string; value: number | string | null; unit?: string | null; confidence?: number }>;
  janCode?: unknown;
};

export type SemanticEvalScores = {
  sampleCount: number;
  categoryAccuracy: number;
  brandPrecision: number;
  brandAttempts: number;
  brandCorrect: number;
  canonicalNameUsefulness: number;
  attributePrecision: number;
  hallucinationCount: number;
};

/**
 * Score mock/fixture AI outputs against expected interpretations.
 * Precision-oriented: inventing brand when allowBrandGuess=false counts as hallucination.
 */
export function scoreSemanticEval(
  samples: SemanticEvalSample[],
  aiById: Record<string, SemanticEvalMockAi>
): SemanticEvalScores {
  let catOk = 0;
  let catN = 0;
  let brandAttempts = 0;
  let brandCorrect = 0;
  let canonUseful = 0;
  let canonN = 0;
  let attrOk = 0;
  let attrN = 0;
  let hallucinations = 0;

  for (const s of samples) {
    const ai = aiById[s.id];
    if (!ai) continue;
    if (s.expected.categoryId) {
      catN += 1;
      if (ai.categoryId === s.expected.categoryId) catOk += 1;
    }
    if (ai.brand) {
      brandAttempts += 1;
      if (s.expected.allowBrandGuess === false) {
        hallucinations += 1;
      } else if (s.expected.brand == null || ai.brand === s.expected.brand) {
        brandCorrect += 1;
      }
    }
    if (typeof s.expected.canonicalNameUseful === 'boolean') {
      canonN += 1;
      const hasCanon = !!(ai.canonicalName && String(ai.canonicalName).trim());
      if (s.expected.canonicalNameUseful === hasCanon) canonUseful += 1;
    }
    if (ai.janCode != null) hallucinations += 1;
    if (Array.isArray(ai.attributes)) {
      for (const a of ai.attributes) {
        attrN += 1;
        if (!/^(jan|sku|barcode)/i.test(a.dimension)) attrOk += 1;
        else hallucinations += 1;
      }
    }
  }

  return {
    sampleCount: samples.length,
    categoryAccuracy: catN ? catOk / catN : 0,
    brandPrecision: brandAttempts ? brandCorrect / brandAttempts : 1,
    brandAttempts,
    brandCorrect,
    canonicalNameUsefulness: canonN ? canonUseful / canonN : 0,
    attributePrecision: attrN ? attrOk / attrN : 1,
    hallucinationCount: hallucinations,
  };
}
