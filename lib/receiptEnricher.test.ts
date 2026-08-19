/**
 * 运行时分类优先级测试（修复“宽泛 dictionary 覆盖具体商品名规则”）。
 * 覆盖：
 *  - resolveProductCategoryRuntime 优先级（learned/alias > 商品名规则 > rule > dictionary > OCR key）
 *  - receiptEnricher 端到端：シュガーバター(categoryKey=snacks_drinks) 最终 = snacks_drinks
 *  - dictionary バター 不覆盖具体甜点规则；OCR ready_to_eat 不覆盖本地 とりきも=food_ingredients
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

// 屏蔽原生依赖：env 走默认值；网络/DB 相关模块 mock 掉。
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('./env', () => ({
  isBatchAiClassificationEnabled: jest.fn(() => true),
  getCategoryAiItemCap: () => 3,
  getCategoryAiTimeoutMs: () => 3500,
  getCategoryAiRetries: () => 0,
  getCategoryBatchAiTimeoutMs: () => 9000,
  getCategoryBatchAiMaxItems: () => 40,
}));
// 可控的学习表 mock：默认无学习记录。测试通过 setMockLearned 注入 {category, source}。
let mockLearnedEntry: { category: string; source: string | null } | null = null;
jest.mock('./categoryLearner', () => ({
  getLearnedCategoryEntry: jest.fn(async () => mockLearnedEntry),
  getLearnedCategory: jest.fn(async () => mockLearnedEntry?.category ?? null),
  learnCategoryMapping: jest.fn(async () => {}),
}));
function setMockLearned(e: { category: string; source: string | null } | null): void {
  mockLearnedEntry = e;
}
jest.mock('./productAlias', () => ({ lookupProductNameAlias: jest.fn(async () => null) }));
jest.mock('./categoryBatchAi', () => ({
  selectUncategorizedItems: (items: any[]) => {
    const out: { index: number; rawName: string }[] = [];
    if (!Array.isArray(items)) return out;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || it.category !== 'uncategorized') continue;
      const rawName =
        (typeof it.name === 'string' && it.name) ||
        (typeof it.raw_name === 'string' && it.raw_name) ||
        '';
      if (!rawName.trim()) continue;
      out.push({ index: i, rawName });
    }
    return out;
  },
  runBatchAiFallback: jest.fn(async () => ({ called: false, appliedCount: 0, suggestedCount: 0 })),
}));
jest.mock('./categoryAiClient', () => ({
  classifyViaEdgeFunction: jest.fn(async () => null),
  getLastClassifyError: () => null,
  clearLastClassifyError: () => {},
}));
// 模拟“宽泛 dictionary”：凡商品名含 バター 一律返回 ingredients（食材），用于验证不被覆盖。
jest.mock('./productDictionary', () => ({
  lookupProductDictionary: jest.fn(async (name: string) =>
    typeof name === 'string' && name.includes('バター')
      ? { category_main: 'ingredients', category_sub: 'dairy', analysis_tags: [], canonical_name: null, brand: null }
      : null
  ),
  upsertProductDictionary: jest.fn(async () => {}),
}));

import { resolveProductCategoryRuntime, normalizePersistedProductCategory } from './productCategory';
import { applyCategoriesWithLearning } from './receiptEnricher';
import { runBatchAiFallback } from './categoryBatchAi';
import { isBatchAiClassificationEnabled } from './env';
import { isV1SupportedMerchantType, persistMerchantTypeFromAnalysis } from './merchantType';
import { normalizeOcrAnalysis } from './receiptOcrNormalize';
import { itemAmountForAnalytics } from './receiptDiscountAllocation';

describe('resolveProductCategoryRuntime: 运行时优先级', () => {
  it('シュガーバター：商品名规则早于宽泛 dictionary(バター→food) 与 OCR', () => {
    expect(
      resolveProductCategoryRuntime({
        itemName: 'シュガーバター',
        dictionary: 'dairy_eggs',
        ocrKey: 'snacks_drinks',
      })
    ).toBe('snacks_drinks');
  });

  it('バターサンド：不因 dictionary バター 变食材', () => {
    expect(resolveProductCategoryRuntime({ itemName: 'バターサンド', dictionary: 'dairy_eggs' })).toBe(
      'snacks_drinks'
    );
  });

  it('有塩バター：商品名规则给 food_ingredients', () => {
    expect(resolveProductCategoryRuntime({ itemName: '有塩バター', dictionary: 'dairy_eggs' })).toBe(
      'food_ingredients'
    );
  });

  it('とりきも：OCR=ready_to_eat 不覆盖本地 food_ingredients', () => {
    expect(resolveProductCategoryRuntime({ itemName: 'とりきも', ocrKey: 'ready_to_eat' })).toBe(
      'food_ingredients'
    );
  });

  it('用户学习最高优先（覆盖商品名规则）', () => {
    expect(
      resolveProductCategoryRuntime({ itemName: 'シュガーバター', learned: 'food_ingredients' })
    ).toBe('food_ingredients');
  });

  it('alias/学习映射优先于商品名规则', () => {
    expect(
      resolveProductCategoryRuntime({ itemName: 'シュガーバター', aliasOrLearned: 'household' })
    ).toBe('household');
  });

  it('商品名无法判断时才用 OCR key 辅助 fallback', () => {
    expect(resolveProductCategoryRuntime({ itemName: 'なぞ商品xyz', ocrKey: 'snacks_drinks' })).toBe(
      'snacks_drinks'
    );
    expect(resolveProductCategoryRuntime({ itemName: 'なぞ商品xyz' })).toBe('uncategorized');
  });
});

describe('applyCategoriesWithLearning: 端到端真实 scan review 路径', () => {
  beforeEach(() => setMockLearned(null));

  // 真实路径：runScanPipelineToReview → applyCategoriesWithLearning（内部走真实 classifyItem）。
  // 仅 mock 宽泛 dictionary（バター→食材），不 mock classifyItem，确保覆盖运行时分类链路。
  async function enrichOne(
    name: string,
    categoryKey: string,
    lineTotal = 100
  ): Promise<{ category: string; source: string | null }> {
    const analysis: any = {
      merchant: 'セブン-イレブン',
      items: [{ name, quantity: 1, unitPrice: lineTotal, lineTotal, categoryKey }],
      total: lineTotal,
      tax: 0,
      currency: 'JPY',
    };
    const out = await applyCategoriesWithLearning(analysis);
    const item = (out.items as any[])[0];
    return { category: item.category, source: item.classification_source ?? null };
  }

  it('シュガーバター + categoryKey=snacks_drinks → snacks_drinks，且 source 不是 dictionary', async () => {
    const { category, source } = await enrichOne('シュガーバター', 'snacks_drinks', 578);
    expect(category).toBe('snacks_drinks');
    // 关键修复点：不得被 broad dictionary(バター→food_ingredients) 抢分类。
    expect(source).not.toBe('dictionary');
    expect(source).toBe('name_rule');
  });

  it('バターサンド → snacks_drinks（具体名规则早于 dictionary バター）', async () => {
    const { category, source } = await enrichOne('バターサンド', 'ready_to_eat', 200);
    expect(category).toBe('snacks_drinks');
    expect(source).not.toBe('dictionary');
  });

  it('有塩バター → food_ingredients', async () => {
    expect((await enrichOne('有塩バター', 'dairy_egg', 300)).category).toBe('food_ingredients');
  });

  it('とりきも + categoryKey=ready_to_eat → food_ingredients（不盲从 OCR）', async () => {
    expect((await enrichOne('とりきも', 'ready_to_eat', 150)).category).toBe('food_ingredients');
  });

  it('K午後MT500 + categoryKey=snacks_drinks → snacks_drinks（名规则不确定时用 OCR key 辅助）', async () => {
    expect((await enrichOne('K午後MT500', 'snacks_drinks', 130)).category).toBe('snacks_drinks');
  });

  it('learned source=user_edit シュガーバター=food_ingredients → 最终允许 food_ingredients（用户明确改过）', async () => {
    setMockLearned({ category: 'food_ingredients', source: 'user_edit' });
    expect((await enrichOne('シュガーバター', 'snacks_drinks', 578)).category).toBe('food_ingredients');
  });

  it('learned source=auto シュガーバター=food_ingredients → 必须被 name_rule 覆盖为 snacks_drinks', async () => {
    setMockLearned({ category: 'food_ingredients', source: 'auto' });
    const { category, source } = await enrichOne('シュガーバター', 'snacks_drinks', 578);
    expect(category).toBe('snacks_drinks');
    expect(source).not.toBe('mapping');
  });

  it('legacy learned(source=null) シュガーバター=food_ingredients → 被 name_rule 覆盖为 snacks_drinks', async () => {
    setMockLearned({ category: 'food_ingredients', source: null });
    expect((await enrichOne('シュガーバター', 'snacks_drinks', 578)).category).toBe('snacks_drinks');
  });

  it('一票多项：各自按运行时优先级得到正确分类', async () => {
    const analysis: any = {
      merchant: 'セブン-イレブン',
      items: [
        { name: 'シュガーバター', quantity: 1, unitPrice: 578, lineTotal: 578, categoryKey: 'snacks_drinks' },
        { name: 'バターサンド', quantity: 1, unitPrice: 200, lineTotal: 200, categoryKey: 'ready_to_eat' },
        { name: '有塩バター', quantity: 1, unitPrice: 300, lineTotal: 300, categoryKey: 'dairy_egg' },
        { name: 'とりきも', quantity: 1, unitPrice: 150, lineTotal: 150, categoryKey: 'ready_to_eat' },
      ],
      total: 1228,
      tax: 0,
      currency: 'JPY',
    };
    const out = await applyCategoriesWithLearning(analysis);
    const cats = (out.items as any[]).map((it) => it.category);
    expect(cats).toEqual(['snacks_drinks', 'snacks_drinks', 'food_ingredients', 'food_ingredients']);
  });

  // Batch B2: classification semantics only (substring collision, cooking base, prepared foods, desserts/snacks)
  it('チャーシュー vs シュークリーム substring collision → ready_to_eat / snacks_drinks', async () => {
    const charSiU = await enrichOne('チャーシュー', 'uncategorized', 500);
    expect(charSiU.category).toBe('ready_to_eat');

    const shuuCream = await enrichOne('シュークリーム', 'uncategorized', 300);
    expect(shuuCream.category).toBe('snacks_drinks');
  });

  it('カレーの素 / ペースト → food_ingredients; real curry dish stays ready_to_eat', async () => {
    expect((await enrichOne('グリーンカレーペースト', 'uncategorized', 200)).category).toBe('food_ingredients');
    expect((await enrichOne('インドネシア風煮込みカレーの素', 'uncategorized', 200)).category).toBe('food_ingredients');
    expect((await enrichOne('インドネシア風スープカレーの素', 'uncategorized', 200)).category).toBe('food_ingredients');

    expect((await enrichOne('カレー弁当', 'uncategorized', 200)).category).toBe('ready_to_eat');
  });

  it('prepared foods: 若鶏唐揚 / 牛すき煮 / 冷やし中華茹で卵 / 担々麺 → ready_to_eat', async () => {
    expect((await enrichOne('若鶏唐揚', 'uncategorized', 200)).category).toBe('ready_to_eat');
    expect((await enrichOne('牛すき煮', 'uncategorized', 200)).category).toBe('ready_to_eat');
    expect((await enrichOne('冷やし中華茹で卵', 'uncategorized', 200)).category).toBe('ready_to_eat');
    expect((await enrichOne('担々麺', 'uncategorized', 200)).category).toBe('ready_to_eat');
  });

  it('ライ麦ロール → ready_to_eat', async () => {
    expect((await enrichOne('ライ麦ロール', 'uncategorized', 200)).category).toBe('ready_to_eat');
  });

  it('desserts/snacks: ティラミス / エクレール / 杏仁豆腐バー → snacks_drinks', async () => {
    expect((await enrichOne('ティラミス', 'uncategorized', 200)).category).toBe('snacks_drinks');
    expect((await enrichOne('エクレール', 'uncategorized', 200)).category).toBe('snacks_drinks');
    expect((await enrichOne('杏仁豆腐バー', 'uncategorized', 200)).category).toBe('snacks_drinks');
  });

  it('squid snack boundary: くんちぎりいか → snacks_drinks; 生いか → food_ingredients', async () => {
    expect((await enrichOne('くんちぎりいか', 'uncategorized', 200)).category).toBe('snacks_drinks');
    expect((await enrichOne('生いか', 'uncategorized', 200)).category).toBe('food_ingredients');
  });

  describe('Final Cleanup C: real-context category sums', () => {
    beforeEach(() => {
      (isBatchAiClassificationEnabled as jest.Mock).mockReturnValue(false);
      (runBatchAiFallback as jest.Mock).mockClear();
    });

    function categoryAmounts(items: any[]): Map<string, number> {
      const map = new Map<string, number>();
      for (const it of items) {
        const cat = normalizePersistedProductCategory(it.category, it.name);
        map.set(cat, (map.get(cat) ?? 0) + itemAmountForAnalytics(it));
      }
      return map;
    }

    async function enrichScanPath(raw: any) {
      const normalized = normalizeOcrAnalysis(raw);
      const out = await applyCategoriesWithLearning(normalized);
      for (const it of out.items as any[]) {
        expect(normalizePersistedProductCategory(it.category, it.name)).toBe(it.category);
      }
      return out;
    }

    it('Sample 081: moving 豪州産モモカツリ 3484 yields FI 6512 / RTE 899 / SD 2123 / total 9534', async () => {
      const current = {
        ready_to_eat: 4383,
        food_ingredients: 3028,
        snacks_drinks: 2123,
      };
      const moved = 3484;
      expect(current.ready_to_eat - moved).toBe(899);
      expect(current.food_ingredients + moved).toBe(6512);
      expect(
        current.ready_to_eat + current.food_ingredients + current.snacks_drinks
      ).toBe(9534);

      // After: RTE 899 / FI 6512 / SD 2123. Total 9534 unchanged.
      const out = await enrichScanPath({
        merchant: 'コストコ',
        items: [
          { name: '豪州産モモカツリ', quantity: 1, unitPrice: 3484, lineTotal: 3484 },
          { name: '卵', quantity: 1, unitPrice: 3028, lineTotal: 3028 },
          { name: '若鶏唐揚', quantity: 1, unitPrice: 899, lineTotal: 899 },
          { name: 'クラフトボス', quantity: 1, unitPrice: 2123, lineTotal: 2123 },
          { name: 'コストコ コネクション', quantity: 1, unitPrice: 1, lineTotal: 1 },
        ],
        total: 9534,
        tax: 706,
        currency: 'JPY',
      });
      expect(out.total).toBe(9534);
      expect(out.tax).toBe(706);
      expect(persistMerchantTypeFromAnalysis(out)).toBe('supermarket');
      expect((out.items as any[]).map((it: any) => it.name)).not.toContain('コストコ コネクション');

      const byName = Object.fromEntries((out.items as any[]).map((it: any) => [it.name, it.category]));
      expect(byName['豪州産モモカツリ']).toBe('food_ingredients');
      expect(byName['豪州産モモカツリ']).not.toBe('ready_to_eat');
      expect(byName['卵']).toBe('food_ingredients');
      expect(byName['若鶏唐揚']).toBe('ready_to_eat');
      expect(byName['クラフトボス']).toBe('snacks_drinks');

      const map = categoryAmounts(out.items as any[]);
      expect(map.get('food_ingredients')).toBe(6512);
      expect(map.get('ready_to_eat')).toBe(899);
      expect(map.get('snacks_drinks')).toBe(2123);
      expect([...map.values()].reduce((s, n) => s + n, 0)).toBe(9534);
    });

    it('Sample 077: moving サラダ油 498 yields FI 15034 / RTE 3066 / SD 5742 / HH 780 / total 24622', async () => {
      const current = {
        food_ingredients: 14536,
        ready_to_eat: 3564,
        snacks_drinks: 5742,
        household: 780,
      };
      const moved = 498;
      expect(current.food_ingredients + moved).toBe(15034);
      expect(current.ready_to_eat - moved).toBe(3066);
      expect(
        current.food_ingredients +
          current.ready_to_eat +
          current.snacks_drinks +
          current.household
      ).toBe(24622);

      // After: FI 15034 / RTE 3066 / SD 5742 / HH 780. Total 24622 unchanged.
      const out = await enrichScanPath({
        merchant: 'コストコ',
        items: [
          { name: 'リノールサラダ油 1500G', quantity: 1, unitPrice: 498, lineTotal: 498 },
          { name: '牛乳', quantity: 1, unitPrice: 14536, lineTotal: 14536 },
          { name: 'ポテトサラダ', quantity: 1, unitPrice: 3066, lineTotal: 3066 },
          { name: 'クラフトボス', quantity: 1, unitPrice: 5742, lineTotal: 5742 },
          { name: 'ティッシュ', quantity: 1, unitPrice: 780, lineTotal: 780 },
        ],
        total: 24622,
        tax: 0,
        currency: 'JPY',
      });
      expect(out.total).toBe(24622);
      expect(persistMerchantTypeFromAnalysis(out)).toBe('supermarket');

      const byName = Object.fromEntries((out.items as any[]).map((it: any) => [it.name, it.category]));
      expect(byName['リノールサラダ油 1500G']).toBe('food_ingredients');
      expect(byName['リノールサラダ油 1500G']).not.toBe('ready_to_eat');
      expect(byName['ポテトサラダ']).toBe('ready_to_eat');
      expect(byName['ポテトサラダ']).not.toBe('food_ingredients');
      expect(byName['牛乳']).toBe('food_ingredients');
      expect(byName['クラフトボス']).toBe('snacks_drinks');
      expect(byName['ティッシュ']).toBe('household');

      const map = categoryAmounts(out.items as any[]);
      expect(map.get('food_ingredients')).toBe(15034);
      expect(map.get('ready_to_eat')).toBe(3066);
      expect(map.get('snacks_drinks')).toBe(5742);
      expect(map.get('household')).toBe(780);
      expect([...map.values()].reduce((s, n) => s + n, 0)).toBe(24622);
    });

    it('Sample 093: moving すいかスムージー 192 yields SD 1343 / FI 0 / RTE 116 / total 1459', async () => {
      const current = {
        snacks_drinks: 1151,
        food_ingredients: 192,
        ready_to_eat: 116,
      };
      const moved = 192;
      expect(current.snacks_drinks + moved).toBe(1343);
      expect(current.food_ingredients - moved).toBe(0);
      expect(
        current.snacks_drinks + current.food_ingredients + current.ready_to_eat
      ).toBe(1459);

      // After: SD 1343 / FI 0 / RTE 116. Total 1459 unchanged.
      const out = await enrichScanPath({
        merchant: 'イオン古川店',
        items: [
          { name: 'すいかスムージー', quantity: 1, unitPrice: 192, lineTotal: 192 },
          { name: 'コカゼロ', quantity: 1, unitPrice: 1151, lineTotal: 1151 },
          { name: 'おにぎり', quantity: 1, unitPrice: 116, lineTotal: 116 },
        ],
        total: 1459,
        tax: 0,
        currency: 'JPY',
      });
      expect(out.total).toBe(1459);

      const byName = Object.fromEntries((out.items as any[]).map((it: any) => [it.name, it.category]));
      expect(byName['すいかスムージー']).toBe('snacks_drinks');
      expect(byName['すいかスムージー']).not.toBe('food_ingredients');
      expect(byName['コカゼロ']).toBe('snacks_drinks');
      expect(byName['おにぎり']).toBe('ready_to_eat');

      const map = categoryAmounts(out.items as any[]);
      expect(map.get('snacks_drinks')).toBe(1343);
      expect(map.get('food_ingredients') ?? 0).toBe(0);
      expect(map.get('ready_to_eat')).toBe(116);
      expect([...map.values()].reduce((s, n) => s + n, 0)).toBe(1459);
    });
  });
});

describe('Phase 2: convenience merchant support', () => {
  beforeEach(() => {
    setMockLearned(null);
    (isBatchAiClassificationEnabled as jest.Mock).mockReturnValue(true);
    (runBatchAiFallback as jest.Mock).mockClear();
    (runBatchAiFallback as jest.Mock).mockResolvedValue({
      called: false,
      appliedCount: 0,
      suggestedCount: 0,
    });
  });

  async function enrichAtMerchant(
    merchant: string,
    name: string,
    categoryKey = 'ready_to_eat',
    lineTotal = 100
  ) {
    const analysis: any = {
      merchant,
      items: [{ name, quantity: 1, unitPrice: lineTotal, lineTotal, categoryKey }],
      total: lineTotal,
      tax: 0,
      currency: 'JPY',
    };
    return applyCategoriesWithLearning(analysis);
  }

  it('FamilyMart + おにぎり → 正常分类 ready_to_eat（非 merchant 强制 uncategorized）', async () => {
    const out = await enrichAtMerchant('ファミリーマート', 'おにぎり', 'ready_to_eat', 150);
    expect((out as any).merchant_type).toBe('convenience');
    expect((out as any).is_grocery).toBe(false);
    expect((out.items as any[])[0].category).toBe('ready_to_eat');
  });

  it('FamilyMart + 水 → snacks_drinks（不得因 convenience 全部 ready_to_eat）', async () => {
    const out = await enrichAtMerchant('ファミリーマート', '水', 'snacks_drinks', 100);
    expect((out.items as any[])[0].category).toBe('snacks_drinks');
  });

  it('Lawson + 商品 → 进入正常分类 pipeline', async () => {
    const out = await enrichAtMerchant('ローソン', 'とりきも', 'ready_to_eat', 180);
    expect((out as any).merchant_type).toBe('convenience');
    expect((out.items as any[])[0].category).toBe('food_ingredients');
  });

  it('other merchant（药妆）+ personal_care item → 仍 uncategorized，不调用 Batch AI', async () => {
    const out = await enrichAtMerchant('マツキヨ', 'シャンプー', 'personal_care', 500);
    expect((out as any).merchant_type).toBe('other');
    expect((out.items as any[])[0].category).toBe('uncategorized');
    expect(runBatchAiFallback).not.toHaveBeenCalled();
    expect((out as any).classification_telemetry_v1?.batch_ai_called).toBe(false);
  });

  it('unknown merchant + egg/milk/tissue → semantic category allowed, merchant stays unsupported', async () => {
    const analysis: any = {
      merchant: 'なぞのお店xyz',
      items: [
        { name: '卵', quantity: 1, unitPrice: 200, lineTotal: 200 },
        { name: '明治おいしい牛乳', quantity: 1, unitPrice: 280, lineTotal: 280 },
        { name: 'ティッシュ', quantity: 1, unitPrice: 150, lineTotal: 150 },
      ],
      total: 630,
      tax: 0,
      currency: 'JPY',
    };
    const out = await applyCategoriesWithLearning(analysis);
    expect((out as any).merchant_type).toBe('unknown');
    expect(isV1SupportedMerchantType((out as any).merchant_type)).toBe(false);
    const cats = (out.items as any[]).map((it) => it.category);
    expect(cats).toEqual(['food_ingredients', 'food_ingredients', 'household']);
    expect(runBatchAiFallback).not.toHaveBeenCalled();
  });

  it('DAISO/unsupported classified products do not become supermarket', async () => {
    const out = await enrichAtMerchant('ダイソー', '卵', 'fresh', 100);
    expect((out as any).merchant_type).toBe('unknown');
    expect(isV1SupportedMerchantType((out as any).merchant_type)).toBe(false);
    expect((out.items as any[])[0].category).toBe('food_ingredients');
  });

  it('unknown merchant + 半生うどん / 豪州産モモ use name_rule semantics', async () => {
    const analysis: any = {
      merchant: 'cropped-unknown',
      items: [
        { name: '半生うどん', quantity: 1, unitPrice: 180, lineTotal: 180 },
        { name: '豪州産モモ', quantity: 1, unitPrice: 398, lineTotal: 398 },
        { name: 'ブルダック炒麺', quantity: 1, unitPrice: 250, lineTotal: 250 },
      ],
      total: 828,
      tax: 0,
      currency: 'JPY',
    };
    const out = await applyCategoriesWithLearning(analysis);
    expect((out as any).merchant_type).toBe('unknown');
    expect((out.items as any[]).map((it) => it.category)).toEqual([
      'food_ingredients',
      'food_ingredients',
      'ready_to_eat',
    ]);
  });
});

describe('Phase 2: Batch AI merchant gate', () => {
  beforeEach(() => {
    setMockLearned(null);
    (runBatchAiFallback as jest.Mock).mockClear();
    (runBatchAiFallback as jest.Mock).mockResolvedValue({
      called: true,
      appliedCount: 1,
      suggestedCount: 1,
    });
  });

  it('supported convenience + flag ON + 本地 uncategorized → 可进入 batch fallback', async () => {
    (isBatchAiClassificationEnabled as jest.Mock).mockReturnValue(true);
    const analysis: any = {
      merchant: 'ファミリーマート',
      items: [{ name: 'なぞ商品xyz', quantity: 1, unitPrice: 100, lineTotal: 100 }],
      total: 100,
      tax: 0,
      currency: 'JPY',
    };
    const out = await applyCategoriesWithLearning(analysis);
    expect(runBatchAiFallback).toHaveBeenCalled();
    expect((out as any).classification_telemetry_v1?.merchant_type).toBe('convenience');
    expect((out as any).classification_telemetry_v1?.batch_ai_enabled).toBe(true);
  });

  it('supported convenience + flag OFF → 不调用 Batch AI', async () => {
    (isBatchAiClassificationEnabled as jest.Mock).mockReturnValue(false);
    const analysis: any = {
      merchant: 'ローソン',
      items: [{ name: 'なぞ商品xyz', quantity: 1, unitPrice: 100, lineTotal: 100 }],
      total: 100,
      tax: 0,
      currency: 'JPY',
    };
    await applyCategoriesWithLearning(analysis);
    expect(runBatchAiFallback).not.toHaveBeenCalled();
  });
});

describe('Phase 3B: Product Identity annotation', () => {
  beforeEach(() => {
    setMockLearned(null);
    (isBatchAiClassificationEnabled as jest.Mock).mockReturnValue(false);
    (runBatchAiFallback as jest.Mock).mockClear();
  });

  it('normal scan persists additive identity while preserving legacy normalized/canonical fields', async () => {
    const rawName = '明治ｵｲｼｲ牛乳900ML';
    const analysis: any = {
      merchant: 'イオン',
      items: [
        {
          name: rawName,
          quantity: 1,
          unitPrice: 280,
          lineTotal: 280,
          categoryKey: 'dairy_egg',
        },
      ],
      total: 280,
      tax: 0,
      currency: 'JPY',
    };

    const out = await applyCategoriesWithLearning(analysis);
    const item = (out.items as any[])[0];

    expect(item.normalized_name).toBe('明治ｵｲｼｲ牛乳');
    expect(item.canonical_name).toBe('明治ｵｲｼｲ牛乳');
    expect(item.normalized_full_name).toBe('明治オイシイ牛乳900ml');
    expect(item.canonical_product_name).toBe('明治 おいしい牛乳');
    expect(item.brand).toBe('明治');
    expect(item.product_family_key).toBe('milk');
    expect(item.spec_size_value).toBe(900);
    expect(item.spec_size_unit).toBe('ml');
    expect(item.spec_pack_count).toBe(1);
    expect(item.volume_base_ml).toBe(900);
    expect(item.identity_version).toBe(1);
  });
});

describe('Batch Fix A: persist merchant_type and History consistency', () => {
  beforeEach(() => {
    setMockLearned(null);
    (isBatchAiClassificationEnabled as jest.Mock).mockReturnValue(false);
    (runBatchAiFallback as jest.Mock).mockClear();
  });

  it('enriched Costco supermarket type is not downgraded by weak merchant string', () => {
    expect(
      persistMerchantTypeFromAnalysis({
        merchant_type: 'supermarket',
        merchant: 'WHOLESALE',
        items: [],
      })
    ).toBe('supermarket');
    expect(
      persistMerchantTypeFromAnalysis({
        merchant_type: 'supermarket',
        merchant: 'BIZ/GOLD',
        items: [],
      })
    ).toBe('supermarket');
  });

  it('BIZ/GOLD or WHOLESALE alone still do not become Costco when type is absent', () => {
    expect(persistMerchantTypeFromAnalysis({ merchant: 'BIZ/GOLD', items: [] })).toBe('unknown');
    expect(persistMerchantTypeFromAnalysis({ merchant: 'WHOLESALE', items: [] })).toBe('unknown');
  });

  it('cropped Costco evidence without stored type still promotes via receipt signals', () => {
    const items = [
      { name: '123456 KIRKLAND WATER E' },
      { name: '234567 BANANA E' },
      { name: '345678 CHICKEN T' },
      { name: '御買上げ点数 3' },
    ];
    expect(persistMerchantTypeFromAnalysis({ merchant: 'WHOLESALE', items })).toBe('supermarket');
  });

  it('persisted semantic category and History summary agree', async () => {
    const analysis: any = {
      merchant: 'なぞのお店xyz',
      items: [
        { name: '卵', quantity: 1, unitPrice: 200, lineTotal: 200, classification_status: 'ok' },
        { name: 'なぞ商品xyz', quantity: 1, unitPrice: 100, lineTotal: 100, classification_status: 'ok' },
      ],
      total: 300,
      tax: 0,
      currency: 'JPY',
    };
    const out = await applyCategoriesWithLearning(analysis);
    const egg = (out.items as any[])[0];
    const unknown = (out.items as any[])[1];
    expect(egg.category).toBe('food_ingredients');
    expect(unknown.category).toBe('uncategorized');
    expect(normalizePersistedProductCategory(egg.category, egg.name)).toBe(egg.category);
    expect(normalizePersistedProductCategory(unknown.category, unknown.name)).toBe('uncategorized');
    expect(normalizePersistedProductCategory('uncategorized', '卵')).toBe('uncategorized');
  });

  it('Sample 076 Edge-like ordered 割引 10% → enricher keeps effective totals; category sum 3142', async () => {
    const normalized = normalizeOcrAnalysis({
      merchant: '業務スーパー古川店',
      currency: 'JPY',
      total: 3393,
      tax: 251,
      items: [
        { name: '鶏肉', quantity: 1, unitPrice: 372, lineTotal: 372, categoryKey: 'food_ingredients' },
        { name: '割引 10%', quantity: 1, unitPrice: -38, lineTotal: -38 },
        { name: '鶏肉', quantity: 1, unitPrice: 378, lineTotal: 378, categoryKey: 'food_ingredients' },
        { name: '割引 10%', quantity: 1, unitPrice: -38, lineTotal: -38 },
        { name: 'ロッテモナ王クランキー', quantity: 1, unitPrice: 108, lineTotal: 108, categoryKey: 'snacks_drinks' },
        { name: '鎮江香醋（ちんこうこう）', quantity: 1, unitPrice: 313, lineTotal: 313, categoryKey: 'food_ingredients' },
        { name: 'むき甘栗', quantity: 1, unitPrice: 100, lineTotal: 100, categoryKey: 'snacks_drinks' },
        { name: 'うす皮付落花生（無塩）', quantity: 1, unitPrice: 103, lineTotal: 103, categoryKey: 'food_ingredients' },
        { name: 'ココアピーナッツ', quantity: 1, unitPrice: 88, lineTotal: 88, categoryKey: 'snacks_drinks' },
        { name: '正宗生煎包 4個 × @439', quantity: 1, unitPrice: 439, lineTotal: 1756, categoryKey: 'ready_to_eat' },
      ],
    } as any);
    const out = await applyCategoriesWithLearning(normalized);
    const chickens = (out.items as any[]).filter((i) => i.name === '鶏肉');
    expect(chickens[0].effectiveLineTotal).toBe(334);
    expect(chickens[1].effectiveLineTotal).toBe(340);
    expect((out.items as any[]).find((i) => String(i.name).includes('正宗生煎包'))?.quantity).toBe(4);

    const map = new Map<string, number>();
    for (const it of out.items as any[]) {
      const cat = normalizePersistedProductCategory(it.category, it.name);
      map.set(cat, (map.get(cat) ?? 0) + itemAmountForAnalytics(it));
    }
    expect(map.get('food_ingredients')).toBe(1090);
    expect(map.get('snacks_drinks')).toBe(296);
    expect(map.get('ready_to_eat')).toBe(1756);
    expect([...map.values()].reduce((s, n) => s + n, 0)).toBe(3142);
  });
});
