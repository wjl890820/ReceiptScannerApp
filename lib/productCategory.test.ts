/**
 * 商品分类体系单测：关键词分类、旧→新映射、店铺类型词不可作为分类。
 */

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

import {
  classifyItemByName,
  normalizeProductCategory,
  normalizePersistedProductCategory,
  mapKnownProductCategory,
  resolveProductCategory,
  resolveProductCategoryRuntime,
  sanitizeV1ActiveCategoryWrite,
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
  it('食パン → ready_to_eat（成品主食面包，不是食材）', () => {
    expect(classifyItemByName('食パン')).toBe('ready_to_eat');
  });
  it('未知商品 → uncategorized', () => {
    expect(classifyItemByName('xyz123')).toBe('uncategorized');
  });

  // 优先级回归：糖果/饮料语境的 ミルク/コーン/ドーナツ 必须早于食材 牛乳/ごま/抹茶
  it('NEWジャイアントコー → snacks_drinks（截断也命中）', () => {
    expect(classifyItemByName('NEWジャイアントコー')).toBe('snacks_drinks');
    expect(classifyItemByName('ジャイアントコーン')).toBe('snacks_drinks');
  });
  it('金のミルク抹茶L → snacks_drinks（糖果不是食材）', () => {
    expect(classifyItemByName('金のミルク抹茶L')).toBe('snacks_drinks');
  });
  it('LPミルクティー → snacks_drinks', () => {
    expect(classifyItemByName('LPミルクティー')).toBe('snacks_drinks');
  });
  it('あんドーナツ白ごま → snacks_drinks（早于 ごま 食材）', () => {
    expect(classifyItemByName('あんドーナツ白ごま')).toBe('snacks_drinks');
  });
  it('岩手葛巻牛乳 → food_ingredients（牛乳仍是食材）', () => {
    expect(classifyItemByName('岩手葛巻牛乳')).toBe('food_ingredients');
  });
  it('7濃い木綿2個入 → food_ingredients', () => {
    expect(classifyItemByName('7濃い木綿2個入')).toBe('food_ingredients');
  });

  // バター 甜点语境优先于食材「バター」与即食「サンド」
  it('シュガーバター / シュガーバターの木 → snacks_drinks（不是食材 バター）', () => {
    expect(classifyItemByName('シュガーバター')).toBe('snacks_drinks');
    expect(classifyItemByName('シュガーバターの木')).toBe('snacks_drinks');
  });
  it('バターサンド → snacks_drinks（不是即食 サンド）', () => {
    expect(classifyItemByName('バターサンド')).toBe('snacks_drinks');
  });
  it('バタークッキー / バターケーキ / バター菓子 → snacks_drinks', () => {
    expect(classifyItemByName('バタークッキー')).toBe('snacks_drinks');
    expect(classifyItemByName('バターケーキ')).toBe('snacks_drinks');
    expect(classifyItemByName('バター菓子')).toBe('snacks_drinks');
  });
  it('普通 バター / 有塩バター / 無塩バター 仍是 food_ingredients', () => {
    expect(classifyItemByName('バター')).toBe('food_ingredients');
    expect(classifyItemByName('有塩バター')).toBe('food_ingredients');
    expect(classifyItemByName('無塩バター')).toBe('food_ingredients');
  });

  // Sample 013 / 024 / 050 accuracy RC
  it('メキシカンサラダラップ → ready_to_eat（不是 household ラップ）', () => {
    expect(classifyItemByName('メキシカンサラダラップ')).toBe('ready_to_eat');
  });
  it('ブルダック炒麺 / ブルダック炒麺C → ready_to_eat（不是食材 麺）', () => {
    expect(classifyItemByName('ブルダック炒麺')).toBe('ready_to_eat');
    expect(classifyItemByName('ブルダック炒麺C')).toBe('ready_to_eat');
  });
  it('オサカナ プロテインボール → snacks_drinks（不是 personal_care）', () => {
    expect(classifyItemByName('オサカナ プロテインボール')).toBe('snacks_drinks');
  });
  it('サランラップ → household（食品ラップと区別）', () => {
    expect(classifyItemByName('サランラップ')).toBe('household');
  });
  it('ProGlide / カミソリ → household（V1 活跃日用）', () => {
    expect(classifyItemByName('Gillette ProGlide')).toBe('household');
    expect(classifyItemByName('カミソリ')).toBe('household');
  });

  // Samples 055 / 057 / 060 — finished food & alcohol precedence
  it('がぶっとエクレアミルククリーム → snacks_drinks（成品甜点优先于 ミルク/クリーム）', () => {
    expect(classifyItemByName('がぶっとエクレアミルククリーム')).toBe('snacks_drinks');
  });
  it('濃厚カスタードエクレア → snacks_drinks', () => {
    expect(classifyItemByName('濃厚カスタードエクレア')).toBe('snacks_drinks');
  });
  it('フジパン 生もっち → ready_to_eat（成品面包，不是食材）', () => {
    expect(classifyItemByName('フジパン 生もっち')).toBe('ready_to_eat');
  });
  it('湯こねロール → ready_to_eat', () => {
    expect(classifyItemByName('湯こねロール')).toBe('ready_to_eat');
  });
  it('普通牛乳 → food_ingredients（原料词仍可命中）', () => {
    expect(classifyItemByName('明治おいしい牛乳')).toBe('food_ingredients');
  });
  it('SVジャパンエール / ラガー / ギネス → snacks_drinks（酒类优先于 ジャパン⊃パン）', () => {
    expect(classifyItemByName('SVジャパンエール')).toBe('snacks_drinks');
    expect(classifyItemByName('SV豊潤ラガー')).toBe('snacks_drinks');
    expect(classifyItemByName('SVシルクエール')).toBe('snacks_drinks');
    expect(classifyItemByName('ギネス缶330')).toBe('snacks_drinks');
  });

  // Batch Fix A: cooking noodles vs ready-to-eat noodles
  it('半生うどん / 生うどん / 乾麺 / 冷凍うどん → food_ingredients', () => {
    expect(classifyItemByName('半生うどん')).toBe('food_ingredients');
    expect(classifyItemByName('生うどん')).toBe('food_ingredients');
    expect(classifyItemByName('生麺')).toBe('food_ingredients');
    expect(classifyItemByName('乾麺')).toBe('food_ingredients');
    expect(classifyItemByName('乾うどん')).toBe('food_ingredients');
    expect(classifyItemByName('冷凍うどん')).toBe('food_ingredients');
  });
  it('ブルダック炒麺 / 焼うどん / カップ麺 remain ready_to_eat', () => {
    expect(classifyItemByName('ブルダック炒麺')).toBe('ready_to_eat');
    expect(classifyItemByName('焼うどん')).toBe('ready_to_eat');
    expect(classifyItemByName('カップ麺')).toBe('ready_to_eat');
    expect(classifyItemByName('大盛讃岐うどん')).toBe('ready_to_eat');
  });

  // Batch Fix A: origin-labeled fresh fruit, not bare モモ
  it('豪州産モモ / 国産もも / 県産りんご → food_ingredients', () => {
    expect(classifyItemByName('豪州産モモ')).toBe('food_ingredients');
    expect(classifyItemByName('国産もも')).toBe('food_ingredients');
    expect(classifyItemByName('山梨県産桃')).toBe('food_ingredients');
    expect(classifyItemByName('青森県産りんご')).toBe('food_ingredients');
    expect(classifyItemByName('フィリピン産バナナ')).toBe('food_ingredients');
  });
  it('peach-flavored snacks/drinks stay snacks_drinks', () => {
    expect(classifyItemByName('白桃ジュース')).toBe('snacks_drinks');
    expect(classifyItemByName('白桃ティー')).toBe('snacks_drinks');
    expect(classifyItemByName('白桃ゼリー')).toBe('snacks_drinks');
    expect(classifyItemByName('白桃グミ')).toBe('snacks_drinks');
    expect(classifyItemByName('FA白桃700')).toBe('snacks_drinks');
  });
  it('bare モモ without origin stays uncategorized', () => {
    expect(classifyItemByName('モモ')).toBe('uncategorized');
  });

  // Broad-token negative cases
  it('水菜 is not a drink because of 水', () => {
    expect(classifyItemByName('水菜')).toBe('food_ingredients');
    expect(classifyItemByName('水菜')).not.toBe('snacks_drinks');
  });
  it('茶葉 is not a beverage because of 茶', () => {
    expect(classifyItemByName('茶葉')).toBe('food_ingredients');
    expect(classifyItemByName('茶葉')).not.toBe('snacks_drinks');
  });
  it('raw chicken cuts are not ready_to_eat solely because of チキン', () => {
    expect(classifyItemByName('チキンもも')).toBe('food_ingredients');
    expect(classifyItemByName('鶏もも')).toBe('food_ingredients');
    expect(classifyItemByName('チキンカツサンド')).toBe('ready_to_eat');
    expect(classifyItemByName('骨付きグリルチキン')).toBe('ready_to_eat');
    expect(classifyItemByName('ロティサリーチキン')).toBe('ready_to_eat');
  });
  it('bare 水 remains a drink', () => {
    expect(classifyItemByName('水')).toBe('snacks_drinks');
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

describe('normalizePersistedProductCategory: History 信任已落库语义', () => {
  it('stored core category is kept even if the name could map elsewhere', () => {
    expect(normalizePersistedProductCategory('food_ingredients', 'チキンカツサンド')).toBe(
      'food_ingredients'
    );
  });

  it('stored uncategorized is not reclassified by item name', () => {
    expect(normalizePersistedProductCategory('uncategorized', '卵')).toBe('uncategorized');
    expect(normalizePersistedProductCategory('uncategorized', 'チキンカツサンド')).toBe(
      'uncategorized'
    );
  });

  it('legacy grocery enums still map', () => {
    expect(normalizePersistedProductCategory('produce', 'xyz')).toBe('food_ingredients');
    expect(normalizePersistedProductCategory('quick_meals')).toBe('ready_to_eat');
  });

  it('store-type / unknown raw still falls back to item name', () => {
    expect(normalizePersistedProductCategory('コンビニ', 'クラフトボス')).toBe('snacks_drinks');
    expect(normalizePersistedProductCategory('', 'ティッシュ')).toBe('household');
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

  it('OCR categoryKey=snacks_drinks 的甜点黄油不被 バター 食材规则覆盖', () => {
    // 候选链：learned=null, 分类器=null, OCR=snacks_drinks → 应直接返回 snacks_drinks
    expect(resolveProductCategory('シュガーバター', [null, null, 'snacks_drinks'])).toBe('snacks_drinks');
    expect(normalizeProductCategory('snacks_drinks', 'シュガーバター')).toBe('snacks_drinks');
  });
});

describe('V1 active write boundary', () => {
  it('sanitizeV1ActiveCategoryWrite drops legacy personal_care/pet_care', () => {
    expect(sanitizeV1ActiveCategoryWrite('personal_care')).toBe('uncategorized');
    expect(sanitizeV1ActiveCategoryWrite('pet_care')).toBe('uncategorized');
    expect(sanitizeV1ActiveCategoryWrite('household')).toBe('household');
  });

  it('runtime: OCR personal_care on protein ball → snacks_drinks via name rule', () => {
    expect(
      resolveProductCategoryRuntime({
        itemName: 'オサカナ プロテインボール',
        ocrKey: 'personal_care',
      })
    ).toBe('snacks_drinks');
  });

  it('Sample 046 coverage: tissue/razor/meat/deli/drink', () => {
    expect(classifyItemByName('ティッシュ')).toBe('household');
    expect(classifyItemByName('ProGlide')).toBe('household');
    expect(classifyItemByName('豚バラ肉')).toBe('food_ingredients');
    expect(classifyItemByName('唐揚げ')).toBe('ready_to_eat');
    expect(classifyItemByName('コーラ')).toBe('snacks_drinks');
  });
});
