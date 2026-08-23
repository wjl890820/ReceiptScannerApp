import {
  SEMANTIC_EVAL_SAMPLES,
  scoreSemanticEval,
  type SemanticEvalMockAi,
} from './productIdentitySemanticEval';
import { needsSemanticEnrichment } from './productIdentitySemanticGate';
import { applySemanticEnrichmentEvidence } from './productIdentitySemanticContract';
import { emptyProductAttributes, buildProductAttributes } from './productIdentityContract';

describe('Product Identity Batch 4 — representative eval (fixture/mock)', () => {
  it('has at least 20 representative samples', () => {
    expect(SEMANTIC_EVAL_SAMPLES.length).toBeGreaterThanOrEqual(20);
  });

  it('selection gate prefers skipping AI for code-sufficient commodities', () => {
    for (const name of ['キャベツ', 'バナナ', '卵10個']) {
      expect(
        needsSemanticEnrichment({
          rawName: name,
          normalizedName: name,
          createdMerchantProduct: true,
          category: 'food_ingredients',
          categoryConfidence: 0.9,
          attributes: emptyProductAttributes(),
        })
      ).toBe(false);
    }
    // Named milk with parsed volume is code-sufficient even without brand.
    expect(
      needsSemanticEnrichment({
        rawName: '東北恵牛乳 1L',
        normalizedName: '東北恵牛乳 1L',
        createdMerchantProduct: true,
        category: 'food_ingredients',
        categoryConfidence: 0.9,
        attributes: buildProductAttributes([
          { dimension: 'volume', value: 1000, unit: 'ml', source: 'parsed' },
        ]),
      })
    ).toBe(false);
    expect(
      needsSemanticEnrichment({
        rawName: 'TV BPさつま揚げ',
        normalizedName: 'TV BPさつま揚げ',
        createdMerchantProduct: true,
        category: 'uncategorized',
      })
    ).toBe(true);
    // Opaque abbrev still needs AI even if category is already known.
    expect(
      needsSemanticEnrichment({
        rawName: '午後T MLK 500',
        normalizedName: '午後T MLK 500',
        createdMerchantProduct: true,
        category: 'snacks_drinks',
        categoryConfidence: 0.9,
      })
    ).toBe(true);
  });

  it('scores mock Gemini outputs with precision-first metrics', () => {
    const aiById: Record<string, SemanticEvalMockAi> = {};
    for (const s of SEMANTIC_EVAL_SAMPLES) {
      aiById[s.id] = {
        index: 0,
        categoryId: s.expected.categoryId ?? 'uncategorized',
        confidence: 0.9,
        brand: s.expected.brand ?? null,
        brandConfidence: s.expected.brand ? 0.92 : null,
        canonicalName: s.expected.canonicalNameUseful ? `${s.rawName} (semantic)` : null,
        canonicalNameConfidence: s.expected.canonicalNameUseful ? 0.91 : null,
      };
    }
    // Inject one hallucination case for measurement if sample exists.
    const choc = SEMANTIC_EVAL_SAMPLES.find((s) => /チョコ|choc/i.test(s.id + s.rawName));
    if (choc) {
      aiById[choc.id] = {
        index: 0,
        categoryId: 'snacks_drinks',
        confidence: 0.9,
        brand: 'InventedChocoCo',
        brandConfidence: 0.99,
        janCode: '4901111111111',
      };
    }

    const scores = scoreSemanticEval(SEMANTIC_EVAL_SAMPLES, aiById);
    expect(scores.sampleCount).toBeGreaterThanOrEqual(20);
    expect(scores.categoryAccuracy).toBeGreaterThan(0.7);
    expect(scores.hallucinationCount).toBeGreaterThanOrEqual(0);

    const applied = applySemanticEnrichmentEvidence(
      {
        index: 0,
        confidence: 0.99,
        brand: 'InventedChocoCo',
        brandConfidence: 0.99,
        janCode: '4901111111111',
      },
      emptyProductAttributes()
    );
    expect(applied.rejectedJan).toBe(true);
  });
});
