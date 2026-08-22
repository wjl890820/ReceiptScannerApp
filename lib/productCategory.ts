/**
 * 统一的商品一级分类（面向"超市/便利店小票 + 生活建议"，刻意保持少而稳定）。
 *
 * 这是 item.category 的唯一真源：OCR/旧分类/店铺类型词都必须经过本模块归一，
 * 绝不允许"非超市/便利店/超市/コンビニ/スーパー"等店铺类型作为商品分类。
 *
 * Taxonomy / active-write lists live in productTaxonomy.ts (M1-A SSOT).
 * 纯函数、无副作用、可单测；不依赖 categories.ts（避免循环依赖）。
 */

import {
  SYSTEM_CATEGORY_STATES,
  V1_SPENDING_CATEGORIES,
  V1_WRITABLE_CATEGORIES,
  isSystemCategoryState,
  isV1SpendingCategory,
  isV1WritableCategory,
} from './productTaxonomy';

export type ProductCategory =
  | 'food_ingredients' // 食材
  | 'ready_to_eat' // 即食餐
  | 'snacks_drinks' // 饮料零食
  | 'household' // 日用消耗
  | 'personal_care' // 个人护理
  | 'pet_care' // 宠物用品
  | 'uncategorized' // 系统/待审核状态（非正常消费类别）
  | 'other'; // 其他

/** 全部可选分类（用于审核页/详情页选择列表） */
export const PRODUCT_CATEGORIES: readonly ProductCategory[] = [
  ...V1_SPENDING_CATEGORIES.slice(0, 6),
  ...SYSTEM_CATEGORY_STATES,
  'other',
];

/** 核心生活分类（参与分类统计；不含 uncategorized / other） */
export const CORE_PRODUCT_CATEGORIES: readonly ProductCategory[] = [
  'food_ingredients',
  'ready_to_eat',
  'snacks_drinks',
  'household',
  'personal_care',
  'pet_care',
];

/**
 * V1 可写入活跃集 = 七个消费类别 + uncategorized 系统状态。
 * Re-export spending list for Analysis (excludes uncategorized).
 */
export const V1_SPENDING_PRODUCT_CATEGORIES: readonly ProductCategory[] =
  V1_SPENDING_CATEGORIES as readonly ProductCategory[];

export const V1_ACTIVE_PRODUCT_CATEGORIES: readonly ProductCategory[] =
  V1_WRITABLE_CATEGORIES as readonly ProductCategory[];

/**
 * @deprecated M1-A: personal_care / pet_care are active V1 spending categories.
 * Kept empty for call-site compatibility.
 */
export const V1_LEGACY_COMPAT_PRODUCT_CATEGORIES: readonly ProductCategory[] = [];

export {
  isSystemCategoryState,
  isV1SpendingCategory,
  isV1WritableCategory,
};

function isProductCategory(v: string): v is ProductCategory {
  return (PRODUCT_CATEGORIES as readonly string[]).includes(v);
}

/**
 * 店铺类型词绝不允许作为商品分类。它们不在 OLD_TO_NEW / 新 enum 中，
 * 因此会被自动当作"未知 rawCategory"忽略，转而用 itemName 分类。
 * （此处仅作文档说明：非超市 / 超市 / 便利店 / コンビニ / スーパー / grocery /
 *   non_grocery / store / merchant / drugstore / restaurant 等。）
 */

/**
 * 旧分类 / OCR categoryKey / V1 main → 新分类映射。
 * 不包含 uncategorized（保持原样）与店铺类型词（在 STORE_TYPE_WORDS 处理）。
 */
