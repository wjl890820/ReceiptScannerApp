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

import { resolveProductCategoryRuntime } from './productCategory';
import { applyCategoriesWithLearning } from './receiptEnricher';
import { runBatchAiFallback } from './categoryBatchAi';
import { isBatchAiClassificationEnabled } from './env';

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

  it('other merchant（药妆）→ 全部 uncategorized，不调用 Batch AI', async () => {
    const out = await enrichAtMerchant('マツキヨ', 'シャンプー', 'personal_care', 500);
    expect((out as any).merchant_type).toBe('other');
    expect((out.items as any[])[0].category).toBe('uncategorized');
    expect(runBatchAiFallback).not.toHaveBeenCalled();
    expect((out as any).classification_telemetry_v1?.batch_ai_called).toBe(false);
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
