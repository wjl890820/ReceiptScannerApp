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
jest.mock('./groceryDetector', () => ({ isGroceryMerchant: () => true }));
jest.mock('./categoryLearner', () => ({
  getLearnedCategory: jest.fn(async () => null),
  learnCategoryMapping: jest.fn(async () => {}),
}));
jest.mock('./productAlias', () => ({ lookupProductNameAlias: jest.fn(async () => null) }));
jest.mock('./categoryBatchAi', () => ({
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