const OLD_TO_NEW: Record<string, ProductCategory> = {
  // ---- 旧 16 类 grocery ----
  produce: 'food_ingredients',
  meat_seafood: 'food_ingredients',
  dairy_eggs: 'food_ingredients',
  bakery: 'food_ingredients',
  staples: 'food_ingredients',
  condiments: 'food_ingredients',
  quick_meals: 'ready_to_eat',
  frozen_foods: 'ready_to_eat',
  canned_preserved: 'food_ingredients',
  snacks_sweets: 'snacks_drinks',
  non_alcoholic_drinks: 'snacks_drinks',
  beverages_other: 'snacks_drinks',
  alcohol: 'snacks_drinks',
  household: 'household',
  health_supplements: 'personal_care',
  other_grocery: 'other',
  // ---- OCR prompt categoryKey ----
  fresh: 'food_ingredients',
  staple: 'food_ingredients',
  dairy_egg: 'food_ingredients',
  snack: 'snacks_drinks',
  drink: 'snacks_drinks',
  frozen_deli: 'ready_to_eat',
  seasoning: 'food_ingredients',
  // household / alcohol 已在上面
  other: 'other',
  // ---- 此前提案 / V1 main 等历史值 ----
  prepared_food: 'ready_to_eat',
  beverage: 'snacks_drinks',
  beverages: 'snacks_drinks',
  snacks: 'snacks_drinks',
  ingredients: 'food_ingredients',
  daily_goods: 'household',
  health: 'personal_care',
  other_food: 'other',
};

