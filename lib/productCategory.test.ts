/**
 * 商品分类体系单测：关键词分类、旧→新映射、店铺类型词不可作为分类。
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

import {
  classifyItemByName,
  normalizeProductCategory,
  mapKnownProductCategory,
  resolveProductCategory,
  PRODUCT_CATEGORIES,
} from './productCategory';

describe('classifyItemByName: 关键词分类', () => {
  it('チキンカツサンド → ready_to_eat', () => {
    expect(classifyItemByName('チキンカツサンド')).toBe('ready_to_eat');
  });
  it('クラフトボス → snacks_drinks', () => {
    expect(classifyItemByName('クラフトボス')).toBe('snacks_drinks');
  });
  it('7P プレミアム ヒトクチクレープチョコ → snacks_drinks', () => {
    expect(classifyItemByName('7P プレミアム ヒトクチクレープチョコ')).toBe('snacks_drinks');
  });
  it('豆腐 → food_ingredients', () => {
    expect(classifyItemByName('豆腐')).toBe('food_ingredients');
  });
  it('ティッシュ → household', () => {
    expect(classifyItemByName('ティッシュ')).toBe('household');
  });
  it('マスク → personal_care', () => {
    expect(classifyItemByName('マスク')).toBe('personal_care');
  });
  it('猫砂 → pet_care', () => {
    expect(classifyItemByName('猫砂')).toBe('pet_care');
  });
  it('化粧水 不被误判为饮料 → personal_care', () => {
    expect(classifyItemByName('化粧水')).toBe('personal_care');
  });
  it('惣菜パン → ready_to_eat（早于 パン 食材）', () => {
    expect(classifyItemByName('惣菜パン')).toBe('ready_to_eat');
  });
  it('食パン → food_ingredients', () => {
    expect(classifyItemByName('食パン')).toBe('food_ingredients');
  });
  it('未知商品 → uncategorized', () => {
    expect(classifyItemByName('xyz123')).toBe('uncategorized');
  });
});

describe('normalizeProductCategory: 旧→新映射 + 店铺词过滤', () => {
  it('旧 enum prepared_food → ready_to_eat', () => {
    expect(normalizeProductCategory('prepared_food')).toBe('ready_to_eat');
  });
  it('旧 enum beverage / snack → snacks_drinks', () => {
    expect(normalizeProductCategory('beverage')).toBe('snacks_drinks');
    expect(normalizeProductCategory('snack')).toBe('snacks_drinks');
  });
  it('旧 16 类 snacks_sweets / non_alcoholic_drinks / alcohol → snacks_drinks', () => {
    expect(normalizeProductCategory('snacks_sweets')).toBe('snacks_drinks');
    expect(normalizeProductCategory('non_alcoholic_drinks')).toBe('snacks_drinks');
    expect(normalizeProductCategory('alcohol')).toBe('snacks_drinks');
  });
  it('旧 produce / meat_seafood / dairy_eggs / staples → food_ingredients', () => {
    expect(normalizeProductCategory('produce')).toBe('food_ingredients');
    expect(normalizeProductCategory('meat_seafood')).toBe('food_ingredients');
    expect(normalizeProductCategory('dairy_eggs')).toBe('food_ingredients');
    expect(normalizeProductCategory('staples')).toBe('food_ingredients');
  });
  it('health_supplements → personal_care', () => {
    expect(normalizeProductCategory('health_supplements')).toBe('personal_care');
  });
  it('合法新 enum 原样保留', () => {
    for (const c of PRODUCT_CATEGORIES) {
      expect(normalizeProductCategory(c)).toBe(c);
    }
  });
  it('店铺类型词 + itemName → 用商品名分类', () => {
    expect(normalizeProductCategory('非超市', 'チキンカツサンド')).toBe('ready_to_eat');
    expect(normalizeProductCategory('コンビニ', 'クラフトボス')).toBe('snacks_drinks');
    expect(normalizeProductCategory('スーパー', '豆腐')).toBe('food_ingredients');
    expect(normalizeProductCategory('non_grocery', 'ティッシュ')).toBe('household');
  });
  it('店铺类型词且无商品名 → uncategorized（绝不作为分类）', () => {
    expect(normalizeProductCategory('非超市')).toBe('uncategorized');
    expect(normalizeProductCategory('便利店')).toBe('uncategorized');
    expect(normalizeProductCategory('コンビニ')).toBe('uncategorized');
    expect(normalizeProductCategory('スーパー')).toBe('uncategorized');
    expect(normalizeProductCategory('non_grocery')).toBe('uncategorized');
  });
  it('空 / 非法值 → uncategorized', () => {
    expect(normalizeProductCategory('')).toBe('uncategorized');
    expect(normalizeProductCategory(null)).toBe('uncategorized');
    expect(normalizeProductCategory('随便乱填')).toBe('uncategorized');
  });

  it('rawCategory=other/uncategorized 但商品名可识别 → 用商品名覆盖（避免 other 滥用）', () => {
    expect(normalizeProductCategory('other', '豆腐')).toBe('food_ingredients');
    expect(normalizeProductCategory('uncategorized', 'チキンカツサンド')).toBe('ready_to_eat');
    expect(normalizeProductCategory('other_grocery', 'クラフトボス')).toBe('snacks_drinks');
  });

  it('rawCategory=other 且商品名无法识别 → 保留 other', () => {
    expect(normalizeProductCategory('other', 'xyz123')).toBe('other');
    expect(normalizeProductCategory('other_grocery', 'xyz123')).toBe('other');
  });

  it('rawCategory=uncategorized 且商品名无法识别 → uncategorized', () => {
    expect(normalizeProductCategory('uncategorized', 'xyz123')).toBe('uncategorized');
  });
});

describe('mapKnownProductCategory / resolveProductCategory', () => {
  it('mapKnownProductCategory 不触发关键词回退', () => {
    expect(mapKnownProductCategory('snacks_sweets')).toBe('snacks_drinks');
    expect(mapKnownProductCategory('非超市')).toBeNull();
    expect(mapKnownProductCategory('uncategorized')).toBeNull();
    expect(mapKnownProductCategory('')).toBeNull();
  });
  it('resolveProductCategory: learned > 分类器 > OCR > 关键词 > uncategorized', () => {
    // learned 命中
    expect(resolveProductCategory('クラフトボス', ['food_ingredients', null, null])).toBe(
      'food_ingredients'
    );
    // 候选均为店铺词/空 → 用商品名
    expect(resolveProductCategory('クラフトボス', ['非超市', null, undefined])).toBe('snacks_drinks');
    // 全部未知且名字也未知 → uncategorized
    expect(resolveProductCategory('xyz', [null, null, null])).toBe('uncategorized');
    // 候选映射为 other 且名字未知 → other
    expect(resolveProductCategory('xyz', ['other_grocery', null, null])).toBe('other');
    // 候选映射为 other 但名字可识别 → 优先核心分类
    expect(resolveProductCategory('豆腐', ['other_grocery', null, null])).toBe('food_ingredients');
  });
});