function toHalfWidthLower(s: string): string {
  return (s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .trim();
}

function nameHasAny(n: string, needles: readonly string[]): boolean {
  return needles.some((k) => n.includes(toHalfWidthLower(k)));
}

/** Drink/snack flavor context: peach juice etc. must win over fresh-produce origin. */
function hasSnackOrDrinkFlavorContext(n: string): boolean {
  return nameHasAny(n, [
    'ジュース',
    'ティー',
    'ゼリー',
    'グミ',
    'ドリンク',
    'ラテ',
    'ソーダ',
    'ネクター',
    'キャンディ',
    '飴',
    'アイス',
    'チョコ',
    '菓子',
    'スナック',
    'コーラ',
    'サイダー',
    'スムージー',
  ]);
}

/** Dry / fresh / frozen noodles that still need cooking — not convenience meals. */
function isCookingNoodleIngredient(n: string): boolean {
  return nameHasAny(n, [
    '半生うどん',
    '半生麺',
    '生うどん',
    '生そば',
    '生麺',
    '乾うどん',
    '乾そば',
    '乾麺',
    '冷凍うどん',
    '冷凍そば',
    '冷凍麺',
  ]);
}

/** Raw chicken cuts: must not become ready_to_eat solely because of チキン. */
function isRawChickenCut(n: string): boolean {
  // Prepared chicken dishes like "若鶏唐揚" must be ready-to-eat,
  // even though they contain raw chicken tokens such as 若鶏/鶏/もも.
  if (nameHasAny(n, ['唐揚', 'からあげ', '唐揚げ'])) return false;
  return nameHasAny(n, [
    'チキンもも',
    '鶏もも',
    'とりもも',
    'チキンむね',
    '鶏むね',
    'とりむね',
    'むね肉',
    'チキンささみ',
    '鶏ささみ',
    '若鶏',
    '鶏肉',
    '生チキン',
  ]);
}

/**
 * Cooking oil: サラダ油 / キャノーラ油 / 食用油 / 料理用油 etc. are ingredients.
 * Must fire before the ready_to_eat block where 「サラダ」 would otherwise win.
 * Protects prepared salads (ポテトサラダ / マカロニサラダ) — those do NOT contain 「油」
 * so this guard leaves them in the ready_to_eat path.
 */
function isCookingOil(n: string): boolean {
  return nameHasAny(n, [
    'サラダ油', 'キャノーラ油', '食用油', '料理用油', 'てんぷら油', '天ぷら油',
    'オリーブ油', 'ごま油', 'こめ油', 'こめ油', '大豆油', 'なたね油', 'ひまわり油',
    'vegetable oil', 'canola oil', 'olive oil',
  ]);
}

/**
 * Raw meat cut where カツリ / カツ follows a meat-part or origin prefix.
 * Examples: 豪州産モモカツリ, 豚モモカツリ, 国産モモ肉カツ用.
 * Prepared dishes (チキンカツサンド / カツカレー / カツ丼) have their own tokens
 * (サンド / カレー / 丼) that will match the ready_to_eat block, so they are safe.
 * Guard: カツ token must be preceded by a meat-part (モモ/ロース/ヒレ/肩) or origin marker.
 */
function isRawMeatCutKatsu(n: string): boolean {
  // カツリ is always a raw Costco-style thin-cut designation (not a dish)
  if (n.includes('カツリ') || n.includes('かつり')) return true;
  // カツ preceded by meat-body-part token → raw cut, not a prepared dish
  const meatPartBeforeKatsu = /(?:もも|モモ|ロース|ひれ|ヒレ|肩|かた|バラ|ばら)(?:肉)?(?:カツ|かつ)/;
  return meatPartBeforeKatsu.test(n);
}

const FRESH_FRUIT_IDENTITY = [
  'モモ',
  'もも',
  '桃',
  'りんご',
  'リンゴ',
  '林檎',
  'バナナ',
  'ばなな',
  'みかん',
  'ミカン',
  '蜜柑',
  'ぶどう',
  'ブドウ',
  '葡萄',
  'いちご',
  'イチゴ',
  '梨',
  'キウイ',
  'メロン',
  'すいか',
  'スイカ',
  'レモン',
  'オレンジ',
] as const;

/**
 * Origin-labeled fresh produce (豪州産モモ / 国産もも / 県産りんご).
 * Requires origin marker immediately before the fruit token. Bare モモ is not enough.
 */
function isOriginLabeledFreshFruit(n: string): boolean {
  if (hasSnackOrDrinkFlavorContext(n)) return false;
  const originBeforeFruit =
    /(?:国産|[一-龯]{1,4}(?:都|道|府|県)産|[ァ-ヴーA-Za-z]{2,}産|[一-龯]{2,}産)の?$/;
  for (const fruit of FRESH_FRUIT_IDENTITY) {
    const f = toHalfWidthLower(fruit);
    let from = 0;
    while (from <= n.length) {
      const idx = n.indexOf(f, from);
      if (idx < 0) break;
      if (originBeforeFruit.test(n.slice(0, idx))) return true;
      from = idx + f.length;
    }
  }
  return false;
}

/**
 * Unambiguous bare-fruit match that does NOT require an origin prefix:
 *   - すいか / スイカ (watermelon — no body-part ambiguity unlike モモ)
 *   - カット + any FRESH_FRUIT_IDENTITY token (cut-fruit tray, clearly fresh produce)
 * Beverage/snack form tokens (スムージー, ジュース, …) prevent matching via
 * hasSnackOrDrinkFlavorContext. Other bare fruit words (モモ, バナナ, …) still
 * require an origin prefix through isOriginLabeledFreshFruit.
 */
function isBareOrCutFreshFruit(n: string): boolean {
  if (hasSnackOrDrinkFlavorContext(n)) return false;
  // n is already toHalfWidthLower'd by the caller
  if (n.includes('すいか') || n.includes('スイカ')) return true;
  if (n.includes('カット') || n.includes('かっと') || n.includes('cut')) {
    return FRESH_FRUIT_IDENTITY.some((fruit) => n.includes(toHalfWidthLower(fruit)));
  }
  return false;
}

/**
 * 关键词分类（覆盖超市/便利店常见商品）。返回核心分类或 uncategorized。
 * 顺序很重要：先匹配更具体/更易误伤的类别（pet/personal_care/household），
 * 再 ready_to_eat（サンド/惣菜パン 等需早于 food_ingredients 的"パン"），最后 food_ingredients。
 */
export function classifyItemByName(itemName: string): ProductCategory {
  const n = toHalfWidthLower(itemName);
  if (!n) return 'uncategorized';

  const has = (arr: string[]) => arr.some((k) => n.includes(toHalfWidthLower(k)));

  // 宠物用品（很具体，优先）
  if (
    has([
      'ペットフード', 'ドッグフード', 'キャットフード', 'ペットシーツ', 'ペット用', 'ペットウェット',
      'ペットおやつ', 'ちゅーる', 'チュール', '猫缶', '犬缶', '猫砂', 'トイレ砂', 'ねこ砂',
      '猫', '犬', 'ペット', 'cat food', 'dog food', 'pet',
    ])
  ) {
    return 'pet_care';
  }

  // 个人护理（V1 active spending）。含"化粧水"等含"水"词，必须早于饮料。
  // 剃须刀仍归 household（历史语义；不在本阶段批量改写日用→个护）。
  if (
    has([
      '歯ブラシ', '歯磨き', 'ハミガキ', 'シャンプー', 'リンス', 'コンディショナー', 'ボディソープ',
      '洗顔', '化粧水', '乳液', 'スキンケア', 'マスク', '目薬', '医薬', '絆創膏', 'ばんそうこう',
      'サプリ', 'ビタミン', '生理用品', 'ナプキン', 'コンタクト', '薬',
    ])
  ) {
    return 'personal_care';
  }

  // 日用消耗（食品包装の「ラップ」より先にサランラップ系を日用扱い；食品ラップは下方で即食）
  if (
    has([
      'ティッシュ', 'キッチンペーパー', 'トイレット', 'トイレ紙', '洗剤', '柔軟剤', '漂白',
      'ゴミ袋', 'ごみ袋', 'サランラップ', 'アルミホイル', 'ホイル', '電池', '乾電池', '掃除',
      'スポンジ', 'ハンドソープ', '食器用', '住居用', 'キッチン用', '使い捨て',
      'カミソリ', '髭剃り', '剃刀', 'razor', 'proglide', 'ジレット',
      '竹箸', '割り箸', '箸', 'お箸', 'ショッピングバッグ', 'レジ袋', '買い物袋',
    ])
  ) {
    return 'household';
  }

  // 保鲜膜「ラップ」単独（サラダラップ等の食品名は ready_to_eat 側で先に食コンテキスト判定）
  if (has(['ラップ']) && !has(['サラダ', 'メキシカン', 'sandwich', 'サンド', 'burrito', 'タコス', 'トルティー'])) {
    return 'household';
  }

  // 甜点/零食语境的「バター」系列（シュガーバター / バターサンド / バタークッキー 等）。
  // 必须早于 ready_to_eat 的「サンド」与 food_ingredients 的「バター」，否则会被误判：
  //   - シュガーバター 命中食材「バター」→ food_ingredients（错）
  //   - バターサンド   命中即食「サンド」→ ready_to_eat（错）
  // 普通 バター / 有塩バター / 無塩バター 不含这些复合词，仍走下方食材规则。
  if (
    has([
      'シュガーバター', 'バターサンド', 'バタークッキー', 'バターケーキ', 'バター菓子',
      'バターサブレ', 'バターフィナンシェ', 'バターワッフル',
    ])
  ) {
    return 'snacks_drinks';
  }

  // Broad-token collisions that must not wait until snacks_drinks / ready_to_eat.
  if (has(['水菜', 'みずな', 'ミズナ'])) return 'food_ingredients';
  if (has(['茶葉', '茶の葉'])) return 'food_ingredients';
  if (isCookingNoodleIngredient(n)) return 'food_ingredients';
  if (isRawChickenCut(n)) return 'food_ingredients';

  // 料理用油: サラダ油 / キャノーラ油 / 食用油 etc. must be ingredients even though
  // 「サラダ」alone maps to ready_to_eat. Match before the ready_to_eat block.
  if (isCookingOil(n)) return 'food_ingredients';

  // Raw meat cut: 豪州産モモカツリ / 豚モモカツリ — origin or meat-part before カツリ/カツ.
  // Keeps prepared dishes (チキンカツサンド / カツカレー) safely in ready_to_eat.
  if (isRawMeatCutKatsu(n)) return 'food_ingredients';

  // Cooking base / curry seasoning:
  // "○○の素" / "ペースト" must be ingredients, even though broad "カレー" normally maps to ready_to_eat.
  if (n.includes('カレー') && (n.includes('の素') || n.includes('ペースト'))) {
    return 'food_ingredients';
  }

  // 即食餐（サンド/丼/ラーメン/さつまあげ/肉まん 等需早于 snacks_drinks 与 food_ingredients）
  // 炒麺/ブルダック等インスタント麺は食材の「麺」より先。サラダラップ等の食品ラップもここ。
  // 半生/生麺/乾麺/冷凍うどん 已在上方收成食材；此处保留即食うどん（讃岐・焼うどん等）。
  // 裸「チキン」过宽，只保留明确即食复合词。
  if (
    has([
      '弁当', 'べんとう', 'おにぎり', 'お握り', 'サンド', 'サンドイッチ', 'バーガー', 'ホットスナック',
      'グリルチキン', 'チキン南蛮', 'フライドチキン', 'ローストチキン', 'ロティサリーチキン', 'ロティサリー', '南蛮', 'からあげ',
      '唐揚', '唐揚げ', '牛すき煮', 'カツ', 'コロッケ', 'メンチ',
      '惣菜', '総菜', '惣菜パン', 'サラダ', 'パスタ', 'うどん', 'そば', 'ラーメン', 'ワンタン', 'ワンタン麺',
      '炒麺', 'カップ麺', 'カップめん', 'ヌードル', 'ブルダック', 'buldak', 'インスタント麺',
      '焼うどん', '焼きうどん', '焼きそば', '焼そば',
      '冷やし中華', '担々麺', 'たんたんめん',
      'グラタン', 'ドリア', 'カレー', '寿司', 'すし', 'おでん', '中華まん', '肉まん', 'まん', '丼',
      '生煎', '生煎包', '餃子', '焼売', 'しゅうまい',
      'ぼうとう', 'ほうとう', 'さつまあげ', 'さつま揚げ', '横浜家系', '家系', 'deli', 'bento',
    ])
  ) {
    return 'ready_to_eat';
  }

  // 食品ラップ（メキシカンサラダラップ等）：household の単独「ラップ」より食品文脈を優先
  if (
    has(['ラップ']) &&
    has(['サラダ', 'メキシカン', 'チキン', 'ビーフ', 'ポーク', 'チーズ', 'burrito', 'タコス', 'トルティー', 'サンド'])
  ) {
    return 'ready_to_eat';
  }

  // 饮料零食（含酒类、糖果、点心饮料语境的 ミルク 系列）
  // 注意：以下糖果/饮料语境的 ミルク/抹茶/コーン/ドーナツ 必须早于下方
  //       食材规则里的 牛乳 / ごま / 抹茶 等，避免「金のミルク / 抹茶ラテ /
  //       ミルクティー / あんドーナツ / ジャイアントコーン」被误判为食材。
  // プロテインボール/バーは食品スナック（サプリのプロテインより先に判定）。
  // 成品甜点（エクレア等）必须早于宽泛 ミルク/クリーム 食材规则。
  if (
    has([
      'コーヒー', '珈琲', 'georgia', 'ジョージア', 'boss', 'ボス', 'クラフトボス', 'ラテ', 'チャイラテ', 'ミルクティー', 'スムージー',
      '抹茶ラテ', '抹茶ミルク', '金のミルク', 'ミルクチョコ', 'お茶', '茶',
      '緑茶', '水', 'ノミズ', 'ミネラルウォーター', 'サイダー', '三ツ矢', 'レモネード', 'ジュース', 'コーラ', 'コカゼロ',
      'カフェ', '炭酸', 'ドリンク', 'エナジー', 'チョコ', 'ショコラ', 'カカオ', 'クリスプ', 'アーモンド',
      'グミ', 'クッキー', 'ビス', 'ビスケット', 'アイス', 'あずきバー', 'モナカ', '大福', '黒糖', 'スコーン',
      'クロッカン', 'クロワッサン', 'ドーナツ', 'あんドーナツ', 'カスタード', 'くちどけ', '白桃', 'ブラックムーン',
      'ジャイアントコーン', 'ジャイアントコー',
      'エクレア', 'クレープ', 'たい焼き', '鯛焼き', 'シュークリーム', '菓子パン', 'ロールケーキ',
      'ティラミス', 'エクレール', '杏仁豆腐バー',
      '黒コッペ', 'コッペ', '菓子', 'スナック', 'ポテト', 'ポテチ', 'キャンディ', '飴', 'プリン', 'ゼリー',
      'デザート', 'ケーキ', 'せんべい', '煎餅', 'ビール', '酒', 'ワイン', 'ハイボール', 'チューハイ',
      '焼酎', '日本酒', '発泡', '発泡酒', 'エール', 'ale', 'ラガー', 'lager', 'ギネス', 'stout', 'ビール',
      'ジンジャー', 'ドクターペッパー', 'pepper', 'coffee', 'tea', 'juice', 'cola', 'snack', 'chocolate', 'beer', 'wine',
      'プロテインボール', 'プロテインバー', 'protein ball', 'protein bar', 'プロテインスナック',
    ])
  ) {
    return 'snacks_drinks';
  }

  // 主食型成品面包 / 餐包（甜点零食之后、食材之前；避免 ジャパン 等误伤）
  if (hasMealBakeryBread(n)) {
    return 'ready_to_eat';
  }

  // 産地ラベル付き鮮果（白桃ジュース等のスナック語が先に命中した後）。
  if (isOriginLabeledFreshFruit(n)) {
    return 'food_ingredients';
  }

  // 裸鮮果（カット/国産 等の接頭辞を含む）：飲料形態語（スムージー等）がなければ食材。
  if (isBareOrCutFreshFruit(n)) {
    return 'food_ingredients';
  }

  // 食材（注意：牛乳 归食材，但 ミルクティー/ミルク抹茶 等已在上面 snacks 命中）
  // 「麺」は即食インスタント語が未命中のときのみ（生麺・乾麺など食材）。
  // 裸「パン」已上移到成品面包；这里仅保留 パン粉 等原料，避免 ジャパン/フジパン 误伤。
  if (
    has([
      '豆腐', '木綿', '卵', '鶏卵', '玉子', 'たまご', '牛乳', 'ギュウニュウ', '牛乳', '野菜', 'ヤサイ', '肉', '魚', '米', 'ごはん',
      'ご飯', 'パン粉', '小麦粉', '麺', 'めん', '納豆', 'なっとう', 'ヨーグルト', 'チーズ', 'バター', '味噌',
      'みそ', '醤油', 'しょうゆ', '味ぽん', '砂糖', '塩', '油', 'メークイン', 'じゃがいも', 'いも', '玉ねぎ',
      'たまねぎ', 'キャベツ', 'レタス', 'トマト', 'にんじん', '人参', 'パクチー', 'きのこ', 'えのき', 'えのき茸',
      'エノキ', 'まいたけ', 'とりささみ', 'ささみ', 'とりきも', '砂肝', '豚', '鶏', '牛', 'ハム', 'ベーコン',
      'ケール', 'ラム肩', 'カタロース', 'ロース', 'prime', 'プライム',
      'vegetable', 'fruit', 'meat', 'fish', 'rice', 'egg', 'milk', 'tofu',
    ])
  ) {
    return 'food_ingredients';
  }

  return 'uncategorized';
}

/**
 * Meal / staple bakery finished goods → ready_to_eat.
 * Strips false-positive substrings (ジャパン, パン粉, …) before matching パン.
 */
function hasMealBakeryBread(n: string): boolean {
  if (!n) return false;
  if (n.includes('ライ麦ロール')) return true;
  // Sweet roll cake / paper goods are not meal bread.
  if (n.includes('ロールケーキ') || n.includes('ケーキロール')) return false;
  if (n.includes('キッチンロール') || n.includes('ペーパーロール')) return false;
  if (n.includes('パン粉') || n.includes('フライパン') || n.includes('パンツ')) return false;

  if (
    n.includes('食パン') ||
    n.includes('ロールパン') ||
    n.includes('フランスパン') ||
    n.includes('コッペパン') ||
    n.includes('バゲット') ||
    n.includes('湯こね')
  ) {
    return true;
  }

  // Brand/product names containing パン (フジパン …) after removing ジャパン etc.
  const probe = n.replace(/ジャパン/g, '').replace(/ヒスパニ/g, '').replace(/スパニッシュ/g, '');
  return probe.includes('パン');
}

/**
 * History / Review display: trust an already-persisted semantic ProductCategory.
 * Does not re-run name rules when stored is uncategorized/other (Scan/History must agree).
 * Legacy grocery enums still map; store-type / unknown raw still fall back to itemName.
 */
export function normalizePersistedProductCategory(
  rawCategory: unknown,
  itemName?: string
): ProductCategory {
  const raw = typeof rawCategory === 'string' ? rawCategory.trim() : '';
  const low = toHalfWidthLower(raw);

  if (raw && isProductCategory(low)) return low;

  if (raw) {
    const mapped = OLD_TO_NEW[low];
    if (mapped) return mapped;
  }

  if (itemName) {
    const byName = classifyItemByName(itemName);
    if (byName !== 'uncategorized') return byName;
  }

  return 'uncategorized';
}

/**
 * 归一化任意来源的分类值到新 enum。顺序：
 * 1. 已是合法新 enum → 直接使用
 * 2. 旧 enum → 映射
 * 3. 店铺类型词 → 忽略 rawCategory，改用 itemName
 * 4. 按 itemName 关键词分类
 * 5. 仍未知 → uncategorized
 *
 * Backfill / repair path: uncategorized/other may be reclassified by itemName.
 * History display should use normalizePersistedProductCategory instead.
 */
export function normalizeProductCategory(
  rawCategory: unknown,
  itemName?: string
): ProductCategory {
  const raw = typeof rawCategory === 'string' ? rawCategory.trim() : '';
  const low = toHalfWidthLower(raw);

  // 1 / 2. 先做"已知映射"。但 other / uncategorized 不直接返回——
  //        若 itemName 能明确分类，则用商品名结果覆盖（避免 other 滥用）。
  if (raw) {
    if (isProductCategory(low) && low !== 'other' && low !== 'uncategorized') return low;
    const mapped = OLD_TO_NEW[low];
    if (mapped && mapped !== 'other') return mapped;
  }

  // 3 / 4. 店铺类型词 / 未知 rawCategory / other / uncategorized：用商品名关键词分类
  if (itemName) {
    const byName = classifyItemByName(itemName);
    if (byName !== 'uncategorized') return byName;
  }

  // 5. 商品名无法判断时，仅在 rawCategory 明确为 other 时才返回 other，否则 uncategorized。
  if (raw && (low === 'other' || OLD_TO_NEW[low] === 'other')) return 'other';
  return 'uncategorized';
}

/**
 * 仅做"已知映射"，不触发关键词回退；未知/店铺词/uncategorized/空 → null。
 * 供 enricher 构造候选链（learned → 分类器 → OCR）时按优先级择取。
 */
export function mapKnownProductCategory(rawCategory: unknown): ProductCategory | null {
  const raw = typeof rawCategory === 'string' ? rawCategory.trim() : '';
  if (!raw) return null;
  const low = toHalfWidthLower(raw);
  if (low === 'uncategorized') return null;
  if (isProductCategory(low)) return low;
  // 店铺类型词不在 OLD_TO_NEW，返回 null（绝不作为分类）
  return OLD_TO_NEW[low] ?? null;
}

/**
 * enricher 用：按优先级择取分类。
 * candidates 依次为：本地学习 → 分类器结果(旧/新) → OCR categoryKey。
 * 都未命中合法核心分类时，用商品名关键词；再不行则 other（若有候选映射为 other）或 uncategorized。
 */
export function resolveProductCategory(
  itemName: string,
  candidates: Array<string | null | undefined>
): ProductCategory {
  let otherSeen = false;
  for (const c of candidates) {
    const got = mapKnownProductCategory(c);
    if (!got) continue;
    if (got === 'other') {
      otherSeen = true;
      continue;
    }
    return got; // 命中核心分类
  }
  const byName = classifyItemByName(itemName);
  if (byName !== 'uncategorized') return byName;
  return otherSeen ? 'other' : 'uncategorized';
}

/**
 * 运行时分类优先级（enricher 用，区分候选来源，修复“宽泛 dictionary 覆盖具体商品名规则”）。
 * 顺序：
 *   1. 用户学习（learned）           —— 最高
 *   2. alias / 学习映射（aliasOrLearned）
 *   3. 具体商品名规则（classifyItemByName）—— 必须早于宽泛 dictionary / OCR
 *   4. 本地规则 itemRulesV1（rule）
 *   5. 宽泛词典（dictionary）
 *   6. OCR categoryKey（ocrKey，仅辅助 fallback，不覆盖上面任何明确结果）
 *   7. 其它：若有候选映射为 other 则 other，否则 uncategorized
 *
 * 关键：シュガーバター 命中 dictionary 的 バター→food_ingredients，但第 3 步的商品名规则
 * 会先返回 snacks_drinks；とりきも 命中 OCR=ready_to_eat，但第 3 步商品名规则返回
 * food_ingredients，OCR 不会覆盖。
 */
export function resolveProductCategoryRuntime(input: {
  itemName: string;
  learned?: string | null;
  aliasOrLearned?: string | null;
  rule?: string | null;
  dictionary?: string | null;
  ocrKey?: string | null;
}): ProductCategory {
  const { itemName, learned, aliasOrLearned, rule, dictionary, ocrKey } = input;
  let otherSeen = false;
  const consider = (raw: string | null | undefined): ProductCategory | null => {
    const got = mapKnownProductCategory(raw);
    if (!got) return null;
    if (got === 'other') {
      otherSeen = true;
      return null;
    }
    return got;
  };

  // 1. 用户学习
  let r = consider(learned);
  if (r) return sanitizeV1ActiveCategoryWrite(r);
  // 2. alias / 学习映射分类器结果
  r = consider(aliasOrLearned);
  if (r) return sanitizeV1ActiveCategoryWrite(r);
  // 3. 具体商品名规则（早于宽泛 dictionary / OCR）
  const byName = classifyItemByName(itemName);
  if (byName !== 'uncategorized') return sanitizeV1ActiveCategoryWrite(byName);
  // 4. 本地规则 itemRulesV1
  r = consider(rule);
  if (r) return sanitizeV1ActiveCategoryWrite(r);
  // 5. 宽泛词典
  r = consider(dictionary);
  if (r) return sanitizeV1ActiveCategoryWrite(r);
  // 6. OCR categoryKey（辅助 fallback）
  r = consider(ocrKey);
  if (r) return sanitizeV1ActiveCategoryWrite(r);
  // 7. 兜底
  return otherSeen ? 'other' : 'uncategorized';
}

/**
 * V1 新写入边界：仅允许七个消费类别 + uncategorized 系统状态落库。
 * 未知值降为 uncategorized（不静默映射到 other）。
 */
export function sanitizeV1ActiveCategoryWrite(category: ProductCategory): ProductCategory {
  if (isV1WritableCategory(category)) {
    return category;
  }
  return 'uncategorized';
}

/** @deprecated M1-A: legacy-compat list is empty; personal_care/pet_care are active. */
export function isV1LegacyCompatCategory(category: string | null | undefined): boolean {
  return (V1_LEGACY_COMPAT_PRODUCT_CATEGORIES as readonly string[]).includes(
    String(category || '')
  );
}
